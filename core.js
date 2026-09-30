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
  last_checkpoint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  path TEXT NOT NULL,        -- 产物完整路径（任务本次真正落盘的文件——续传完成也算；.tmp/existed/复用不登记）
  size INTEGER NOT NULL,     -- 登记时文件大小（删除前校验未变——用户改过则跳过）
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_task ON task_artifacts (task_id);
`);

// 服务启动清理：上次运行中断的 ACTIVE 任务 → interrupted + 清 stale live progress（active_downloads/speed/eta 残留——对齐原版 tasks.md:35 _finalized_progress 清空；累计字段 queued/processed/completed/existing/failed/transferred/total 保留）
try {
  const rows = db.prepare(`SELECT id, progress_json FROM tasks WHERE status IN ('queued', 'blocked', 'running', 'pause_requested', 'stop_requested')`).all();
  for (const r of rows) {
    let pr = {};
    try { pr = JSON.parse(r.progress_json || '{}'); } catch { /* 容错 */ }
    // 只清活动态字段（保留累计统计——重启后进度数字不丢，只是不再显示正在下载的虚拟文件）
    pr.active_creators = []; pr.active_downloads = {}; pr.waiting_retries = {}; pr.speed_bps = 0; pr.eta_seconds = null;
    db.prepare(`UPDATE tasks SET status = 'interrupted', error = '服务重启中断（任务未完成）', progress_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(pr), nowIso(), r.id);
  }
  db.prepare(`UPDATE task_attempts SET status = 'interrupted' WHERE status = 'running'`).run();
} catch { /* 表不存在等初始化早期异常忽略 */ }
// 旧库迁移（2026-09-29 修复：每个 ALTER 独立 try——先前一个已存在抛错会吞掉后续迁移，blocked_by 从未加上）
try { db.prepare(`ALTER TABLE creators_profile ADD COLUMN removed INTEGER NOT NULL DEFAULT 0`).run(); } catch { /* 列已存在忽略 */ }
try { db.prepare(`ALTER TABLE tasks ADD COLUMN blocked_by TEXT`).run(); } catch { /* 列已存在忽略 */ }
try { db.prepare(`ALTER TABLE auto_sync_plans ADD COLUMN last_checkpoint TEXT`).run(); } catch { /* 列已存在忽略 */ }

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
// ---------- 任务产物登记（③ delete outputs 安全清理：只删本任务本次真正落盘、且未改动的文件；.tmp/existed/硬链接复用不登记） ----------
function addTaskArtifact(taskId, p, size) {
  if (!taskId || !p) return;
  try { db.prepare(`INSERT INTO task_artifacts (task_id, path, size, created_at) VALUES (?,?,?,?)`).run(taskId, String(p), Number(size) || 0, nowIso()); } catch { /* 登记失败不影响下载 */ }
}
function listTaskArtifacts(taskId) {
  return db.prepare(`SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY id`).all(taskId);
}
function removeTaskArtifacts(taskId) {
  db.prepare(`DELETE FROM task_artifacts WHERE task_id = ?`).run(taskId);
}
/** 预览可安全删除的产物（存在 + 大小未变——用户改过/已移动的跳过）：返回 [{path,size}]（供 cleanup-preview 展示——只删安全项） */
function previewTaskArtifacts(taskId) {
  const out = [];
  for (const a of listTaskArtifacts(taskId)) {
    try {
      const st = require('node:fs').statSync(a.path);
      if (st.isFile() && st.size === a.size) out.push({ path: a.path, size: a.size });
    } catch { /* 不存在/移动——跳过不删 */ }
  }
  return out;
}
/** 安全删除任务产物（delete_output=1 时调用）：只删预览通过（存在+未变）的文件；删除后清产物记录 */
function cleanupTaskArtifacts(taskId) {
  const removable = previewTaskArtifacts(taskId);
  let removed = 0, removedBytes = 0;
  for (const a of removable) {
    try {
      // 只删空目录链里该文件所在帖目录？——只删文件本身；空帖目录保留（可能含索引/其他）
      require('node:fs').unlinkSync(a.path);
      removed++; removedBytes += a.size;
    } catch { /* 删除失败跳过 */ }
  }
  removeTaskArtifacts(taskId);
  return { removable_files: removed, removable_bytes: removedBytes };
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
    blocked_by: row.blocked_by || null, // 2026-09-29 调度器：blocked 阻塞源任务 id
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
function updateTaskProgress(id, progress) {
  db.prepare('UPDATE tasks SET progress_json=?, updated_at=? WHERE id=?').run(JSON.stringify(progress), nowIso(), id);
}
function startAttempt(taskId, sequence = null, spec, config) {
  // sequence 缺省 = MAX+1（2026-09-30 卡 running bug 修复：固定 1 与旧 attempt 唯一约束冲突——对齐原版 task_store.py:337 start_attempt 自增）
  if (sequence == null) {
    const r = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM task_attempts WHERE task_id=?').get(taskId);
    sequence = r ? r.next : 1;
  }
  db.prepare('INSERT INTO task_attempts (task_id, sequence, status, spec_json, configuration_json, started_at) VALUES (?,?,?,?,?,?)')
    .run(taskId, sequence, 'running', JSON.stringify(spec), JSON.stringify(config || {}), nowIso());
  return sequence; // P0-1（2026-09-30）：返回实际 sequence——downloadTask 记录 curSeq，finishAttempt 用当前 attempt（不再硬编码 1 覆写旧记录）
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

// 事件中文消息映射（2026-09-30：前端事件流 fallback 读 t.data.message 显示；原版对各事件有专门翻译分支，我们补在服务端单点）
const EVENT_ZH = {
  'task.started': '任务开始',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'post.started': '帖子开始',
  'post.completed': '帖子完成',
  'post.skipped': '帖子跳过',
  'job.queued': '文件排队',
  'job.downloaded': '文件下载完成',
  'job.existed': '文件已存在',
  'job.failed': '文件下载失败',
  'job.aborted': '文件下载中断',
  'revision.completed': '修订版完成',
  'netdisk.downloaded': '网盘文件下载完成',
};
// task.progress phase → 中文（前端对 task.progress 事件无专门翻译分支——phase 英文会直接显示）
const PHASE_ZH = {
  started: '任务开始',
  completed: '任务完成',
  failed: '任务失败',
  interrupted: '任务中断',
  stopped_by_user: '任务已停止',
  stopped: '任务已停止',
  paused: '任务已暂停',
  resumed: '任务已恢复',
};

// ---------- 下载执行（内嵌 cli；onEvent → SQLite 事件 + TaskProgress 聚合，对齐原作者） ----------
/** 聚合 cli 事件 → TaskProgress（原作者字段：queued/processed/completed/existing/failed_files + bytes/speed；2026-09-29 对齐：transferred 累计、speed 总速度、total/eta、active 完成清理） */
function progressReducer() {
  const p = { queued_files: 0, processed_files: 0, completed_files: 0, existing_files: 0, failed_files: 0, transferred_bytes: 0, total_bytes: null, speed_bps: 0, eta_seconds: null, active_creators: [], active_downloads: {}, waiting_retries: {} };
  const lastSizes = {}; // 每文件上次 size（transferred 增量累计基准——多文件并发不重复计数）
  const jobTotals = {}; // 每文件 totalSize（total_bytes 累计和——对齐原版 task_reporter total 累计——非 Math.max 单文件）
  const speedHistory = []; // ⑤ 速度 5s 滚动窗口（2026-09-29 对齐原版 task_reporter.py:288-297 滑动 speed——文件切换不闪 0）
  let hadJobEvents = false; // 2026-09-29 修复 double-count：帖内走 job.* 事件后，post.completed（帖级汇总）不再叠加——否则 processed=2×（6 queued 计成 12）
  const recompute = () => { // 重算总速度（活跃 job speed 5s 滚动均值）+ eta（(total-transferred)/speed）
    const instant = Object.values(p.active_downloads).reduce((s, a) => s + (typeof a.speed === 'number' ? a.speed : 0), 0);
    const now = Date.now();
    speedHistory.push({ t: now, v: instant });
    while (speedHistory.length && now - speedHistory[0].t > 5000) speedHistory.shift(); // 只保留最近 5s 样本
    p.speed_bps = speedHistory.length ? speedHistory.reduce((s, x) => s + x.v, 0) / speedHistory.length : 0; // 5s 均值（平滑——单文件切换不归零）
    p.eta_seconds = (typeof p.total_bytes === 'number' && p.speed_bps > 0) ? Math.max(0, (p.total_bytes - p.transferred_bytes) / p.speed_bps) : null;
  };
  return {
    // 输出层映射（不改前端）：前端「文件」统计读 processed_files/queued_files 两个字段显示「N / M」。
    // 我们自定义语义（与 KToolBox 原版不同，2026-09-30 用户决策）：已处理 = 全部 - 失败——失败的文件不算已处理（processed 只计成功处理的 completed+existing），
    // 所以把 queued_files 字段值映射为「全部」（= processed + failed），前端无需改动即显示「已处理 / 全部」（如 81 / 83 = 已处理 81 / 全部 83）。
    // 注意：这里的 queued_files 不再是原版的「入队待下载数」语义——该语义前端仅此一处消费（文件统计/进度百分比分母），映射后一并成为「全部」语义。
    current: () => ({ ...p, queued_files: p.processed_files + p.failed_files }),
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
        case 'job.queued': p.queued_files++; hadJobEvents = true; break; // 文件 job 入队（对齐原版 job_queued——累计入队数）
        case 'download.retrying': { // P1-4（2026-09-30）：等待重试填充（对齐原版 task_reporter.py:165-194 填 waiting_retries）——job.* 终态 pop
          p.waiting_retries[d.filename || ''] = { creator_key: d.creator || '', filename: d.filename || '', retry_count: d.retry_count || 0, status_code: d.status_code ?? null };
          break;
        }
        case 'creator.started': { // P1-5（2026-09-30）：活动创作者 append（对齐原版 task_reporter.py:70-101 字符串 creator_key）
          if (d.creator && !p.active_creators.includes(d.creator)) p.active_creators.push(d.creator);
          break;
        }
        case 'creator.finished': { // 活动创作者 remove（对齐原版 append/remove 配对）
          if (d.creator) p.active_creators = p.active_creators.filter(c => c !== d.creator);
          break;
        }
        case 'job.downloaded': { // 2026-09-30 补漏：无 size 记录（html 记录 size null → job.progress totalSize null → 未计入 jobTotals）的文件下载完成——用实际 size 补进 total，transferred 不再超过 total（原 10.1MiB/9.83MiB 类显示）
          hadJobEvents = true; p.completed_files++; p.processed_files++;
          const fnDl = d.filename || '';
          delete lastSizes[fnDl]; delete p.active_downloads[fnDl]; delete p.waiting_retries[fnDl];
          if (jobTotals[fnDl] == null && typeof d.size === 'number') { jobTotals[fnDl] = d.size; p.total_bytes = Object.values(jobTotals).reduce((s, t) => s + t, 0); }
          recompute();
          break;
        }
        case 'job.existed': hadJobEvents = true; p.existing_files++; p.processed_files++; delete lastSizes[d.filename || '']; delete p.active_downloads[d.filename || '']; delete p.waiting_retries[d.filename || '']; recompute(); break;
        case 'job.aborted': hadJobEvents = true; delete lastSizes[d.filename || '']; delete p.active_downloads[d.filename || '']; delete p.waiting_retries[d.filename || '']; recompute(); break; // abort 中断（不计 failed——对齐原版 CancelledError）
        case 'job.failed': hadJobEvents = true; p.failed_files++; // 失败不算已处理（2026-09-30 用户语义：已处理 = 全部 - 失败——processed 只计成功处理的文件）
        delete lastSizes[d.filename || '']; delete p.active_downloads[d.filename || '']; delete p.waiting_retries[d.filename || '']; recompute(); break;
        case 'post.completed': // 帖级聚合——仅当该帖无 job.* 事件（全部已存在 todoJobs 空）时兜底累计（cli 带 hasJobs 标记）；有 job 事件则 job.* 已计，不叠加（2026-09-29 修复双计）
          if (!d.hasJobs) {
            p.completed_files += d.downloaded || 0;
            p.existing_files += d.existed || 0;
            p.failed_files += d.failed || 0;
            p.processed_files += (d.downloaded || 0) + (d.existed || 0); // 失败不算已处理（对齐用户语义：已处理=全部-失败）
          }
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
  // 兼容层输出补全（cli 下载引擎保持纯净——事件契约字段在 core 合成）：
  const fileTotals = {}; // filename → totalSize（job.progress 收集——download.finished 的 total_bytes 用）
  const dlStartedAt = {}; // filename → 开始时间戳（download.started 记——elapsed_seconds/average_speed_bps 计算）
  const creatorKey = spec.service && spec.creator_id ? `${spec.service}/${spec.creator_id}` : null; // 任务级 creator key（active_creators 面板）
  const onEvent = e => {
    prog.apply(e);
    // ③ delete outputs 产物登记（任务本次真正落盘才登记——rawStatus 真下载；existed/linked/copied 复用/跳过不登记；.tmp 登记发生于 rename 成正式文件后的 job.downloaded，天然排除）
    if (e.type === 'job.downloaded' && e.data && e.data.savePath && ['downloaded', 'downloaded_thumb'].includes(e.data.rawStatus)) {
      addTaskArtifact(taskId, e.data.savePath, e.data.size);
    }
    // 兼容层输出补全（前端事件契约字段——cli 事件只带原始字段，这里合成前端模板所需）：
    if (e.type === 'job.progress' && e.data && e.data.filename && typeof e.data.totalSize === 'number') fileTotals[e.data.filename] = e.data.totalSize; // 收 totalSize（download.finished 的 total_bytes）
    if (e.type === 'download.started' && e.data && e.data.filename) dlStartedAt[e.data.filename] = Date.now(); // 记下载开始（elapsed 计算）
    if ((e.type === 'download.started' || e.type === 'download.retrying' || e.type === 'download.finished') && e.data && e.data.filename && e.data.key === undefined) e.data.key = e.data.filename; // P0-3：key 供前端 compactActivityEvents 过滤（key 空→全过滤）
    if (e.type === 'download.finished' && e.data && e.data.filename) { // P1-6：download.finished 模板 4 字段（completed_bytes/total_bytes/elapsed_seconds/average_speed_bps）
      const fn = e.data.filename;
      const size = e.data.size ?? null;
      const t0 = dlStartedAt[fn];
      const elapsed = t0 ? (Date.now() - t0) / 1000 : null;
      e.data.completed_bytes = size;
      e.data.total_bytes = fileTotals[fn] ?? null;
      e.data.elapsed_seconds = elapsed;
      e.data.average_speed_bps = size != null && elapsed != null && elapsed > 0 ? size / elapsed : null;
      delete dlStartedAt[fn];
    }
    const isProgressish = e.type === 'job.progress' || e.type.startsWith('job.') || e.type.startsWith('task.') || e.type === 'post.completed' || e.type === 'post.skipped';
    if (e.type !== 'job.progress' || Date.now() - lastProgressAt > 1000) { // 非 progress 实时；progress 1s 节流（防 500ms 刷屏）
      // 2026-09-30：事件 data 统一补中文 message——前端事件流 fallback 读 t.data.message 显示（原版对各事件有专门翻译分支；我们补在服务端单点，无需改前端多处）
      const data = { ...(e.data || {}), progress: prog.current() };
      if (!data.message) data.message = EVENT_ZH[e.type] || null;
      eventStore.publish({ event_type: e.type, task_id: taskId, data }); // P2-5：事件内嵌 progress 快照——前端 realtime.tsx:567 读 event.data.progress 实时更新
      lastProgressAt = Date.now();
    }
    if (isProgressish) updateTaskProgress(taskId, prog.current());
  };
  updateTaskStatus(taskId, 'running');
  // P2-5（2026-09-29）：task.progress 事件内嵌 progress 快照——前端 realtime.tsx:567 读 event.data.progress 驱动 SSE 实时进度
  eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'started', progress: prog.current(), message: PHASE_ZH['started'] } }); // 中文 message（前端无 task.progress 翻译分支）
  try {
    const seq = startAttempt(taskId, null, spec, { concurrency }); // 2026-09-30 卡 running 修复：sequence=MAX+1 自增 + 移入 try——重跑与旧 attempt 唯一约束冲突时走 catch 标 failed，不再卡 running（原版 task_store.py:337 同语义）；P0-1：返回实际 seq 供 finishAttempt 用当前 attempt
    if (creatorKey) { // P1-5：任务级 creator.started（active_creators 面板 append——对齐原版 task_reporter creator_started 字符串 key；cli 保持纯净，事件在兼容层发）
      const ev = { type: 'creator.started', data: { creator: creatorKey } };
      prog.apply(ev);
      eventStore.publish({ event_type: ev.type, task_id: taskId, data: { ...ev.data, progress: prog.current() } });
    }
    const fetched = await cli.fetchPostsByUrl(url, targetPath, spec.syncLength ? { length: spec.syncLength } : {}); // 拉作者/帖子列表（分页缓存复用——必须传 targetPath：内部 indexFileFor 缓存索引 path.join(targetPath) 缺则 path undefined 崩）；syncLength=auto-sync 增量窗口（2026-09-29 ②checkpoint 增量——只拉最新 N 帖，零改 cli.js）
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
    finishAttempt(taskId, seq, { result: { downloaded: result.downloaded, existed: result.existed, failed: result.failed } });
    // 终态不被覆盖（2026-09-29 对齐原版）：用户已 stop/pause → 保持用户状态（不冲掉成 completed）
    const cur = getTask(taskId);
    if (cur && (cur.status === 'stopped' || cur.status === 'paused')) {
      eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'stopped_by_user', summary: result, progress: prog.current(), message: PHASE_ZH['stopped_by_user'] } });
    } else {
      updateTaskStatus(taskId, 'completed');
      eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'completed', summary: result, progress: prog.current(), message: PHASE_ZH['completed'] } });
      // 2026-09-29 ②checkpoint 增量：auto-sync 增量任务完成 → 从作者索引读最新帖 id 更新计划 checkpoint（下次只拉新帖窗口）
      if (spec.syncLength && spec.service && spec.creator_id) {
        try {
          const idxPath = path.join(targetPath, '.pawchive', `${spec.service}-${spec.creator_id}.index.json`);
          const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
          const latestId = idx.posts && idx.posts[0] ? String(idx.posts[0].id) : null;
          if (latestId) {
            for (const pl of listAutoSyncPlans()) {
              const creators = Array.isArray(pl.creators) ? pl.creators : [];
              if (creators.some(c => String(c).split(':')[1] === String(spec.creator_id))) updateAutoSyncCheckpoint(pl.id, latestId);
            }
          }
        } catch { /* 索引缺失/计划无匹配——跳过（不影响任务完成） */ }
      }
    }
    if (creatorKey) { // P1-5：任务结束发 creator.finished（active_creators 面板 remove——对齐原版 task_reporter creator_finished 字段；cli 纯净、事件在兼容层发）
      const stats = prog.current();
      const ev = { type: 'creator.finished', data: { creator: creatorKey, error: null, failure: null, fetched_posts: (fetched.posts || []).length, accepted_posts: (fetched.posts || []).length, queued_files: stats.queued_files, completed_files: stats.completed_files, existing_files: stats.existing_files, failed_files: stats.failed_files } };
      prog.apply(ev);
      eventStore.publish({ event_type: ev.type, task_id: taskId, data: { ...ev.data, progress: prog.current() } });
    }
    return result;
  } catch (err) {
    if (controller.signal.aborted) { // 任务被 abort（stop/pause/删除）——中断态（不标 failed）
      finishAttempt(taskId, seq, { status: 'interrupted', error: '任务被中止' });
      updateTaskStatus(taskId, 'interrupted', { error: '任务被中止（用户操作）' });
      eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'interrupted', error: '任务被中止', progress: prog.current(), message: PHASE_ZH['interrupted'] } });
      return null;
    }
    const msg = String(err && err.message || err);
    finishAttempt(taskId, seq, { status: 'failed', error: msg });
    updateTaskStatus(taskId, 'failed', { error: msg });
    eventStore.publish({ event_type: 'task.progress', task_id: taskId, data: { phase: 'failed', error: msg, progress: prog.current(), message: PHASE_ZH['failed'] } });
    throw err;
  } finally {
    taskAborts.delete(taskId); // 结束清理注册
    runningTasks.delete(taskId); // 调度器槽位释放（2026-09-29：任务结束立即让出全局并发位——后续 queued 任务可补位启动）
    scheduleTick(); // 任务结束→立即调度（补位下一个 queued，不空转等 60s tick）
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
  return { id: r.id, name: r.name, enabled: !!r.enabled, creators: JSON.parse(r.creators || '[]'), schedule, next_run_at: r.next_run_at, last_checkpoint: r.last_checkpoint || null, created_at: r.created_at, updated_at: r.updated_at };
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
/** 更新计划 checkpoint（增量窗口边界——上次同步已处理到的最新帖 id）；仅更新该字段不重算 next_run */
function updateAutoSyncCheckpoint(id, lastCheckpoint) {
  if (!id || lastCheckpoint == null) return;
  db.prepare(`UPDATE auto_sync_plans SET last_checkpoint = ?, updated_at = ? WHERE id = ?`).run(String(lastCheckpoint), nowIso(), id);
}
function updateAutoSyncPlan(id, { enabled, creators, schedule, name } = {}) {
  const cur = getAutoSyncPlan(id); if (!cur) return null;
  const merged = { ...cur, ...(name !== undefined ? { name } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(creators !== undefined ? { creators } : {}), ...(schedule !== undefined ? { schedule } : {}) };
  db.prepare(`UPDATE auto_sync_plans SET name=?, enabled=?, creators=?, schedule=?, next_run_at=?, updated_at=? WHERE id=?`)
    .run(merged.name, merged.enabled ? 1 : 0, JSON.stringify(merged.creators || []), JSON.stringify(merged.schedule || {}), new Date(Date.now() + planToIntervalMs(merged.schedule)).toISOString(), nowIso(), id);
  return getAutoSyncPlan(id);
}
let autoSyncTimer = null;
// ---------- 任务调度器（2026-09-29：任务排队 + 全局并发上限 + blocked 冲突——对齐原版 task_scheduler；cli 下载引擎零改动） ----------
const runningTasks = new Set(); // 正在执行的下载任务（全局并发槽位占用）
let schedulerTimer = null;
let schedulerMaxActive = 5;
/** 触发一次调度（创建任务/任务结束/控制操作后调用）：queued→启动（不超过全局上限）、blocked→阻塞源解除后转 queued */
function scheduleTick() {
  if (!schedulerTimer) return; // 调度器未启动（纯 CLI 模式无调度——任务仍可被显式 downloadTask 直接执行）
  const now = Date.now();
  // blocked → 阻塞源（blocked_by 指向任务）不再 ACTIVE → 转 queued
  for (const t of listTasks()) {
    if (t.status !== 'blocked' || !t.blocked_by) continue;
    const blocker = getTask(t.blocked_by);
    if (!blocker || !ACTIVE.has(blocker.status)) {
      db.prepare('UPDATE tasks SET status = ?, blocked_by = NULL, updated_at = ? WHERE id = ?').run('queued', nowIso(), t.id);
      eventStore.publish({ event_type: 'task.status', task_id: t.id, data: { status: 'queued', progress: JSON.parse((getTask(t.id) || {}).progress_json || '{}') } });
    }
  }
  // queued → 启动（全局并发上限内；防重复启动；2026-09-29 补：启动前再次检查同作者资源冲突——rerun/run 转 queued 也遵守 blocked 语义）
  for (const t of listTasks()) {
    if (t.status !== 'queued' || runningTasks.has(t.id)) continue;
    const spec = t.spec || {};
    // 同作者 ACTIVE 冲突（创建时检测过，rerun/run 转 queued 后再次检测——防绕过 blocked）
    if (spec.service && spec.creator_id) {
      const conflict = listTasks().find(o => o.id !== t.id && ACTIVE.has(o.status) && o.spec && o.spec.service === spec.service && String(o.spec.creator_id) === String(spec.creator_id));
      if (conflict) {
        db.prepare('UPDATE tasks SET status = ?, blocked_by = ?, updated_at = ? WHERE id = ?').run('blocked', conflict.id, nowIso(), t.id);
        eventStore.publish({ event_type: 'task.status', task_id: t.id, data: { status: 'blocked', progress: JSON.parse(t.progress_json || '{}') } });
        continue;
      }
    }
    if (runningTasks.size >= schedulerMaxActive) break;
    const targetPath = spec.output || '';
    if (!targetPath) { updateTaskStatus(t.id, 'failed', { error: 'output 缺失（无法确定下载目录）' }); continue; }
    const url = spec.post || (spec.service ? `https://pawchive.pw/${spec.service}/user/${spec.creator_id}${spec.post_id ? `/post/${spec.post_id}` : ''}` : '');
    if (!url) { updateTaskStatus(t.id, 'failed', { error: 'spec 无 post URL 且无 service/creator_id' }); continue; }
    runningTasks.add(t.id);
    updateTaskStatus(t.id, 'running');
    downloadTask(t.id, { ...spec, url }, targetPath, { concurrency: spec.concurrency || schedulerMaxActive, dryrun: !!spec.dryrun }) // P0-2（2026-09-30）：透传完整 spec（syncLength/offset/keywords/save_creator_indices/download_file 不再丢失——auto-sync 增量恢复；concurrency 优先 spec 配置）
      .catch(err => console.error(`[scheduler ${t.id}] 执行异常: ${err && err.message || err}`));
    void now;
  }
}
/** 启动任务调度器（服务启动调一次）：每分钟扫 queued/blocked → 按全局并发上限启动；maxActive = 全局并发上限（默认 5） */
function startTaskScheduler(targetPath, { maxActive = 5 } = {}) {
  schedulerMaxActive = Math.max(1, maxActive);
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => scheduleTick(), 60000);
  scheduleTick(); // 启动立即调度一次（已有 queued 任务不等 60s）
  void targetPath;
}
/** 触发一次计划（立即运行/定时器共用）：每 creator 建一个 sync 任务（自动按作者下载）——创建后入队（状态 queued，调度器启动）
 * checkpoint 增量窗口（2026-09-29）：有计划 last_checkpoint → 只拉最新增量窗口（默认 10 帖）——复用 cli fetchPostsByUrl 现成 offset/length，零改 cli.js；
 * 无 checkpoint（首次）→ 全量；同步完成后 updateAutoSyncCheckpoint 记最新帖 id。 */
const AUTO_SYNC_INCREMENT_WINDOW = 10; // 增量窗口：每次计划同步只拉最新 N 帖（作者持续发帖时逐次推进；全量仅在首次/checkpoint 失效时）
function triggerAutoSyncPlan(plan, targetPath, { concurrency = 5 } = {}) {
  for (const key of (plan && plan.creators) || []) {
    const [service, creator_id] = String(key).split(':');
    if (!service || !creator_id) continue;
    // 2026-09-29 触发查重（对齐原版 auto_sync 双重查重）：同 creator 已有 ACTIVE sync 任务 → 跳过不重复触发
    const dupActive = listTasks().some(t => { try { const s = JSON.parse(t.spec || t.spec_json || '{}'); return ACTIVE.has(t.status) && s.kind === 'sync' && s.service === service && s.creator_id === creator_id; } catch { return false; } });
    if (dupActive) continue;
    const taskId = `as-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const syncLength = plan.last_checkpoint ? AUTO_SYNC_INCREMENT_WINDOW : undefined; // 有 checkpoint → 增量窗口；无 → 全量
    createTask({ id: taskId, spec: { kind: 'sync', service, creator_id, creators: [{ service, creator_id }], output: targetPath, save_creator_indices: false, offset: 0, syncLength, keywords: [], keywords_exclude: [] } });
    // 2026-09-29 调度器：创建后入队（queued）由调度器按全局并发上限启动——不再立即 downloadTask（多计划同时到期不超并发）
    scheduleTick();
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

module.exports = { db, eventStore, EventStore, cli, TASK_STATUS, ACTIVE, TERMINAL, createTask, getTask, listTasks, updateTaskStatus, updateTaskProgress, startAttempt, finishAttempt, listAttempts, listCreators, updateCreatorProfile, getCreatorProfile, deleteCreatorProfile, downloadTask, getNaming, updateEnvFile, searchCreators, createAutoSyncPlan, listAutoSyncPlans, getAutoSyncPlan, deleteAutoSyncPlan, updateAutoSyncPlan, updateAutoSyncCheckpoint, startAutoSyncScheduler, startTaskScheduler, scheduleTick, triggerAutoSyncPlan, abortTask, progressReducer, nowIso, addTaskArtifact, listTaskArtifacts, removeTaskArtifacts, previewTaskArtifacts, cleanupTaskArtifacts, CONFIG: cli.CONFIG };
