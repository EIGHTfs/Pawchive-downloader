#!/usr/bin/env node
/**
 * adapters/KToolBox-webui.js —— KToolBox 契约适配器（协议翻译层，无业务）
 *
 * 收窄范围（设计文档第 6/7 节）：
 * ✅ session 放行已登录 / creators（含 avatar + 编辑 PUT/DELETE）/ tasks / events(SSE) / filesystem / project 最小化
 * ⚠️ naming/conversions/legacy 空对齐（后续）
 * ❌ mcp（删除）；naming/config-schema/dotenv/posts 代理待续
 * 契约源：docs/.probe-ktoolbox/webui/openapi.yaml（响应结构）+ src/lib/api.ts（前端调用面）
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

/** 从 URL 匹配路径参数：/api/v1/creators/{service}/{id}/avatar */
function matchPath(pathname, pattern) {
  const segs = pathname.split('/').filter(Boolean);
  const ps = pattern.split('/').filter(Boolean);
  if (segs.length !== ps.length) return null;
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    const m = /^\{([a-z_]+)\}$/.exec(ps[i]);
    if (m) params[m[1]] = decodeURIComponent(segs[i]);
    else if (ps[i] !== segs[i]) return null;
  }
  return params;
}

const TARGET_PATH = process.env.PAWCHIVE_DATA_ROOT || '';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}

/** 前端 TaskRecord 结构（types.ts）：id/kind/status/spec/presentation/position/revision/progress/error/failure/blocked_by/created_at/updated_at */
function taskRecord(t) {
  return {
    id: t.id, kind: t.kind || 'download', status: t.status,
    spec: t.spec || {}, presentation: t.presentation || null,
    automatic_origin: null, position: t.position || 0, revision: t.revision || 1,
    progress: t.progress || {}, error: t.error || null, failure: null, blocked_by: null,
    created_at: t.created_at, updated_at: t.updated_at,
  };
}

/** SSE 流（对齐原作者 task_routes.event_stream：Last-Event-ID/after cursor + retry + wait 循环 + heartbeat） */
function sseStream(req, res, core) {
  const afterQ = parseInt(new URL(req.url, 'http://x').searchParams.get('after') || '', 10);
  const lastEventId = req.headers['last-event-id'];
  let cursor;
  if (lastEventId != null) cursor = Math.max(Number.isFinite(afterQ) ? afterQ : 0, parseInt(lastEventId, 10) || 0);
  else if (Number.isFinite(afterQ)) cursor = afterQ;
  else cursor = core.eventStore.latest_id();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  res.write('retry: 3000\n\n');
  const pump = async () => {
    if (res.destroyed) return;
    const records = await core.eventStore.wait_for_events(cursor, 15000);
    if (records.length) {
      for (const r of records) { cursor = r.id; res.write(`id: ${r.id}\nevent: ${r.event_type}\ndata: ${JSON.stringify(r)}\n\n`); }
    } else {
      res.write(`event: heartbeat\ndata: {"timestamp":"${new Date().toISOString()}"}\n\n`);
    }
  };
  const loop = async () => { while (!res.destroyed) { try { await pump(); } catch { return; } } };
  loop();
  req.on('close', () => res.destroy());
}

