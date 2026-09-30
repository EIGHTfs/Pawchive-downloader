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
  removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service, creator_id)
);
CREATE TABLE IF NOT EXISTS auto_sync_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  creators TEXT NOT NULL DEFAULT '[]',
  schedule TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

// 服务启动清理：上次运行中断的 ACTIVE 任务 → interrupted（防重启后残留 running 卡死——downloadTask 进程已死但 DB 状态未收）
try {
  db.prepare(`UPDATE tasks SET status = 'interrupted', error = '服务重启中断（任务未完成）' WHERE status IN ('queued', 'blocked', 'running', 'pause_requested', 'stop_requested')`).run();
  db.prepare(`UPDATE task_attempts SET status = 'interrupted' WHERE status = 'running'`).run();
  db.prepare(`ALTER TABLE creators_profile ADD COLUMN removed INTEGER NOT NULL DEFAULT 0`).run(); // 旧库迁移：软删标记列（已存在则 SQLite 报错忽略）
} catch { /* 表不存在/列已存在等初始化早期异常忽略 */ }

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
  // P2-5 补全（2026-09-29）：发布 task.status 事件——前端 realtime.tsx 读 event.data.progress（实时进度）+ event.data.status（状态翻转），
  // 与 task.progress（阶段详情）并行不冲突；内嵌当前 progress 快照（对齐原版 task_store.py:236-245 task.status 内嵌 progress）
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (row) {
    let progress = {};
    try { progress = JSON.parse(row.progress_json || '{}'); } catch { /* 容错 */ }
    const data = { status, progress, ...(error ? { error } : {}) };
    eventStore.publish({ event_type: 'task.status', task_id: id, data });
  }
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
/** 创作者编辑持久化（前端 CreatorsPage 开关/别名）：INSERT OR REPLACE（removed=0——添加/编辑即恢复软删作者） */
function updateCreatorProfile(service, creator_id, { alias = null, enabled = 1 } = {}) {
  db.prepare('INSERT INTO creators_profile (service, creator_id, alias, enabled, removed) VALUES (?,?,?,?,0) ON CONFLICT(service, creator_id) DO UPDATE SET alias=excluded.alias, enabled=excluded.enabled, removed=0')
    .run(service, creator_id, alias, enabled ? 1 : 0);
  return getCreatorProfile(service, creator_id);
}
function getCreatorProfile(service, creator_id) {
  const row = db.prepare('SELECT * FROM creators_profile WHERE service=? AND creator_id=?').get(service, creator_id);
  return row ? { service: row.service, creator_id: row.creator_id, alias: row.alias, enabled: !!row.enabled, removed: !!row.removed } : null;
}
function deleteCreatorProfile(service, creator_id) {
  db.prepare('UPDATE creators_profile SET removed = 1 WHERE service=? AND creator_id=?').run(service, creator_id); // 软删（removed 标记——列表排除——下载目录保留可恢复）
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
      if (/\[object /.test(String(obj.service || '')) || /\[object /.test(String(obj.userId || ''))) continue; // 异常标识（object 字符串化）——跳过不进列表（前端无法移除的条目）
      const avatars = (obj.avatars || []).filter(a => a.exists);
      const profile = getCreatorProfile(obj.service || '', obj.userId || '');
      if (profile && profile.removed) continue; // 软删作者（已移除）——列表排除（下载目录保留——不误删数据）
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
/** 聚合 cli 事件 → TaskProgress（原作者字段：queued/processed/completed/existing/failed_files + bytes/speed；2026-09-29 对齐：transferred 累计、speed 总速度、total/eta、active 完成清理） */
function progressReducer() {
  const p = { queued_files: 0, processed_files: 0, completed_files: 0, existing_files: 0, failed_files: 0, transferred_bytes: 0, total_bytes: null, speed_bps: 0, eta_seconds: null, active_creators: [], active_downloads: {}, waiting_retries: {} };
  const lastSizes = {}; // 每文件上次 size（transferred 增量累计基准——多文件并发不重复计数）
  const jobTotals = {}; // 每文件 totalSize（total_bytes 累计和——对齐原版 task_reporter total 累计——非 Math.max 单文件）
  const recompute = () => { // 重算总速度（活跃 job speed 之和）+ eta（(total-transferred)/speed）
    p.speed_bps = Object.values(p.active_downloads).reduce((s, a) => s + (typeof a.speed === 'number' ? a.speed : 0), 0);
    p.eta_seconds = (typeof p.total_bytes === 'number' && p.speed_bps > 0) ? Math.max(0, (p.total_bytes - p.transferred_bytes) / p.speed_bps) : null;
  };
  return {
    current: () => ({ ...p }),
    apply(ev) {
      const d = ev.data || {};
      switch (ev.type) {
        case 'job.progress': {
          const fn = d.filename || '';
          if (typeof d.size === 'number') { p.transferred_bytes += Math.max(0, d.size - (lastSizes[fn] || 0)); lastSizes[fn] = d.size; } // 增量累计（非 Math.max 单值）
          if (typeof d.totalSize === 'number') { jobTotals[fn] = d.totalSize; p.total_bytes = Object.values(jobTotals).reduce((s, t) => s + t, 0); } // total 累计和（对齐原版——非 max 单文件）
          p.active_downloads[fn] = { filename: fn, percent: d.percent, speed: d.speed, size: d.size, totalSize: d.totalSize, creator_key: d.creator || '' };
          recompute();
          break;
        }
        case 'job.queued': p.queued_files++; break; // 文件 job 入队（对齐原版 job_queued——累计入队数）
        case 'job.downloaded': p.completed_files++; p.processed_files++; delete lastSizes[d.filename || '']; delete p.active_downloads[d.filename || '']; recompute(); break;
        case 'job.existed': p.existing_files++; p.processed_files++; delete lastSizes[d.filename || '']; delete p.active_downloads[d.filename || '']; recompute(); break;
        case 'job.aborted': delete lastSizes[d.filename || '']; delete p.active_downloads[d.filename || '']; recompute(); break; // abort 中断（不计 failed——对齐原版 CancelledError）
        case 'job.failed': p.failed_files++; p.processed_files++; delete lastSizes[d.filename || '']; delete p.active_downloads[d.filename || '']; recompute(); break;
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

/** 任务 abort 注册表（taskId → AbortController——abortTask 触发真中断下载） */
const taskAborts = new Map();

/** 创建并执行下载任务（内嵌 cli.downloadAuthor；任务状态机 + 事件持久化）。
 * spec: { service, creator_id?, post_id?, concurrency? } 或 { url } */
async function downloadTask(taskId, spec, targetPath, { concurrency = 5, dryrun = false } = {}) {
  const controller = new AbortController(); // 任务级 abort（2026-09-29——stop/pause/删除真中断级联到 cli）
  taskAborts.set(taskId, controller);
  const abortCtl = { shouldAbort: () => controller.signal.aborted };
  const url = spec.url || `https://pawchive.pw/${spec.service}/user/${spec.creator_id}${spec.post_id ? `/post/${spec.post_id}` : ''}`;
  const prog = progressReducer();
  let lastProgressAt = 0; // P2-4（2026-09-29）：job.progress 500ms 刷屏——DB/SSE 事件 1s 节流合并（progress 状态本身每次更新——事件流降频）
  const onEvent = e => {
    prog.apply(e);
    const isProgressish = e.type === 'job.progress' || e.type.startsWith('job.') || e.type.startsWith('task.') || e.type === 'post.completed' || e.type === 'post.skipped';
    if (e.type !== 'job.progress' || Date.now() - lastProgressAt > 1000) { // 非 progress 实时；progress 1s 节流（防 500ms 刷屏）
      eventStore.publish({ event_type: e.type, task_id: taskId, data: { ...(e.data || {}), progress: prog.current() } }); // P2-5：事件内嵌 progress 快照——前端 realtime.tsx:567 读 event.data.progress 实时更新
      lastProgressAt = Date.now();
    }
    if (isProgressish) updateTaskProgress(taskId, prog.current());
  };
  updateTaskStatus(taskId, 'running');
  startAttempt(taskId, 1, spec, { concurrency });
  // P2-5（2026-09-29）：task.progress 事件内嵌 progress 快照——前端 realtime.tsx:567 读 event.data.progress 驱动 SSE 实时进度
  eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'started', progress: prog.current() } });
  try {
    const fetched = await cli.fetchPostsByUrl(url, targetPath); // 拉作者/帖子列表（分页缓存复用——必须传 targetPath：内部 indexFileFor 缓存索引 path.join(targetPath) 缺则 path undefined 崩）
    // P2-6（2026-09-29）：fetch 到数据后回填 presentation（任务标题）——前端 TasksPage 读 e.presentation?.title?.trim() 作标题、presentation?.creator_name 作副标题；缺则 show「帖子 #id」/「未知帖子」（对齐原版 TaskPresentationSnapshot created from Pawchive data）
    try {
      const metaName = fetched.meta && (fetched.meta.creatorName || fetched.meta.creator_name);
      const pName = metaName || (spec.service && spec.creator_id ? spec.creator_id : '');
      const firstPostTitle = fetched.meta && fetched.meta.mode === 'post' && fetched.posts && fetched.posts[0] ? fetched.posts[0].title : null;
      const pTitle = firstPostTitle || pName || spec.creator_id || spec.post_id || '';
      if (pName || pTitle) {
        db.prepare('UPDATE tasks SET presentation_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify({ target_key: `${spec.service || ''}/${spec.creator_id || ''}${spec.post_id ? `/post/${spec.post_id}` : ''}`, title: pTitle, creator_name: pName || null }), nowIso(), taskId);
      }
    } catch { /* presentation 回填失败不影响下载（任务仍正常执行——非关键路径） */ }
    const result = await cli.downloadAuthor(fetched.posts, fetched.meta, targetPath, { concurrency, dryrun, onEvent, abortCtl }); // abortCtl 级联（任务 stop/pause/删除真中断）
    const final = prog.current();
    updateTaskProgress(taskId, final);
    finishAttempt(taskId, 1, { result: { downloaded: result.downloaded, existed: result.existed, failed: result.failed } });
    // 终态不被覆盖（2026-09-29 对齐原版）：用户已 stop/pause → 保持用户状态（不冲掉成 completed）
    const cur = getTask(taskId);
    if (cur && (cur.status === 'stopped' || cur.status === 'paused')) {
      eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'stopped_by_user', summary: result, progress: prog.current() } });
    } else {
      updateTaskStatus(taskId, 'completed');
      eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'completed', summary: result, progress: prog.current() } });
    }
    return result;
  } catch (err) {
    if (controller.signal.aborted) { // 任务被 abort（stop/pause/删除）——中断态（不标 failed）
      finishAttempt(taskId, 1, { status: 'interrupted', error: '任务被中止' });
      updateTaskStatus(taskId, 'interrupted', { error: '任务被中止（用户操作）' });
      eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'interrupted', error: '任务被中止', progress: prog.current() } });
      return null;
    }
    const msg = String(err && err.message || err);
    finishAttempt(taskId, 1, { status: 'failed', error: msg });
    updateTaskStatus(taskId, 'failed', { error: msg });
    eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'failed', error: msg, progress: prog.current() } });
    throw err;
  } finally {
    taskAborts.delete(taskId); // 结束清理注册
  }
}
/** 中止任务下载（stop/pause/删除级联——真中断：abortCtl → cli downloadFile/streamOnce kill curl） */
function abortTask(taskId) { const c = taskAborts.get(taskId); if (c) c.abort(); }

