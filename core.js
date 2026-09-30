#!/usr/bin/env node
/**
 * core.js —— 业务内核（协议无关，兼容层复用）
 *
 * 对齐 KToolBox 原作者 WebUI 后端存储/事件/任务模型：
 * - SQLite（node:sqlite 内置，Node 22.5+）——tasks/task_attempts/task_events 表（同原作者 database.py 结构）+ WAL
 * - EventStore：publish（持久化 + 唤醒 SSE 等待者）/ wait_for_events（after 增量）——对齐 WebUIEventStore
 * - 下载执行：内嵌 cli.js（downloadAuthor/downloadOnePost + onEvent 回调 → 写事件）
 *
 * 零依赖（node:sqlite 内置）。协议适配器（adapters/*.js）负责请求/响应翻译，不承载业务。
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const cli = require('./cli.js');

// ---------- SQLite（对齐原作者 database.py 表结构） ----------
const DB_PATH = process.env.PAWCHIVE_WEB_DB || path.join(__dirname, 'webui.db');
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  presentation_json TEXT,
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  progress_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  failure_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  failure_json TEXT,
  result_json TEXT,
  UNIQUE(task_id, sequence)
);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  resource TEXT,
  resource_id TEXT,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS creators_profile (
  service TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  alias TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (service, creator_id)
);
`);

const nowIso = () => new Date().toISOString();

// ---------- 事件存储（对齐 WebUIEventStore：persist + Condition 唤醒 SSE） ----------
class EventStore {
  constructor() {
    this._waiters = new Set();
    this._generation = 0;
  }
  /** 发布事件：写库 + 唤醒 SSE 等待者。返回 TaskEvent 记录 */
  publish({ event_type, data, task_id = null, resource = null, resource_id = null }) {
    const created_at = nowIso();
    const r = db.prepare(
      'INSERT INTO task_events (task_id, event_type, resource, resource_id, data_json, created_at) VALUES (?,?,?,?,?,?)'
    ).run(task_id, event_type, resource, resource_id, JSON.stringify(data || {}), created_at);
    const id = Number(r.lastInsertRowid);
    for (const w of this._waiters) w(); // 唤醒 SSE 连接
    return this.get(id);
  }
  get(id) {
    const row = db.prepare('SELECT * FROM task_events WHERE id=?').get(id);
    return row ? this._toEvent(row) : null;
  }
  latest_id() {
    const row = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM task_events').get();
    return Number(row.m);
  }
  /** 事件列表（task_id 过滤可选；after 增量；limit 上限） */
  events({ task_id = null, after = 0, limit = 200 } = {}) {
    if (task_id) {
      return db.prepare('SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id LIMIT ?')
        .all(task_id, after, limit).map(r => this._toEvent(r));
    }
    return db.prepare('SELECT * FROM task_events WHERE id>? ORDER BY id LIMIT ?')
      .all(after, limit).map(r => this._toEvent(r));
  }
  /** SSE 等待：after 之后的新事件；超时返回 []（无阻塞轮询，Condition 唤醒加速） */
  wait_for_events(after, timeoutMs = 15000) {
    return new Promise(resolve => {
      const gen = ++this._generation;
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; cleanup(); resolve([]); } }, timeoutMs);
      const check = () => {
        const rows = db.prepare('SELECT * FROM task_events WHERE id>? ORDER BY id LIMIT 200').all(after);
        if (rows.length) { done = true; cleanup(); resolve(rows.map(r => this._toEvent(r))); return; }
        if (done) { cleanup(); resolve([]); }
      };
      const waiter = () => { if (!done) check(); };
      const cleanup = () => { clearTimeout(timer); this._waiters.delete(waiter); };
      this._waiters.add(waiter);
      check(); // 先查一次（有 after 的历史立即返回）
    });
  }
  _toEvent(row) {
    return { id: row.id, task_id: row.task_id, event_type: row.event_type, resource: row.resource, resource_id: row.resource_id, data: JSON.parse(row.data_json || '{}'), created_at: row.created_at };
  }
}

// ---------- 任务模型（对齐原作者 9 态状态机 + attempts） ----------
const TASK_STATUS = ['queued', 'blocked', 'running', 'pause_requested', 'paused', 'stop_requested', 'stopped', 'completed', 'failed', 'interrupted'];
const ACTIVE = new Set(['queued', 'blocked', 'running', 'pause_requested', 'stop_requested']);
const TERMINAL = new Set(['paused', 'stopped', 'completed', 'failed', 'interrupted']);