async function handle(method, pathname, url, req, res, core) {
  // ---------- 前端错误上报（AI 无视觉感知浏览器错误：前端捕获 → 本端点 → .client-errors.jsonl → AI tail 读） ----------
  if (pathname === '/api/v1/client-error' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const entry = { ...body, receivedAt: new Date().toISOString(), ip: req.socket.remoteAddress || '' };
    const logPath = path.join(__dirname, '..', '.client-errors.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
    console.error('[client-error]', entry.type || 'unknown', '|', entry.message || '', entry.source ? `@${entry.source}${entry.lineno != null ? `:${entry.lineno}:${entry.colno}` : ''}` : '');
    return json(res, 200, { ok: true });
  }
  // ---------- session（放行已登录：无认证） ----------
  if (pathname === '/api/v1/session' && method === 'GET') {
    const now = new Date().toISOString();
    return json(res, 200, { authenticated: true, username: 'pawchive', csrf_token: 'dev-noauth', created_at: now, last_seen_at: now });
  }
  if (pathname === '/api/v1/session/login' && method === 'POST') {
    await readBody(req).catch(() => ({})); // 接受任意凭据，直接已登录
    const now = new Date().toISOString();
    return json(res, 200, { authenticated: true, username: 'pawchive', csrf_token: 'dev-noauth', created_at: now, last_seen_at: now });
  }
  if (pathname === '/api/v1/session/logout' && method === 'POST') return json(res, 200, {});

  // ---------- 杂项 ----------
  if (pathname === '/api/v1/health') return json(res, 200, { status: 'ok' });
  if (pathname === '/api/v1/about') return json(res, 200, {
    name: 'Pawchive-downloader WebUI 兼容层', version: '1.0.2', description: 'KToolBox WebUI 契约兼容实现（协议切换兼容层）',
    license: 'MIT', authors: ['Pawchive-downloader'], python_version: `Node.js ${process.version}`,
    urls: { documentation: '', repository: '', issues: '' }, // 空字符串前端 filter 掉
  });
  if (pathname === '/api/v1/site-version') return json(res, 200, { version: '1.0.2' });
  if (pathname === '/api/v1/startup-notices') return json(res, 200, []);
  if (pathname === '/api/v1/project') {
    return json(res, 200, {
      name: 'pawchive', path: TARGET_PATH, content: '', revision: '0',
      resolved_default_output: TARGET_PATH, // 前端读此字段作创建任务默认输出（缺失会 fallback "downloads"）
      // ProjectSummaryResponse 字段（openapi GET /project 响应 schema——契约校验）
      root: TARGET_PATH, project_config: {}, default_output: TARGET_PATH, dotenv_files: [], version: '1.0.2', published_target_timezone: '',
      configuration: { schema_version: 5, default_output: TARGET_PATH, creators: [], blockers: [], automatic_sync: [], naming: { creator_dirname_format: core.CONFIG.creatorDirFormat, post_dirname_format: core.CONFIG.postDirFormat, filename_format: core.CONFIG.fileFormat } },
    });
  }

  // ---------- creators ----------
  if (pathname === '/api/v1/creators' && method === 'GET') {
    const creators = core.listCreators(TARGET_PATH).map(c => ({
      service: c.service, creator_id: c.creator_id, name: c.name, enabled: c.enabled !== false,
      avatar_url: c.avatar ? `/api/v1/creators/${c.service}/${c.creator_id}/avatar` : null,
    }));
    return json(res, 200, creators);
  }
  {
    const p = matchPath(pathname, '/api/v1/creators/{service}/{creator_id}/avatar');
    if (p && method === 'GET') {
      const creators = core.listCreators(TARGET_PATH);
      const c = creators.find(x => x.service === p.service && x.creator_id === p.creator_id);
      if (c && c.avatar) {
        const file = path.join(TARGET_PATH, c.dir, c.avatar);
        if (fs.existsSync(file)) {
          const ext = path.extname(file);
          const ct = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.img': 'application/octet-stream' }[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
          return res.end(fs.readFileSync(file));
        }
      }
      return json(res, 404, { detail: 'avatar not found' });
    }
  }
  {
    const p = matchPath(pathname, '/api/v1/creators/{service}/{creator_id}');
    if (p) {
      if (method === 'PUT') { // 编辑：别名/启用开关（SQLite 持久化）
        const body = await readBody(req).catch(() => ({}));
        const profile = core.updateCreatorProfile(p.service, p.creator_id, { alias: body.alias ?? null, enabled: body.enabled !== false });
        return json(res, 200, { service: p.service, creator_id: p.creator_id, alias: profile.alias, enabled: profile.enabled });
      }
      if (method === 'DELETE') {
        core.deleteCreatorProfile(p.service, p.creator_id);
        return json(res, 200, { ok: true });
      }
    }
  }

  // ---------- config（schema 8 字段 + dotenv 读 .env——设计已确认） ----------
  if (pathname === '/api/v1/config/schema' && method === 'GET') {
    const C = core.CONFIG;
    const env = process.env;
    const field = (path_, env_name, section, label, description, json_schema, value) => ({
      path: path_, env_name, section, label, description, json_schema,
      default: json_schema.default ?? null, value: value ?? null,
      is_set: value !== undefined && value !== null && value !== '',
      secret: false, source: 'dotenv', apply_mode: 'next_task',
    });
    const fields = [
      field('naming.creator_dirname_format', 'PAWCHIVE_CREATOR_DIR_FORMAT', 'naming', '创作者目录模板', '{creator_name}/{creator_id}/{service}', { type: 'string' }, C.creatorDirFormat),
      field('naming.post_dirname_format', 'PAWCHIVE_POST_DIR_FORMAT', 'naming', '帖子目录模板', '{title}/{post_id}/{service}/{creator_id}/{published}/{added}', { type: 'string' }, C.postDirFormat),
      field('naming.filename_format', 'PAWCHIVE_FILENAME_FORMAT', 'naming', '文件名模板', '{} = 原文件名', { type: 'string' }, C.fileFormat),
      field('job.concurrency', 'PAWCHIVE_CONCURRENCY', 'job', '并行下载并发', 'worker 池式并发（1-16）', { type: 'integer', minimum: 1, maximum: 16 }, env.PAWCHIVE_CONCURRENCY || 5),
      field('job.download_drive', 'PAWCHIVE_DOWNLOAD_DRIVE', 'job', '下载正文网盘链接', 'Google Drive（provider 可扩展）', { type: 'boolean' }, env.PAWCHIVE_DOWNLOAD_DRIVE !== '0'),
      field('job.attachments_subdir', 'PAWCHIVE_ATTACHMENTS_SUBDIR', 'job', '附件子目录', '空=帖根目录；设 attachments 等', { type: 'string' }, C.attachmentsSubdir),
      field('downloader.tps', 'PAWCHIVE_TPS', 'downloader', '每秒新建连接上限', 'file host 反爬要求 ≤1', { type: 'number', minimum: 0.1, maximum: 10 }, env.PAWCHIVE_TPS || 1),
      field('downloader.thumb_base', 'PAWCHIVE_THUMB_BASE', 'downloader', '缩略图回退 base', '原图 404 时回退', { type: 'string' }, C.thumbBase),
    ];
    return json(res, 200, { locale: 'zh-CN', sections: { naming: '命名模板', job: '下载', downloader: '下载参数' }, fields });
  }
  // config/dotenv/{name}：dotenv=我们 .env（读全文/写 values）；production 无（空文档）
  {
    const p = matchPath(pathname, '/api/v1/config/dotenv/{name}');
    if (p) {
      const envPath = path.join(__dirname, '..', '.env');
      const read = () => { let c = ''; try { c = fs.readFileSync(envPath, 'utf8'); } catch { /* 无 .env */ } return c; };
      if (method === 'GET') {
        const content = p.name === 'production' ? '' : read();
        return json(res, 200, { name: p.name, path: p.name === 'production' ? '' : envPath, content, revision: String(content.length) });
      }
      if (method === 'PATCH') {
        if (p.name === 'production') return json(res, 200, { name: 'production', path: '', content: '', revision: '0' });
        const body = await readBody(req).catch(() => ({}));
        for (const [k, v] of Object.entries(body.values || {})) {
          if (/^PAWCHIVE_[A-Z_]+$/.test(k)) core.updateEnvFile(k, String(v));
        }
        const content = read();
        return json(res, 200, { name: 'dotenv', path: envPath, content, revision: String(content.length) });
      }
    }
  }
  // config/project 已在杂项实现（ProjectDocument 最小化）

  // ---------- blockers / auto-sync / pawchive 搜索（空对齐——页面不崩；真实代理后续） ----------
  if (pathname === '/api/v1/blockers' && (method === 'GET' || method === 'PUT')) return json(res, 200, { blockers: [] });
  if (pathname === '/api/v1/auto-sync/plans' && method === 'GET') return json(res, 200, { plans: [], revision: '0', next_runs: [] });
  if (pathname === '/api/v1/auto-sync/runs' && method === 'GET') return json(res, 200, []);
  if (pathname === '/api/v1/auto-sync/updates' && method === 'GET') return json(res, 200, []);
  if (pathname.includes('/auto-sync/plans/')) return json(res, 200, { plans: [], revision: '0' });
  if ((pathname === '/api/v1/pawchive/creators' || pathname === '/api/v1/pawchive/posts' || pathname === '/api/v1/posts') && method === 'GET') return json(res, 200, []);

  // ---------- naming（模板映射：NamingConfigurationResponse——前端 NamingPage） ----------
  if (pathname === '/api/v1/naming' && method === 'GET') return json(res, 200, { ...core.getNaming(), conversion_pending: false });
  if (pathname === '/api/v1/naming' && method === 'PATCH') {
    const body = await readBody(req).catch(() => ({}));
    const n = body.naming || {};
    if (body.section === 'templates' || !body.section) {
      if (typeof n.creator_dirname_format === 'string') core.updateEnvFile('PAWCHIVE_CREATOR_DIR_FORMAT', n.creator_dirname_format);
      if (typeof n.post_dirname_format === 'string') core.updateEnvFile('PAWCHIVE_POST_DIR_FORMAT', n.post_dirname_format);
    }
    if (body.section === 'structure' || !body.section) {
      if (n.post_structure && typeof n.post_structure.attachments === 'string' && n.post_structure.attachments !== 'attachments') core.updateEnvFile('PAWCHIVE_ATTACHMENTS_SUBDIR', n.post_structure.attachments);
      if (n.post_structure && n.post_structure.attachments === 'attachments') core.updateEnvFile('PAWCHIVE_ATTACHMENTS_SUBDIR', '');
    }
    if (typeof body.default_output === 'string' && body.default_output) core.updateEnvFile('PAWCHIVE_DATA_ROOT', body.default_output);
    return json(res, 200, { ...core.getNaming(), conversion_pending: false });
  }
  // naming 附属（NamingPage 打开必查——404 会导致前端渲染崩；空对齐）
  if (pathname === '/api/v1/naming/conversions' && method === 'GET') return json(res, 200, []);
  if (pathname === '/api/v1/naming/legacy-context' && method === 'GET') return json(res, 200, { roots: [], conversion_pending: false });
  if (pathname === '/api/v1/naming/layout-versions' && method === 'GET') return json(res, 200, []);
  if (pathname === '/api/v1/naming/source/parse' && method === 'POST') { await readBody(req).catch(() => ({})); return json(res, 200, { recognized_fields: [], unrecognized_fields: [] }); }
  if (pathname === '/api/v1/naming/preview' && method === 'POST') { await readBody(req).catch(() => ({})); return json(res, 200, { creators: [] }); }
  if (pathname === '/api/v1/naming/apply' && method === 'POST') { await readBody(req).catch(() => ({})); return json(res, 200, { status: 'ok' }); }
  {
    const p = matchPath(pathname, '/api/v1/naming/conversions/{conversion_id}/{action}');
    if (p && ['cancel', 'pause', 'resume'].includes(p.action)) return json(res, 200, {});
  }

  // ---------- filesystem（浏览目录——任务创建选路径对话框；对齐 openapi browse_filesystem） ----------
  if (pathname === '/api/v1/filesystem' && method === 'GET') {
    const scope = url.searchParams.get('scope') || 'project';
    const mode = url.searchParams.get('mode') || 'directory';
    const pathArg = url.searchParams.get('path') || '';
    const search = url.searchParams.get('search') || '';
    const includeHidden = url.searchParams.get('include_hidden') === 'true';
    const base = scope === 'host' ? '/' : (TARGET_PATH || path.sep);
    let dir;
    try { dir = pathArg && pathArg !== '' ? (path.isAbsolute(pathArg) ? pathArg : path.join(base, pathArg)) : base; } catch { dir = base; }
    const entries = [];
    let readErr = null;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!includeHidden && e.name.startsWith('.')) continue;
        if (mode === 'file' && !e.isFile()) continue;
        if (mode === 'directory' && !e.isDirectory()) continue;
        if (search && !e.name.includes(search)) continue;
        const full = path.join(dir, e.name);
        let symlink = false;
        try { symlink = fs.lstatSync(full).isSymbolicLink(); } catch { /* lstat 失败按普通 */ }
        entries.push({ name: e.name, path: full, project_relative_path: pathArg && pathArg !== '' ? pathArg : null, kind: e.isDirectory() ? 'directory' : 'file', is_symlink: symlink, navigable: e.isDirectory(), deletable: false });
      }
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    } catch (err) { readErr = String(err && err.message || err); }
    const breadcrumbs = [];
    let cur = dir;
    while (cur && cur !== path.parse(dir).root) { breadcrumbs.unshift({ label: path.basename(cur) || cur, path: cur }); const p2 = path.dirname(cur); if (p2 === cur) break; cur = p2; }
    if (dir.startsWith(path.parse(dir).root)) breadcrumbs.unshift({ label: path.parse(dir).root, path: path.parse(dir).root });
    return json(res, 200, {
      scope, mode, path: dir,
      project_relative_path: pathArg && pathArg !== '' ? pathArg : null,
      parent: dir === path.parse(dir).root ? null : path.dirname(dir),
      separator: path.sep, breadcrumbs,
      locations: [{ id: scope, label: scope === 'host' ? 'Host' : 'Project', path: base }],
      entries, suggested_name: null, offset: 0, limit: entries.length,
      has_more: false, // 契约字段（分页标志——我们一次性返回全部）
      error: readErr || null,
    });
  }

  // ---------- tasks ----------
  if (pathname === '/api/v1/tasks' && method === 'GET') return json(res, 200, core.listTasks().map(taskRecord));
  if (pathname === '/api/v1/tasks' && method === 'POST') {
    const body = await readBody(req);
    const spec = body.spec || {};
    if (spec.kind && spec.kind !== 'download') return json(res, 400, { detail: `unsupported kind: ${spec.kind}` });
    // 两种创建模式：fields（service/creator_id/post_id）或 URL（spec.post 网页链接——前端 TaskEditor 的 downloadIdentity==="url"）
    const service = spec.service || null;
    const creatorId = spec.creator_id || null;
    const postId = spec.post_id || null;
    const url = spec.post || null;
    if (!service && !creatorId && !url) return json(res, 400, { detail: 'spec.service/creator_id 或 spec.post(URL) 至少一项' });
    const targetPath = spec.output || core.CONFIG.dataRoot || '';
    if (!targetPath) return json(res, 400, { detail: 'output required（PAWCHIVE_DATA_ROOT 未配置或 spec.output 为空）' });
    const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    core.createTask({ id: taskId, spec: { kind: 'download', service, creator_id: creatorId, post_id: postId, post: url, output: targetPath } });
    core.downloadTask(taskId, { service, creator_id: creatorId, post_id: postId, url }, targetPath, { concurrency: Number(process.env.PAWCHIVE_CONCURRENCY) || 5, postInterval: Number(process.env.PAWCHIVE_POST_INTERVAL) || 5 })
      .catch(err => console.error(`[task ${taskId}] 执行异常: ${err && err.message || err}`));
    return json(res, 201, taskRecord(core.getTask(taskId)));
  }
  {
    const p = matchPath(pathname, '/api/v1/tasks/{task_id}');
    if (p) {
      const t = core.getTask(p.task_id);
      if (!t) return json(res, 404, { detail: 'task not found' });
      if (method === 'GET') return json(res, 200, taskRecord(t));
      if (method === 'DELETE') { core.db.prepare('DELETE FROM tasks WHERE id=?').run(p.task_id); return json(res, 200, { ok: true }); }
      if (method === 'PATCH') { const body = await readBody(req).catch(() => ({})); if (body.status) core.updateTaskStatus(p.task_id, body.status); return json(res, 200, taskRecord(core.getTask(p.task_id))); }
      return json(res, 405, { detail: 'method not allowed' });
    }
  }
  {
    const p = matchPath(pathname, '/api/v1/tasks/{task_id}/events');
    if (p && method === 'GET') {
      const after = parseInt(url.searchParams.get('after') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      return json(res, 200, core.eventStore.events({ task_id: p.task_id, after: Number.isFinite(after) ? after : 0, limit }));
    }
  }
  {
    const p = matchPath(pathname, '/api/v1/tasks/{task_id}/attempts');
    if (p && method === 'GET') return json(res, 200, core.listAttempts(p.task_id));
  }
  // 任务控制（run/stop/pause/resume/rerun）——状态标记（cli 内嵌下载无中断接口，真实取消 TODO）
  for (const action of ['run', 'stop', 'pause', 'resume', 'rerun', 'cleanup-preview']) {
    const p = matchPath(pathname, `/api/v1/tasks/{task_id}/${action}`);
    if (p) {
      if (action === 'cleanup-preview') return json(res, 200, { task_id: p.task_id, artifacts: [], removable_files: 0, removable_bytes: 0 });
      const t = core.getTask(p.task_id);
      if (!t) return json(res, 404, { detail: 'task not found' });
      const map = { run: 'running', stop: 'stopped', pause: 'paused', resume: 'running', rerun: 'queued' };
      if (map[action]) core.updateTaskStatus(p.task_id, map[action]);
      core.eventStore.publish({ event_type: 'task.progress', task_id: p.task_id, data: { phase: action } });
      return json(res, 200, taskRecord(core.getTask(p.task_id)));
    }
  }

  // ---------- events（SSE 全局流） ----------
  if (pathname === '/api/v1/events' && method === 'GET') { sseStream(req, res, core); return; }

  // ---------- 未实现（mcp）与未知端点 ----------
  if (pathname.includes('/mcp')) return json(res, 404, { detail: 'not implemented (removed by design)' });
  return json(res, 404, { detail: `unknown endpoint ${method} ${pathname}` });
}

module.exports = { handle };