// ---------- naming（模板映射：env 中枢 readPawchiveEnv → ktool naming 契约——统一读 env，不依赖 cli.CONFIG） ----------
const envCompat = require('./scripts/KToolBox-env-compat.js'); // env 翻译中枢（兼容层强制读——env 相关全走它）
function getNaming() {
  const c = envCompat.readPawchiveEnv(); // PAWCHIVE_* → 配置对象（attachmentsSubdir/indexFilename/revisionsSubdir/模板）
  return {
    default_output: c.dataRoot, resolved_default_output: c.dataRoot,
    naming: {
      creator_dirname_format: c.creatorDirFormat,
      post_dirname_format: c.postDirFormat,
      revision_dirname_format: '{revision_id}', // 无 revision 概念（默认）
      filename_format: c.filenameFormat, // 顶层 filename_format（前端 normalizeNaming 读此字段——缺失会导致 draft.filename_format undefined → invalidTemplate .trim 崩）
      post_structure: { attachments: c.attachmentsSubdir ? c.attachmentsSubdir : '.', content: c.indexFilename, external_links: 'html', file: '{id}_{}', revisions: c.revisionsSubdir },
      mix_posts: false, sequential_filename: true, sequential_filename_excludes: [], group_by_year: false, group_by_month: false,
      year_dirname_format: '{year}', month_dirname_format: '{year}-{month:02d}',
    },
    published_time: { mode: 'normalized', target_timezone: 'Asia/Shanghai', fallback_service_timezone: 'UTC', service_timezones: { fanbox: 'Asia/Tokyo', patreon: 'UTC' } }, // 对齐原版 PublishedTimePolicySnapshot（时区策略——前端命名页时区设置读这些字段）
    revision: '0',
  };
}
/** 更新 .env 文件（统一转发 env 中枢 writeEnv——cli 读 .env 即时生效） */
function updateEnvFile(key, value) {
  return envCompat.writeEnv(key, value, path.join(__dirname, '.env'));
}