function createTask({ id, kind = 'download', spec, position = 0 }) {
  const now = nowIso();
  db.prepare('INSERT INTO tasks (id, kind, status, spec_json, presentation_json, position, revision, progress_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, kind, 'queued', JSON.stringify(spec), null, position, 1, '{}', now, now);
  return getTask(id);
}
function getTask(id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  return row ? _toTask(row) : null;
}
function listTasks({ status = null, limit = 200 } = {}) {
  if (status) return db.prepare('SELECT * FROM tasks WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, limit).map(_toTask);
  return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit).map(_toTask);
}
function updateTaskStatus(id, status, { error = null, failure_json = null } = {}) {
  db.prepare('UPDATE tasks SET status=?, error=?, failure_json=?, updated_at=? WHERE id=?')
    .run(status, error, failure_json, nowIso(), id);
  return getTask(id);
}
function _toTask(row) {
  return {
    id: row.id, kind: row.kind, status: row.status,
    spec: JSON.parse(row.spec_json || '{}'), presentation: row.presentation_json ? JSON.parse(row.presentation_json) : null,
    position: row.position, revision: row.revision,
    progress: JSON.parse(row.progress_json || '{}'),
    error: row.error, failure: row.failure_json ? JSON.parse(row.failure_json) : null,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
function updateTaskProgress(id, progress) {
  db.prepare('UPDATE tasks SET progress_json=?, updated_at=? WHERE id=?').run(JSON.stringify(progress), nowIso(), id);
}
function startAttempt(taskId, sequence, spec, config) {
  db.prepare('INSERT INTO task_attempts (task_id, sequence, status, spec_json, configuration_json, started_at) VALUES (?,?,?,?,?,?)')
    .run(taskId, sequence, 'running', JSON.stringify(spec), JSON.stringify(config || {}), nowIso());
}
function finishAttempt(taskId, sequence, { status = 'completed', error = null, result = null } = {}) {
  db.prepare('UPDATE task_attempts SET status=?, error=?, result_json=?, finished_at=? WHERE task_id=? AND sequence=?')
    .run(status, error, result ? JSON.stringify(result) : null, nowIso(), taskId, sequence);
}
function listAttempts(taskId) {
  return db.prepare('SELECT * FROM task_attempts WHERE task_id=? ORDER BY sequence').all(taskId).map(r => ({
    id: r.id, sequence: r.sequence, status: r.status, spec: JSON.parse(r.spec_json || '{}'),
    started_at: r.started_at, finished_at: r.finished_at, error: r.error, result: r.result_json ? JSON.parse(r.result_json) : null,
  }));
}

// ---------- 创作者浏览（读 pawchive-index 双级索引；业务内核） ----------
/** 创作者编辑持久化（前端 CreatorsPage 开关/别名）：INSERT OR REPLACE */
function updateCreatorProfile(service, creator_id, { alias = null, enabled = 1 } = {}) {
  db.prepare('INSERT INTO creators_profile (service, creator_id, alias, enabled) VALUES (?,?,?,?) ON CONFLICT(service, creator_id) DO UPDATE SET alias=excluded.alias, enabled=excluded.enabled')
    .run(service, creator_id, alias, enabled ? 1 : 0);
  return getCreatorProfile(service, creator_id);
}
function getCreatorProfile(service, creator_id) {
  const row = db.prepare('SELECT * FROM creators_profile WHERE service=? AND creator_id=?').get(service, creator_id);
  return row ? { service: row.service, creator_id: row.creator_id, alias: row.alias, enabled: !!row.enabled } : null;
}
function deleteCreatorProfile(service, creator_id) {
  db.prepare('DELETE FROM creators_profile WHERE service=? AND creator_id=?').run(service, creator_id);
}
/** 索引列表合并编辑记录（alias 显示名 + enabled） */
function listCreators(targetPath) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(targetPath, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const idx = path.join(targetPath, ent.name, cli.CONFIG.indexFilename);
    if (!fs.existsSync(idx)) continue;
    try {
      const html = fs.readFileSync(idx, 'utf8');
      const m = html.match(/<script id="pawchive-index"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) continue;
      const obj = JSON.parse(m[1]);
      if (!obj || obj.type !== 'creator') continue;
      const avatars = (obj.avatars || []).filter(a => a.exists);
      const profile = getCreatorProfile(obj.service || '', obj.userId || '');
      let avatar = null;
      if (avatars[0]) { const avatarFile = path.join(targetPath, ent.name, avatars[0].rel); if (fs.existsSync(avatarFile)) avatar = avatars[0].rel; } // avatar_url 仅当文件真实存在（防 404 图）
      out.push({
        service: obj.service || '', creator_id: obj.userId || '', name: profile && profile.alias ? profile.alias : (obj.creatorName || ent.name),
        dir: ent.name, postCount: obj.postCount || 0,
        enabled: profile ? profile.enabled : true,
        avatar,
      });
    } catch { /* 解析失败跳过 */ }
  }
  return out;
}

// ---------- 事件存储单例（SSE 共享订阅） ----------
const eventStore = new EventStore();

// ---------- 下载执行（内嵌 cli；onEvent → SQLite 事件 + TaskProgress 聚合，对齐原作者） ----------
/** 聚合 cli 事件 → TaskProgress（原作者字段：queued/processed/completed/existing/failed_files + bytes/speed） */
function progressReducer() {
  const p = { queued_files: 0, processed_files: 0, completed_files: 0, existing_files: 0, failed_files: 0, transferred_bytes: 0, total_bytes: null, speed_bps: 0, eta_seconds: null, active_creators: [], active_downloads: {}, waiting_retries: {} };
  return {
    current: () => ({ ...p }),
    apply(ev) {
      const d = ev.data || {};
      switch (ev.type) {
        case 'job.progress':
          if (typeof d.size === 'number') p.transferred_bytes = Math.max(p.transferred_bytes, d.size);
          if (typeof d.speed === 'number') p.speed_bps = d.speed;
          if (typeof d.percent === 'number') p.active_downloads[d.filename || ''] = { filename: d.filename, percent: d.percent, speed: d.speed, size: d.size };
          break;
        case 'job.downloaded': p.completed_files++; p.processed_files++; break;
        case 'job.existed': p.existing_files++; p.processed_files++; break;
        case 'job.failed': p.failed_files++; p.processed_files++; break;
        case 'post.completed': // 帖级聚合（已存在帖 todoJobs 空时无 job.* 事件，从此兜底）
          p.completed_files += d.downloaded || 0;
          p.existing_files += d.existed || 0;
          p.failed_files += d.failed || 0;
          p.processed_files += (d.downloaded || 0) + (d.existed || 0) + (d.failed || 0);
          break;
      }
    },
  };
}

/** 创建并执行下载任务（内嵌 cli.downloadAuthor；任务状态机 + 事件持久化）。
 * spec: { service, creator_id?, post_id?, postInterval?, concurrency? } 或 { url } */
async function downloadTask(taskId, spec, targetPath, { postInterval = 5, concurrency = 5, dryrun = false } = {}) {
  const url = spec.url || `https://pawchive.pw/${spec.service}/user/${spec.creator_id}${spec.post_id ? `/post/${spec.post_id}` : ''}`;
  const prog = progressReducer();
  const onEvent = e => {
    prog.apply(e);
    eventStore.publish({ event_type: e.type, task_id: taskId, data: e.data || {} });
    if (e.type === 'job.progress' || e.type.startsWith('job.') || e.type.startsWith('task.') || e.type === 'post.completed' || e.type === 'post.skipped') {
      updateTaskProgress(taskId, prog.current());
    }
  };
  updateTaskStatus(taskId, 'running');
  startAttempt(taskId, 1, spec, { concurrency, postInterval });
  eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'started' } });
  try {
    const fetched = await cli.fetchPostsByUrl(url); // 拉作者/帖子列表（分页缓存复用）
    const result = await cli.downloadAuthor(fetched.posts, fetched.meta, targetPath, { concurrency, postInterval, dryrun, onEvent });
    const final = prog.current();
    updateTaskProgress(taskId, final);
    finishAttempt(taskId, 1, { result: { downloaded: result.downloaded, existed: result.existed, failed: result.failed } });
    updateTaskStatus(taskId, result.failed ? 'completed' : 'completed');
    eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'completed', summary: result } });
    return result;
  } catch (err) {
    const msg = String(err && err.message || err);
    finishAttempt(taskId, 1, { status: 'failed', error: msg });
    updateTaskStatus(taskId, 'failed', { error: msg });
    eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'failed', error: msg } });
    throw err;
  }
}