// ---------- 创作者搜索（对齐原版 search_creator：fetchAllCreators 全量缓存 + 本地 matches 过滤：id/name 包含不区分大小写/service） ----------
async function searchCreators({ id = null, name = null, service = null } = {}, targetPath = '') {
  const all = await cli.fetchAllCreators(targetPath);
  if (!Array.isArray(all)) return [];
  const nameQ = name ? String(name).toLowerCase() : null;
  const out = [];
  for (const c of all) {
    if (id && String(c.id) !== String(id)) continue;
    if (nameQ && !String(c.name || '').toLowerCase().includes(nameQ)) continue;
    if (service && c.service !== service) continue;
    out.push({ service: c.service || '', creator_id: String(c.id || ''), name: c.name || '', updated: c.updated || null, favorited: c.favorited || 0 });
  }
  return out.slice(0, 100); // 搜索上限（避免超大列表）
}

// ---------- 自动同步（auto-sync：计划=作者列表+间隔 → 定时触发 sync 任务——自动按作者下载；复用 downloadTask） ----------
const planToIntervalMs = s => { const every = Number((s && s.every) || 24) || 24; const unit = (s && s.unit) || 'hours'; return every * (unit === 'minutes' ? 60 : unit === 'days' ? 86400 : 3600) * 1000; };
function getAutoSyncPlan(id) {
  const r = db.prepare(`SELECT * FROM auto_sync_plans WHERE id = ?`).get(id);
  if (!r) return null;
  const schedule = JSON.parse(r.schedule || '{}');
  if (!schedule.kind) schedule.kind = 'interval'; // P2-3（2026-09-29）：补 kind:'interval'——前端 normalizePlan 默认按 cron 解析错位（显示「0 3 * * *」而非 interval）
  return { id: r.id, name: r.name, enabled: !!r.enabled, creators: JSON.parse(r.creators || '[]'), schedule, next_run_at: r.next_run_at, created_at: r.created_at, updated_at: r.updated_at };
}
function createAutoSyncPlan({ id, name, enabled = true, creators = [], schedule = {} }) {
  const now = nowIso();
  db.prepare(`INSERT INTO auto_sync_plans (id, name, enabled, creators, schedule, next_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, name, enabled ? 1 : 0, JSON.stringify(creators || []), JSON.stringify(schedule || {}), new Date(Date.now() + planToIntervalMs(schedule)).toISOString(), now, now);
  return getAutoSyncPlan(id);
}
function listAutoSyncPlans() {
  return db.prepare(`SELECT * FROM auto_sync_plans ORDER BY created_at`).all().map(r => getAutoSyncPlan(r.id));
}
function deleteAutoSyncPlan(id) { db.prepare(`DELETE FROM auto_sync_plans WHERE id = ?`).run(id); }
function updateAutoSyncPlan(id, { enabled, creators, schedule, name } = {}) {
  const cur = getAutoSyncPlan(id); if (!cur) return null;
  const merged = { ...cur, ...(name !== undefined ? { name } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(creators !== undefined ? { creators } : {}), ...(schedule !== undefined ? { schedule } : {}) };
  db.prepare(`UPDATE auto_sync_plans SET name=?, enabled=?, creators=?, schedule=?, next_run_at=?, updated_at=? WHERE id=?`)
    .run(merged.name, merged.enabled ? 1 : 0, JSON.stringify(merged.creators || []), JSON.stringify(merged.schedule || {}), new Date(Date.now() + planToIntervalMs(merged.schedule)).toISOString(), nowIso(), id);
  return getAutoSyncPlan(id);
}
let autoSyncTimer = null;
/** 触发计划（立即运行/定时器共用）：每 creator 建一个 sync 任务（自动按作者下载） */
function triggerAutoSyncPlan(plan, targetPath, { concurrency = 5 } = {}) {
  for (const key of (plan && plan.creators) || []) {
    const [service, creator_id] = String(key).split(':');
    if (!service || !creator_id) continue;
    // 2026-09-29 触发查重（对齐原版 auto_sync 双重查重）：同 creator 已有 ACTIVE sync 任务 → 跳过不重复触发
    const dupActive = listTasks().some(t => { try { const s = JSON.parse(t.spec || t.spec_json || '{}'); return ACTIVE.has(t.status) && s.kind === 'sync' && s.service === service && s.creator_id === creator_id; } catch { return false; } });
    if (dupActive) continue;
    const taskId = `as-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    createTask({ id: taskId, spec: { kind: 'sync', service, creator_id, creators: [{ service, creator_id }], output: targetPath, save_creator_indices: false, offset: 0, keywords: [], keywords_exclude: [] } });
    downloadTask(taskId, { service, creator_id }, targetPath, { concurrency }).catch(err => console.error(`[auto-sync ${taskId}] ${err && err.message || err}`));
  }
}
/** 启动自动同步调度（服务启动调一次）：每分钟扫到期计划 → 触发 sync 任务 */
function startAutoSyncScheduler(targetPath, { concurrency = 5 } = {}) {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  const tick = async () => {
    const now = Date.now();
    for (const p of listAutoSyncPlans()) {
      if (!p.enabled || !p.next_run_at || new Date(p.next_run_at).getTime() > now) continue;
      triggerAutoSyncPlan(p, targetPath, { concurrency });
      updateAutoSyncPlan(p.id, {});
    }
  };
  tick();
  autoSyncTimer = setInterval(tick, 60000);
}

module.exports = { db, eventStore, EventStore, cli, TASK_STATUS, ACTIVE, TERMINAL, createTask, getTask, listTasks, updateTaskStatus, updateTaskProgress, startAttempt, finishAttempt, listAttempts, listCreators, updateCreatorProfile, getCreatorProfile, deleteCreatorProfile, downloadTask, getNaming, updateEnvFile, searchCreators, createAutoSyncPlan, listAutoSyncPlans, getAutoSyncPlan, deleteAutoSyncPlan, updateAutoSyncPlan, startAutoSyncScheduler, triggerAutoSyncPlan, abortTask, progressReducer, nowIso, CONFIG: cli.CONFIG };