// ---------- naming（模板映射：PAWCHIVE_*_FORMAT ↔ ktool naming 契约） ----------
function getNaming() {
  return {
    default_output: cli.CONFIG.dataRoot, resolved_default_output: cli.CONFIG.dataRoot,
    naming: {
      creator_dirname_format: cli.CONFIG.creatorDirFormat,
      post_dirname_format: cli.CONFIG.postDirFormat,
      revision_dirname_format: '{revision_id}', // 无 revision 概念（默认）
      filename_format: cli.CONFIG.fileFormat, // 顶层 filename_format（前端 normalizeNaming 读此字段——缺失会导致 draft.filename_format undefined → invalidTemplate .trim 崩）
      post_structure: { attachments: cli.CONFIG.attachmentsSubdir || 'attachments', content: 'content.txt', external_links: 'external_links.txt', file: '{id}_{}', revisions: 'revisions' },
      mix_posts: false, sequential_filename: true, sequential_filename_excludes: [], group_by_year: false, group_by_month: false,
      year_dirname_format: '{year}', month_dirname_format: '{year}-{month:02d}',
    },
    published_time: {}, revision: '0',
  };
}
/** 更新 .env 文件（KEY=VALUE 替换/追加——cli 读 .env 即时生效） */
function updateEnvFile(key, value) {
  const envPath = path.join(__dirname, '.env');
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { /* 无 .env 则新建 */ }
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, 'm').test(text)) text = text.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  else text += (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
  fs.writeFileSync(envPath, text, 'utf8');
}

module.exports = { db, eventStore, EventStore, cli, TASK_STATUS, ACTIVE, TERMINAL, createTask, getTask, listTasks, updateTaskStatus, updateTaskProgress, startAttempt, finishAttempt, listAttempts, listCreators, updateCreatorProfile, getCreatorProfile, deleteCreatorProfile, downloadTask, getNaming, updateEnvFile, nowIso, CONFIG: cli.CONFIG };
