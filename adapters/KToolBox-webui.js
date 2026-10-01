#!/usr/bin/env node
/**
 * adapters/KToolBox-webui.js —— KToolBox 契约适配器（协议翻译层，无业务）
 *
 * 收窄范围（设计文档第 6/7 节）：
 * ✅ session 放行已登录 / creators（含 avatar + 编辑 PUT/DELETE）/ tasks / events(SSE) / filesystem / project 最小化
 * ⚠️ 功能空对齐（下文中所有返回空/最小结构处——如 blockers/auto-sync/naming 附属/posts 搜索/revisions/cleanup-preview）：
 *    我们无对应业务，用「空反应」强行模拟官方方法关闭对应功能（job.extract_external_links=false / include_revisions=false 语义）——
 *    路径/结构返回合法占位值使前端页面可用不崩，后端不生成对应文件/目录；字段显示隐藏需①层重建前端（原版无隐藏机制）
 * ❌ mcp（删除）；naming/config-schema/dotenv/posts 代理待续
 * 契约源：docs/.probe-ktoolbox/webui/openapi.yaml（响应结构）+ src/lib/api.ts（前端调用面）
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const envCompat = require('../scripts/KToolBox-env-compat.js'); // env 翻译中枢（兼容层强制读——env 相关全走它）
let legacyMigrationCache = { ts: 0, result: null }; // 模块级缓存（legacy-migration 检测结果——真实目录扫描 19s+——必须缓存避免前端每请求重扫；handle 内声明会导致每请求重置）

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
  return res; // 返回真值——|| 分发链短路（未命中子 handler 返回 null 继续；命中后停止后续 handler，防二次 writeHead）
}

/** 从 URL 匹配路径参数：/api/v1/creators/{service}/{id}/avatar */
function matchPath(pathname, pattern) {
  const segs = pathname.split('/').filter(Boolean);
  const ps = pattern.split('/').filter(Boolean);
  if (segs.length !== ps.length) return null;
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    const paramMatch = /^\{([a-z_]+)\}$/.exec(ps[i]);
    if (paramMatch) params[paramMatch[1]] = decodeURIComponent(segs[i]);
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
  let spec = t.spec || {};
  // sync 任务 spec 需含 SynTaskSpec 全字段（creators/keywords/keywords_exclude/save_creator_indices/offset——
  // 前端任务详情渲染读 .length/.map——缺失触发 undefined 崩）
  if (spec.kind === 'sync') {
    spec = {
      ...spec,
      creators: Array.isArray(spec.creators) ? spec.creators : (spec.service ? [{ service: spec.service, creator_id: spec.creator_id }].filter(c => c.service) : []),
      keywords: spec.keywords || [], keywords_exclude: spec.keywords_exclude || [],
      save_creator_indices: spec.save_creator_indices ?? false, offset: spec.offset ?? 0,
    };
  }
  // URL 模式任务（spec 只有 post）——从链接解析 service/creator_id（前端渲染 target 读 spec.service——缺则 toLocaleLowerCase 崩）
  if (!spec.service && !spec.creator_id && spec.post) {
    const urlMatch = /pawchive\.pw\/([a-z0-9_-]+)\/user\/([a-z0-9_-]+)/i.exec(String(spec.post));
    if (urlMatch) spec = { ...spec, service: urlMatch[1], creator_id: urlMatch[2] };
  }
  // 全面兜底：service/creator_id 强制字符串（前端 creatorPresentationName 的 item/creator.service.toLocaleLowerCase() 无保护——undefined 崩——空串安全）
  spec = { ...spec, service: String(spec.service || ''), creator_id: String(spec.creator_id ?? '') };
  if (Array.isArray(spec.creators)) spec = { ...spec, creators: spec.creators.map(c => ({ ...c, service: String(c && c.service || ''), creator_id: String(c?.creator_id ?? '') })) };
  return {
    id: t.id, kind: spec.kind || t.kind || 'download', status: t.status,
    spec, presentation: t.presentation || null,
    automatic_origin: null, position: t.position || 0, revision: t.revision || 1,
    // progress 补全 TaskProgress 默认结构（active_creators 等数组/对象——前端任务列表/详情读 .length——缺失 undefined.length 崩——P0）
    progress: (() => { // 2026-09-30 后端映射（不改前端）：同 progressReducer.current()——queued_files 字段值映射为「全部」（processed+failed）。
      // 自定义语义（与 KToolBox 原版不同，用户决策）：已处理 = 全部 - 失败（失败不算已处理），前端「文件」读 processed/queued 即显示「已处理/全部」；
      // 这里读 DB 落库的 progress（taskRecord 输出层），与 SSE 事件内嵌快照（core current() 映射）两处保持一致。
      const pr = { queued_files: 0, processed_files: 0, completed_files: 0, existing_files: 0, failed_files: 0, transferred_bytes: 0, total_bytes: null, speed_bps: 0, eta_seconds: null, active_creators: [], active_downloads: {}, ...(t.progress || {}) };
      pr.queued_files = (pr.processed_files || 0) + (pr.failed_files || 0);
      return pr;
    })(),
    error: t.error || null, failure: null, blocked_by: t.blocked_by || null, // 2026-09-29 调度器：blocked 阻塞源任务 id（从 DB 读——前端任务列表显示"被阻塞"）
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


/** 前端错误上报（AI 无视觉感知浏览器错误：前端捕获 → 本端点 → .client-errors.jsonl → AI tail 读） */
async function handleMiscClientError(method, pathname, url, req, res, core) {
  if (pathname !== '/api/v1/client-error' || method !== 'POST') return null;
  const body = await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ }));
  const entry = { ...body, receivedAt: new Date().toISOString(), ip: req.socket.remoteAddress || '' };
  const logPath = path.join(__dirname, '..', '.client-errors.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true }); // 目录存在不报错、能建多级——无需先 existsSync
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  console.error('[client-error]', entry.type || 'unknown', '|', entry.message || '', entry.source ? `@${entry.source}${entry.lineno != null ? `:${entry.lineno}:${entry.colno}` : ''}` : '');
  return json(res, 200, { ok: true });
}

/** session（放行已登录：无认证——dev-noauth 设计，非真实凭据） */
async function handleMiscSession(method, pathname, url, req, res, core) {
  if (pathname === '/api/v1/session' && method === 'GET') {
    const now = new Date().toISOString();
    return json(res, 200, { authenticated: true, username: 'pawchive', csrf_token: 'dev-noauth', created_at: now, last_seen_at: now });
  }
  if (pathname === '/api/v1/session/login' && method === 'POST') {
    await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ })); // 接受任意凭据，直接已登录
    const now = new Date().toISOString();
    return json(res, 200, { authenticated: true, username: 'pawchive', csrf_token: 'dev-noauth', created_at: now, last_seen_at: now });
  }
  if (pathname === '/api/v1/session/logout' && method === 'POST') return json(res, 200, {});
  return null;
}

/** 信息类端点：health/about/site-version/startup-notices/project */
async function handleMiscInfo(method, pathname, url, req, res, core) {
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
      root: TARGET_PATH, project_config: '', // 字符串（非对象——SystemPage 渲染为文本——对象 {{}} 触发 React #31 崩）
      default_output: TARGET_PATH, dotenv_files: [], version: '1.0.2', published_target_timezone: '',
      configuration: { schema_version: 5, default_output: TARGET_PATH, creators: [], blockers: [], automatic_sync: [], naming: { creator_dirname_format: core.CONFIG.creatorDirFormat, post_dirname_format: core.CONFIG.postDirFormat, filename_format: core.CONFIG.fileFormat } },
    });
  }
  return null;
}

/** MCP 空对齐（status/tokens/tools 空结构——页面显示未启用不崩）+ 未知端点 404 */
async function handleMiscMcp(method, pathname, url, req, res, core) {
  if (pathname === '/api/v1/mcp/status') return json(res, 200, { enabled: false, server_url: null, capabilities: {}, running: false, endpoint_path: null, openapi_path: null, transport: null, tool_count: 0 }); // 契约字段补全（contract-check）
  if (pathname === '/api/v1/mcp/tokens') return json(res, 200, []);
  if (pathname === '/api/v1/mcp/tools') return json(res, 200, []);
  if (pathname.includes('/mcp')) return json(res, 404, { detail: 'not implemented (removed by design)' });
  return json(res, 404, { detail: `unknown endpoint ${method} ${pathname}` });
}

/** 杂项域分发：client-error → session → 信息类 → mcp/404 */
async function handleMiscGroup(method, pathname, url, req, res, core) {
  return (await handleMiscClientError(method, pathname, url, req, res, core))
    || (await handleMiscSession(method, pathname, url, req, res, core))
    || (await handleMiscInfo(method, pathname, url, req, res, core))
    || (await handleMiscMcp(method, pathname, url, req, res, core));
}

/** 创作者列表（GET /api/v1/creators）——avatar/banner 对齐 MediaAsset 结构（非 null 空结构——前端 null.values 崩） */
async function handleCreatorList(method, pathname, url, req, res, core) {
  if (pathname !== '/api/v1/creators' || method !== 'GET') return null;
  const creators = core.listCreators(TARGET_PATH).map(c => {
    const avatarUrl = c.avatar ? `/api/v1/creators/${c.service}/${c.creator_id}/avatar?variant=thumbnail` : null;
    return {
      service: String(c.service || ''), creator_id: String(c.creator_id ?? ''), alias: null, name: c.name || '', enabled: c.enabled !== false, // service/creator_id 显式字符串兜底（前端 item.service.toLocaleLowerCase() 无保护——undefined 崩）
      avatar: avatarUrl ? { thumbnail_url: avatarUrl, preview_url: avatarUrl, original_url: avatarUrl } : { thumbnail_url: '', preview_url: '', original_url: '' }, // 非 null 空 MediaAsset（前端 null 处理 bug→null.values 崩）
      banner: { thumbnail_url: '', preview_url: '', original_url: '' },
    };
  });
  return json(res, 200, creators);
}

/** 创作者头像（GET /api/v1/creators/{service}/{creator_id}/avatar）——本地头像文件直出，无则 404 */
async function handleCreatorAvatar(method, pathname, url, req, res, core) {
  const p = matchPath(pathname, '/api/v1/creators/{service}/{creator_id}/avatar');
  if (!p || method !== 'GET') return null;
  const creators = core.listCreators(TARGET_PATH);
  const creator = creators.find(x => x.service === p.service && x.creator_id === p.creator_id);
  if (creator && creator.avatar) {
    const file = path.join(TARGET_PATH, creator.dir, creator.avatar);
    if (fs.existsSync(file)) {
      const ext = path.extname(file);
      const ct = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.img': 'application/octet-stream' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(file));
    }
  }
  return json(res, 404, { detail: 'avatar not found' });
}

/** 单创作者编辑/删除（PUT/DELETE /api/v1/creators/{service}/{creator_id}）——别名/启用开关 SQLite 持久化 */
async function handleCreatorItem(method, pathname, url, req, res, core) {
  const p = matchPath(pathname, '/api/v1/creators/{service}/{creator_id}');
  if (!p) return null;
  if (method === 'PUT') { // 编辑：别名/启用开关（SQLite 持久化）
    const body = await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ }));
    const profile = core.updateCreatorProfile(p.service, p.creator_id, { alias: body.alias ?? null, enabled: body.enabled !== false });
    return json(res, 200, { service: p.service, creator_id: p.creator_id, alias: profile.alias, enabled: profile.enabled });
  }
  if (method === 'DELETE') {
    core.deleteCreatorProfile(p.service, p.creator_id);
    return json(res, 200, { ok: true });
  }
  return null;
}

/** creators 域分发：列表 → 头像 → 单创作者编辑/删除 */
async function handleCreatorsGroup(method, pathname, url, req, res, core) {
  return (await handleCreatorList(method, pathname, url, req, res, core))
    || (await handleCreatorAvatar(method, pathname, url, req, res, core))
    || (await handleCreatorItem(method, pathname, url, req, res, core));
}

/** config/schema：暴露全部 PAWCHIVE_* 实际配置（按原版分类结构——字段数组构建独立成函数，降复杂度） */
function buildConfigFields(cfg, env) {
  // choices 可选（第 8 参——枚举型字段传 [{value,label}]；前端 ConfigurationPage 读 choice_mode/choices 渲染选择器——缺则固定文本，契约对齐补）
  const field = (path_, env_name, section, label, description, json_schema, value, choices = null) => ({
    path: path_, env_name, section, label, description, json_schema,
    default: json_schema.default ?? null, value: value ?? null,
    is_set: value !== undefined && value !== null && value !== '',
    secret: false, source: 'dotenv', apply_mode: 'next_task',
    ...(choices ? { choice_mode: 'fixed', choices: choices.map(c => ({ value: c.value, label: c.label, description: c.description ?? null })) } : {}),
  });
  // 全部 PAWCHIVE_* 实际配置（按原版分类结构暴露——最终生效值页完整显示我们的真实配置；原版无对应的不列）
  const ENV_FIELDS = [
    // naming（命名模板）
    ['naming.creator_dirname_format', 'PAWCHIVE_CREATOR_DIR_FORMAT', 'naming', '创作者目录模板', '{creator_name}/{creator_id}/{service}', 'string', cfg.creatorDirFormat],
    ['naming.creator_prefix_format', 'PAWCHIVE_CREATOR_PREFIX_FORMAT', 'naming', '大小写冲突前缀', 'Windows 等大小写不敏感文件系统下创作者目录与帖子目录名冲突时添加的前缀模板（{service} 占位；空=不加）', 'string', cfg.creatorPrefixFormat],
    ['naming.post_dirname_format', 'PAWCHIVE_POST_DIR_FORMAT', 'naming', '帖子目录模板', '{title}/{post_id}/{service}/{creator_id}/{published}/{added}', 'string', cfg.postDirFormat],
    ['naming.filename_format', 'PAWCHIVE_FILENAME_FORMAT', 'naming', '文件名模板', '{} = 原文件名', 'string', cfg.fileFormat],
    ['naming.filename_suffix_format', 'PAWCHIVE_FILENAME_SUFFIX_FORMAT', 'naming', '文件名后缀', '冲突改名后缀（可空）', 'string', env.PAWCHIVE_FILENAME_SUFFIX_FORMAT || ''],
    // job（下载任务）
    ['job.data_root', 'PAWCHIVE_DATA_ROOT', 'job', '下载目录', '创作者/帖子的存放根目录', 'string', env.PAWCHIVE_DATA_ROOT || ''],
    ['job.concurrency', 'PAWCHIVE_CONCURRENCY', 'job', '并行下载并发', 'worker 池式并发（1-16）', 'integer', env.PAWCHIVE_CONCURRENCY || 5],
    ['job.include_revisions', 'PAWCHIVE_INCLUDE_REVISIONS', 'job', '下载修订版本', '作者编辑过的历史版本——存 revisions/<id>/（默认开，硬链接去重）', 'boolean', env.PAWCHIVE_INCLUDE_REVISIONS !== '0'],
    ['job.revisions_subdir', 'PAWCHIVE_REVISIONS_SUBDIR', 'job', '修订版本子目录', '默认 revisions', 'string', cfg.revisionsSubdir],
    ['job.download_drive', 'PAWCHIVE_DOWNLOAD_DRIVE', 'job', '下载正文网盘链接', 'Google Drive（provider 可扩展）', 'boolean', env.PAWCHIVE_DOWNLOAD_DRIVE !== '0'],
    ['job.attachments_subdir', 'PAWCHIVE_ATTACHMENTS_SUBDIR', 'job', '附件子目录', '空=帖根目录；设 attachments 等', 'string', cfg.attachmentsSubdir],
    ['job.index_filename', 'PAWCHIVE_INDEX_FILENAME', 'job', '详情索引文件名', '帖目录索引 html 名', 'string', cfg.indexFilename],
    ['job.write_creator_index', 'PAWCHIVE_WRITE_CREATOR_INDEX', 'job', '写创作者索引', 'pawchive-index.html 决定去重/网盘下载——强制启用，开关仅供显示（代码不读取）', 'boolean', env.PAWCHIVE_WRITE_CREATOR_INDEX !== '0'],
    // api（Pawchive API）
    ['api.base_url', 'PAWCHIVE_API_BASE', 'api', 'API 地址', 'Pawchive API base（含 /api/v1）', 'string', env.PAWCHIVE_API_BASE || 'https://pawchive.pw/api/v1'],
    ['api.retry_times', 'PAWCHIVE_RETRY_TIMES', 'api', '请求重试次数', 'API 失败重试', 'integer', env.PAWCHIVE_RETRY_TIMES || 3],
    ['api.retry_interval', 'PAWCHIVE_RETRY_INTERVAL_MS', 'api', '重试间隔（ms）', '', 'integer', env.PAWCHIVE_RETRY_INTERVAL_MS || 1500],
    // downloader（文件下载）
    ['downloader.files_base', 'PAWCHIVE_FILES_BASE', 'downloader', '文件 host', 'file.pawchive.pw（DDoS-Guard 反爬）', 'string', cfg.filesBase],
    ['downloader.tps', 'PAWCHIVE_TPS', 'downloader', '每秒新建连接上限', 'file host 反爬要求 ≤1', 'number', env.PAWCHIVE_TPS || 1],
    ['downloader.thumb_base', 'PAWCHIVE_THUMB_BASE', 'downloader', '缩略图回退 base', '原图 404 时回退', 'string', cfg.thumbBase],
    ['downloader.temp_suffix', 'PAWCHIVE_TEMP_SUFFIX', 'downloader', '临时文件后缀', '下载中临时后缀', 'string', cfg.tempSuffix],
    // webui（WebUI）
    ['webui.host', 'PAWCHIVE_WEB_HOST', 'webui', '监听地址', '默认 0.0.0.0', 'string', env.PAWCHIVE_WEB_HOST || '0.0.0.0'],
    ['webui.port', 'PAWCHIVE_WEB_PORT', 'webui', '监听端口', '默认 8789', 'integer', env.PAWCHIVE_WEB_PORT || 8789],
    ['webui.protocol', 'PAWCHIVE_WEB_PROTOCOL', 'webui', '前端协议', 'KToolBox-webui / native（预留）', 'string', env.PAWCHIVE_WEB_PROTOCOL || 'KToolBox-webui', [{ value: 'KToolBox-webui', label: 'KToolBox-webui' }, { value: 'native', label: 'native' }]],
    ['webui.max_active_tasks', 'PAWCHIVE_CONCURRENCY', 'webui', '执行中工作上限', '对齐我们下载并发（任务级上限=文件级并发值）', 'integer', env.PAWCHIVE_CONCURRENCY || 5],
    // general（其他）
    ['general.user_agent', 'PAWCHIVE_USER_AGENT', 'general', '下载 UA', 'file host 要求可识别 UA', 'string', cfg.userAgent],
    ['general.creators_cache_days', 'PAWCHIVE_CREATORS_TTL_DAY', 'general', '创作者缓存（天）', '搜索用全量缓存 TTL（默认 7）', 'integer', env.PAWCHIVE_CREATORS_TTL_DAY || 7],
  ];
  return ENV_FIELDS.map(([p, e, s, l, d, type, v, choices]) => {
    const json_schema = type === 'boolean' ? { type: 'boolean' } : type === 'integer' ? { type: 'integer' } : type === 'number' ? { type: 'number' } : { type: 'string' };
    return field(p, e, s, l, d, json_schema, v, choices);
  });
}

/** config/schema GET（全部 env 字段目录） */
async function handleConfigSchema(method, pathname, url, req, res, core) {
  if (pathname !== '/api/v1/config/schema' || method !== 'GET') return null;
  const fields = buildConfigFields(core.CONFIG, process.env);
  return json(res, 200, { locale: 'zh-CN', sections: { naming: '命名模板', job: '下载任务', api: 'Pawchive API', downloader: '文件下载', webui: 'WebUI', general: '其他', logger: '日志', published_time: '发布时间' }, fields });
}

/** config/project GET/PUT（项目配置文档——对齐 ProjectDocumentResponse：ConfigurationPage 必查，404 会 console 报错） */
async function handleConfigProject(method, pathname, url, req, res, core) {
  if (pathname !== '/api/v1/config/project') return null;
  const projectResp = (naming, revision, content) => ({
    path: TARGET_PATH || '', content: content || '', revision,
    configuration: { schema_version: 5, default_output: TARGET_PATH || '', resolved_default_output: TARGET_PATH || '', creators: [], blockers: [], automatic_sync: [], naming: naming.naming, published_time: naming.published_time },
  });
  if (method === 'GET') { const naming = core.getNaming(); return json(res, 200, projectResp(naming, '0', '')); }
  if (method === 'PUT') { // P2-1（2026-09-29）：raw 保存接受（200——页面不 404；配置以 env 为准）
    const body = await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ }));
    const naming = core.getNaming();
    return json(res, 200, projectResp(naming, '1', body.content || ''));
  }
  return null;
}

/** config/dotenv/{name}：dotenv=我们 .env（读全文/写 values）；production 无（空文档） */
async function handleConfigDotenv(method, pathname, url, req, res, core) {
  const p = matchPath(pathname, '/api/v1/config/dotenv/{name}');
  if (!p) return null;
  const envPath = path.join(__dirname, '..', '.env');
  const read = () => { let content = ''; try { content = fs.readFileSync(envPath, 'utf8'); } catch { /* 无 .env */ } return content; };
  if (method === 'GET') {
    const content = p.name === 'production' ? '' : read();
    return json(res, 200, { name: p.name, path: p.name === 'production' ? '' : envPath, content, revision: String(content.length) });
  }
  if (method === 'PATCH' || method === 'PUT') { // P2-1（2026-09-29）：PUT 同 PATCH（前端 ConfigurationPage raw 保存用 PUT——之前只有 PATCH 404）
    if (p.name === 'production') return json(res, 200, { name: 'production', path: '', content: '', revision: '0' });
    const body = await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ }));
    if (typeof body.content === 'string') { // 语义差异修复（2026-09-29）：前端 raw 保存发 {content}（全文）——写 .env 全文（之前只处理 values——保存 200 但未生效）
      const lines = body.content.split(/\r?\n/).filter(l => /^[A-Z][A-Z0-9_]*=/.test(l) || l.startsWith('#') || l.trim() === '');
      fs.mkdirSync(path.dirname(envPath), { recursive: true }); // envPath 目录存在不报错、可建多级
      fs.writeFileSync(envPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    }
    for (const [k, v] of Object.entries(body.values || {})) {
      if (/^PAWCHIVE_[A-Z_]+$/.test(k)) core.updateEnvFile(k, String(v));
    }
    const content = read();
    return json(res, 200, { name: 'dotenv', path: envPath, content, revision: String(content.length) });
  }
  return null;
}

/** config/validate + example（前端 ConfigurationPage raw 保存/校验/示例——补端点不 404） */
async function handleConfigMisc(method, pathname, url, req, res, core) {
  if (pathname === '/api/v1/config/validate' && (method === 'POST' || method === 'PUT')) {
    const body = await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ }));
    const errors = [];
    for (const [k] of Object.entries(body.values || {})) { if (!/^PAWCHIVE_[A-Z_]+$/.test(k)) errors.push(`${k}: 非法键名`); }
    return json(res, 200, { ok: errors.length === 0, errors });
  }
  if (pathname === '/api/v1/config/example' && method === 'GET') {
    return json(res, 200, { content: '# Pawchive env 模板示例\nPAWCHIVE_CONCURRENCY=5\nPAWCHIVE_USER_AGENT=Mozilla/5.0 (Pawchive-downloader)\n', revision: '0' });
  }
  return null;
}

/** config 域分发：schema → project → dotenv → validate/example */
async function handleConfigGroup(method, pathname, url, req, res, core) {
  return (await handleConfigSchema(method, pathname, url, req, res, core))
    || (await handleConfigProject(method, pathname, url, req, res, core))
    || (await handleConfigDotenv(method, pathname, url, req, res, core))
    || (await handleConfigMisc(method, pathname, url, req, res, core));
}

/** blockers（空对齐）+ auto-sync 计划 CRUD/操作——自动同步=自动按作者下载：计划=作者列表+间隔 → 定时器触发 sync 任务（真实 CRUD；schedule 简化为 interval{every,unit}） */
async function handleBlockersAutoSync(method, pathname, url, req, res, core) {
  if (pathname === '/api/v1/blockers' && (method === 'GET' || method === 'PUT')) return json(res, 200, { blockers: [] });
  if (pathname === '/api/v1/auto-sync/plans' && method === 'GET') {
    const plans = core.listAutoSyncPlans();
    return json(res, 200, { plans, revision: '0', next_runs: Object.fromEntries(plans.map(p => [p.id, p.next_run_at])) });
  }
  if (pathname === '/api/v1/auto-sync/plans' && method === 'POST') {
    const body = await readBody(req);
    const id = body.id || `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const plan = core.createAutoSyncPlan({ id, name: body.name || 'auto-sync', enabled: body.enabled !== false, creators: body.creators || [], schedule: body.schedule || {} });
    return json(res, 201, plan);
  }
  if (pathname === '/api/v1/auto-sync/runs' && method === 'GET') return json(res, 200, []);
  if (pathname === '/api/v1/auto-sync/updates' && method === 'GET') return json(res, 200, []);
  {
    const p = matchPath(pathname, '/api/v1/auto-sync/plans/{plan_id}/{action}');
    if (p && method === 'POST' && ['run', 'pause', 'resume'].includes(p.action)) { // 计划操作：run 立即触发 / pause 停用 / resume 启用
      const plan = core.getAutoSyncPlan(p.plan_id);
      if (!plan) return json(res, 404, { detail: 'plan not found' });
      if (p.action === 'pause') core.updateAutoSyncPlan(p.plan_id, { enabled: false });
      else if (p.action === 'resume') core.updateAutoSyncPlan(p.plan_id, { enabled: true });
      else core.triggerAutoSyncPlan(plan, core.CONFIG.dataRoot || '');
      return json(res, 200, core.getAutoSyncPlan(p.plan_id) || plan);
    }
  }
  {
    const p = matchPath(pathname, '/api/v1/auto-sync/plans/{plan_id}');
    if (p) {
      if (method === 'GET') { const plan = core.getAutoSyncPlan(p.plan_id); return plan ? json(res, 200, plan) : json(res, 404, { detail: 'plan not found' }); }
      if (method === 'DELETE') { core.deleteAutoSyncPlan(p.plan_id); return json(res, 204, null); }
      if (method === 'PATCH' || method === 'PUT') { const body = await readBody(req); const plan = core.updateAutoSyncPlan(p.plan_id, body); return plan ? json(res, 200, plan) : json(res, 404, { detail: 'plan not found' }); }
      if (method === 'POST') { const plan = core.getAutoSyncPlan(p.plan_id); if (!plan) return json(res, 404, { detail: 'plan not found' }); return json(res, 200, plan); } // 计划操作（run/stop 等——调度器统一处理——接受返回计划）
    }
  }
  return null;
}

/** Pawchive 站搜索/详情代理（真实：创作者全量缓存搜索 + 帖详情直连；posts 搜索空对齐） */
async function handlePawchiveSearch(method, pathname, url, req, res, core) {
  // 创作者搜索（真实：fetchAllCreators 全量缓存 + 过滤——对齐原版 search_creator）；posts 搜索保持空对齐（无全局作品搜索）
  if (pathname === '/api/v1/pawchive/creators' && method === 'GET') {
    const creators = await core.searchCreators({
      id: url.searchParams.get('creator_id') || url.searchParams.get('id') || null,
      name: url.searchParams.get('name') || null,
      service: url.searchParams.get('service') || null,
    }, TARGET_PATH);
    return json(res, 200, creators.map(c => ({ id: c.creator_id, service: c.service, name: c.name, updated: c.updated || null, avatar: { thumbnail_url: '', preview_url: '', original_url: '' }, banner: { thumbnail_url: '', preview_url: '', original_url: '' } }))); // 对齐前端 CreatorSummary（id/avatar/banner MediaAsset 非 null——缺字段/null 导致前端读崩）
  }
  if (pathname === '/api/v1/pawchive/posts' && method === 'GET') {
    const creatorId = url.searchParams.get('creator_id');
    const service = url.searchParams.get('service');
    if (creatorId && service) { // 有 creator_id+service → 拉创作者帖子列表
      const { posts } = await core.cli.fetchPostsWithResume(service, creatorId, { length: 100 });
      const query = url.searchParams.get('name') || url.searchParams.get('query') || null;
      const off = Number(url.searchParams.get('offset')) || 0;
      // P1-1（2026-09-29）：补 service/user 字段（前端详情/创建任务读——缺则详情 404/建任务 400）+ 透传 name/query/offset 搜索参数
      const list = (posts || []).filter(p => !query || (p.title || '').toLowerCase().includes(query.toLowerCase())).slice(off);
      return json(res, 200, list.map(p => ({ id: p.id, service, user: creatorId, title: p.title || '', published: p.published || null, added: p.added || null }))); // P1-1 修正（2026-09-29）：user 契约是 string（前端 ${selected.user} 拼 URL——对象会 "[object Object]" 详情 404/建任务 400）
    }
    return json(res, 200, []);
  }
  if (pathname === '/api/v1/posts' && method === 'GET') return json(res, 200, []); // 功能空对齐：无全局作品搜索
  // pawchive/posts/{service}/{creator_id}/{post_id} 详情代理（Pawchive API 直连——cli.getPost → PawchivePostDetailResponse 翻译）
  {
    const p = matchPath(pathname, '/api/v1/pawchive/posts/{service}/{creator_id}/{post_id}/revisions');
    if (p && method === 'GET') return json(res, 200, []); // 功能空对齐：无 revision 概念（模拟官方 include_revisions=false——不生成修订）
  }
  {
    const p = matchPath(pathname, '/api/v1/pawchive/posts/{service}/{creator_id}/{post_id}');
    if (p && method === 'GET') {
      const detail = await core.cli.getPost(p.service, p.creator_id, p.post_id).catch(err => ({ __error: String(err && err.message || err) }));
      if (detail.__error) return json(res, 404, { detail: detail.__error });
      return json(res, 200, {
        id: detail.id || p.post_id, user: detail.user || p.creator_id, service: detail.service || p.service,
        title: detail.title || null, content: detail.content || null, substring: null, embed: detail.embed || null,
        shared_file: null, added: detail.added || null, published: detail.published || null, edited: null,
        file: detail.file || [], attachments: detail.attachments || [], poll: null, captions: null,
        tags: detail.tags || [], origin: null, preview_state: null, has_full: false, preview_attempts: 0,
      });
    }
  }
  return null;
}

/** auto-sync + Pawchive 站搜索域分发 */
async function handleAutoSyncPawchiveGroup(method, pathname, url, req, res, core) {
  return (await handleBlockersAutoSync(method, pathname, url, req, res, core))
    || (await handlePawchiveSearch(method, pathname, url, req, res, core));
}

/** naming 配置读写（GET 模板 / PATCH 保存 templates+structure+default_output → env） */
async function handleNamingConfig(method, pathname, url, req, res, core) {
  if (pathname !== '/api/v1/naming') return null;
  if (method === 'GET') return json(res, 200, { ...core.getNaming(), conversion_pending: false });
  if (method === 'PATCH') {
    const body = await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ }));
    const n = body.naming || {};
    if (body.section === 'templates' || !body.section) {
      if (typeof n.creator_dirname_format === 'string') envCompat.writeEnv('PAWCHIVE_CREATOR_DIR_FORMAT', n.creator_dirname_format);
      if (typeof n.post_dirname_format === 'string') envCompat.writeEnv('PAWCHIVE_POST_DIR_FORMAT', n.post_dirname_format);
    }
    if (body.section === 'structure' || !body.section) {
      // 目录结构保存（env 中枢 writeEnv——设计文档第十节映射表：可配写 env + external_links FALSE）
      if (n.post_structure) {
        envCompat.writeEnv('PAWCHIVE_ATTACHMENTS_SUBDIR', n.post_structure.attachments === '.' || !n.post_structure.attachments ? '' : n.post_structure.attachments);
        if (typeof n.post_structure.content === 'string') envCompat.writeEnv('PAWCHIVE_INDEX_FILENAME', n.post_structure.content);
        if (typeof n.post_structure.revisions === 'string') envCompat.writeEnv('PAWCHIVE_REVISIONS_SUBDIR', n.post_structure.revisions);
        envCompat.writeEnv('PAWCHIVE_EXTERNAL_LINKS', 'FALSE'); // 外链文件：存在但不用（统一 FALSE 标记——无值/有值都=关）
      }
    }
    if (typeof body.default_output === 'string' && body.default_output) envCompat.writeEnv('PAWCHIVE_DATA_ROOT', body.default_output);
    return json(res, 200, { ...core.getNaming(), conversion_pending: false });
  }
  return null;
}

/** naming 附属（功能空对齐：转换历史/旧版迁移上下文/布局版本/预览/应用/转换操作——空或最小结构使 NamingPage 可用不崩；source/parse 真实解析 env） */
async function handleNamingSub(method, pathname, url, req, res, core) {
  if (pathname === '/api/v1/naming/conversions' && method === 'GET') return json(res, 200, []);
  if (pathname === '/api/v1/naming/legacy-context' && method === 'GET') return json(res, 200, { roots: [], conversion_pending: false });
  if (pathname === '/api/v1/naming/layout-versions' && method === 'GET') return json(res, 200, []);
  if (pathname === '/api/v1/naming/source/parse' && method === 'POST') {
    // 解析配置（legacy tab「解析配置」按钮：前端把 .env 内容 POST 来——识别命名相关 PAWCHIVE_* 键 → recognized_fields + naming；全字段防前端 undefined.length 崩）
    const body = await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ }));
    const envText = typeof body === 'string' ? body : String((body && (body.text || body.content)) || '');
    const recognized = [];
    const parsedNaming = {};
    try {
      const envMap = {};
      for (const line of envText.split(/\r?\n/)) {
        const envLine = /^\s*PAWCHIVE_([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim());
        if (envLine) envMap['PAWCHIVE_' + envLine[1]] = envLine[2].trim().replace(/^["']|["']$/g, '');
      }
      const KEY_TO_NAMING = { PAWCHIVE_CREATOR_DIR_FORMAT: 'creator_dirname_format', PAWCHIVE_POST_DIR_FORMAT: 'post_dirname_format', PAWCHIVE_FILENAME_FORMAT: 'filename_format' };
      for (const [envK, namingK] of Object.entries(KEY_TO_NAMING)) {
        if (envMap[envK] !== undefined) { recognized.push(envK); parsedNaming[namingK] = envMap[envK]; }
      }
    } catch { /* 解析失败返回空结果 */ }
    const envCfg = envCompat.readPawchiveEnv();
    return json(res, 200, {
      format: 'env',
      naming: { creator_dirname_format: parsedNaming.creator_dirname_format || envCfg.creatorDirFormat, post_dirname_format: parsedNaming.post_dirname_format || envCfg.postDirFormat, filename_format: parsedNaming.filename_format || envCfg.filenameFormat },
      digest: '', recognized_fields: recognized, defaulted_fields: [], warnings: [], differences: [], default_published_time_mode: 'pawchive_raw',
    });
  }
  if (pathname === '/api/v1/naming/preview' && method === 'POST') { await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ })); return json(res, 200, { creators: [] }); }
  if (pathname === '/api/v1/naming/apply' && method === 'POST') { await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ })); return json(res, 200, { status: 'ok' }); }
  {
    const p = matchPath(pathname, '/api/v1/naming/conversions/{conversion_id}/{action}');
    if (p && ['cancel', 'pause', 'resume'].includes(p.action)) return json(res, 200, {});
  }
  return null;
}

/** 跑 scripts/migrate.js 子进程（GET 检测 --dryrun /apply 真实迁移）——async spawn 不阻塞事件循环；超时保护 */
function runMigrate(args, timeoutMs) {
  const { spawn } = require('node:child_process');
  const migrate = path.join(__dirname, '..', 'scripts', 'migrate.js');
  return new Promise(resolve => {
    let buf = '';
    const child = spawn(process.execPath, [migrate, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs); // 超时保护（扫描/迁移强制结束）
    child.stdout.on('data', d => { buf += d; });
    child.stderr.on('data', d => { buf += d; });
    child.on('close', () => { clearTimeout(timer); resolve(buf); });
  });
}

/** legacy-migration（旧目录转换——复用 scripts/migrate.js；响应必须含 project_revision 非 undefined——防前端 null.values 崩；检测结果模块级缓存 TTL 10 分钟） */
async function handleNamingMigration(method, pathname, url, req, res, core) {
  if (pathname === '/api/v1/naming/legacy-migration' && method === 'GET') {
    const now = Date.now();
    if (legacyMigrationCache.result && now - legacyMigrationCache.ts < 10 * 60 * 1000) return json(res, 200, legacyMigrationCache.result);
    const out = await runMigrate([TARGET_PATH, '--dryrun'], 60000); // 60s 保护（扫描超时强制结束）
    const mAtt = /attachments (\d+)/.exec(out);
    const mOld = /旧文件 (\d+)/.exec(out);
    const detected = (mAtt && Number(mAtt[1]) > 0) || (mOld && Number(mOld[1]) > 0);
    legacyMigrationCache = { ts: Date.now(), result: { detected, pending: false, project_revision: '0', revision: '0', sources: [], fields: [], ignored_environment_keys: [], attachments: mAtt ? Number(mAtt[1]) : 0, oldFiles: mOld ? Number(mOld[1]) : 0, preview: out.split('\n').filter(l => l.includes('[迁移]') || l.includes('[附件]') || l.includes('[索引]') || l.includes('旧文件')).slice(0, 50) } };
    return json(res, 200, legacyMigrationCache.result);
  }
  if (pathname === '/api/v1/naming/legacy-migration/apply' && method === 'POST') {
    const out = await runMigrate([TARGET_PATH], 120000); // apply 120s 保护
    return json(res, 200, { ok: true, output: out.split('\n').filter(l => l.includes('[迁移]') || l.includes('[MIGRATE]')).slice(-10) });
  }
  return null;
}

/** naming 域分发：配置 → 附属 → legacy-migration */
async function handleNamingGroup(method, pathname, url, req, res, core) {
  return (await handleNamingConfig(method, pathname, url, req, res, core))
    || (await handleNamingSub(method, pathname, url, req, res, core))
    || (await handleNamingMigration(method, pathname, url, req, res, core));
}

/** project scope 路径守卫（防穿越）：scope=host 放行；project 下解析路径须在 base 内，否则 400 */
function guardProjectPath(scope, base, resolved) {
  if (scope === 'host' || resolved === base || resolved.startsWith(base + path.sep)) return null;
  return { detail: 'path escapes project root' };
}

/** filesystem 浏览目录（GET /api/v1/filesystem——任务创建选路径对话框；对齐 openapi browse_filesystem） */
async function handleFsBrowse(method, pathname, url, req, res, core) {
  if (pathname !== '/api/v1/filesystem' || method !== 'GET') return null;
  const scope = url.searchParams.get('scope') || 'project';
  const mode = url.searchParams.get('mode') || 'directory';
  const pathArg = url.searchParams.get('path') || '';
  const search = url.searchParams.get('search') || '';
  const includeHidden = url.searchParams.get('include_hidden') === 'true';
  const base = scope === 'host' ? '/' : (TARGET_PATH || path.sep);
  let dir;
  if (scope !== 'host' && pathArg && pathArg !== '') {
    const resolved = path.resolve(base, pathArg);
    const guard = guardProjectPath(scope, base, resolved);
    if (guard) return json(res, 400, guard);
    dir = resolved;
  } else {
    try { dir = pathArg && pathArg !== '' ? (path.isAbsolute(pathArg) ? pathArg : path.join(base, pathArg)) : base; } catch { dir = base; }
  }
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

/** filesystem 新建/删除文件夹（POST/DELETE /api/v1/filesystem/directories——RemotePathField 路径选择器，前端传 JSON body{scope,parent,name}/{scope,path}） */
async function handleFsDirectories(method, pathname, url, req, res, core) {
  if (pathname !== '/api/v1/filesystem/directories' || (method !== 'POST' && method !== 'DELETE')) return null;
  const body = await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ }));
  const scope = body.scope || 'project';
  const base = scope === 'host' ? '/' : (TARGET_PATH || path.sep);
  if (method === 'POST') { // 新建：{parent, name}（或 {path}）
    const parent = body.parent || path.dirname(body.path || '');
    const name = body.name || path.basename(body.path || '');
    const dir = path.join(parent && path.isAbsolute(parent) ? parent : base, name);
    const resolved = path.resolve(base, dir);
    const guard = guardProjectPath(scope, base, resolved);
    if (guard) return json(res, 400, guard);
    try {
      await fs.promises.mkdir(resolved, { recursive: true });
      // P2-2 补全（2026-09-29 子代理复审）：POST 返回创建的 entry（对齐 FilesystemEntryResponse——前端 RemotePathField 用 entry.path/name 导航；只返回 ok 会导致新建后浏览回根目录）
      let entry = null;
      try {
        const st = await fs.promises.stat(resolved);
        const projRel = scope === 'host' ? null : (resolved === base ? '' : resolved.startsWith(base + path.sep) ? resolved.slice(base.length + 1) : null);
        entry = { name: path.basename(resolved) || resolved, path: resolved, project_relative_path: projRel, kind: 'directory', is_symlink: false, navigable: true, deletable: true };
        void st;
      } catch { /* stat 失败返回空 entry（前端容错） */ }
      return json(res, 201, entry ? { ...entry } : { status: 'created' });
    }
    catch (e) { return json(res, 400, { detail: String(e && e.message || e) }); }
  }
  // DELETE：{path}（或 {scope,parent,name} 组合）
  const delPath = body.path || (body.parent ? path.join(body.parent, body.name || '') : '');
  const dir2 = delPath ? (path.isAbsolute(delPath) ? delPath : path.join(base, delPath)) : base;
  const resolved2 = path.resolve(base, dir2);
  const guard2 = guardProjectPath(scope, base, resolved2);
  if (guard2) return json(res, 400, guard2);
  try { await fs.promises.rmdir(resolved2); return json(res, 200, { ok: true }); } // 只删空目录（防误删非空）
  catch (e) { return json(res, 400, { detail: String(e && e.message || e) }); }
}

/** filesystem 域分发：浏览 → 目录新建/删除 */
async function handleFilesystemGroup(method, pathname, url, req, res, core) {
  return (await handleFsBrowse(method, pathname, url, req, res, core))
    || (await handleFsDirectories(method, pathname, url, req, res, core));
}

/** 任务列表/创建（GET/POST /api/v1/tasks）——创建含 fields/URL/sync 三模式 + 409 去重 + blocked 冲突 */
async function handleTaskListOrCreate(method, pathname, url, req, res, core) {
  if (pathname === '/api/v1/tasks' && method === 'GET') return json(res, 200, core.listTasks().map(taskRecord));
  if (pathname !== '/api/v1/tasks' || method !== 'POST') return null;
  const body = await readBody(req);
  const spec = body.spec || {};
  if (spec.kind && !['download', 'sync'].includes(spec.kind)) return json(res, 400, { detail: `unsupported kind: ${spec.kind}` });
  // 两种创建模式：fields（service/creator_id/post_id）或 URL（spec.post 网页链接——前端 TaskEditor 的 downloadIdentity==="url"）；sync=创作者级全量（spec.creators——自动按作者下载）
  let service = spec.service || null;
  let creatorId = spec.creator_id || null;
  const postId = spec.post_id || null;
  const postUrl = spec.post || null;
  const specCreators = (Array.isArray(spec.creators) ? spec.creators : []).filter(Boolean);
  if (!service && !creatorId && specCreators.length) { // sync 走 spec.creators——前端传对象数组 [{service,creator_id}]（TaskEditor buildSpec）或字符串 "service:creator_id"（API 直建）——都提取首项作执行目标
    const first = specCreators[0];
    if (typeof first === 'object' && first) { service = first.service || null; creatorId = first.creator_id || null; }
    else if (first) { const [s, cid] = String(first).split(':'); service = s || null; creatorId = cid || null; }
  }
  if (!service && !creatorId && postUrl) { // URL 模式：从 post 链接解析 service/creator_id（前端渲染 target 读 spec.service——缺则 toLocaleLowerCase 崩）
    const urlMatch = /pawchive\.pw\/([a-z0-9_-]+)\/user\/([a-z0-9_-]+)/i.exec(postUrl);
    if (urlMatch) { service = urlMatch[1]; creatorId = urlMatch[2]; }
  }
  if (!service && !creatorId && !postUrl && !specCreators.length) return json(res, 400, { detail: 'spec.service/creator_id、spec.creators 或 spec.post(URL) 至少一项' });
  const targetPath = spec.output || core.CONFIG.dataRoot || '';
  if (!targetPath) return json(res, 400, { detail: 'output required（PAWCHIVE_DATA_ROOT 未配置或 spec.output 为空）' });
  // 2026-09-29 创建去重（对齐原版 task_routes.py:73-77 409+current_task_id）：sync 且同 service+creator_id 已有 ACTIVE 任务 → 409（防重复任务并发下载同作者）
  if (spec.kind === 'sync' && service && creatorId) {
    const dup = core.listTasks().map(taskRecord).find(t => core.ACTIVE.has(t.status) && t.spec && t.spec.kind === 'sync' && t.spec.service === service && t.spec.creator_id === creatorId);
    if (dup) return json(res, 409, { detail: '该作者已有任务在运行', current_task_id: dup.id, existing_task_id: dup.id }); // 字段兼容：原版 existing_task_id（task_routes.py:76）+ 前端读 current_task_id
  }
  const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dryrun = !!(spec.dryrun || body.dryrun); // 测试模式：dryrun=1 只生成下载计划不真实落盘（前端/对比脚本测试用——不污染真实数据目录）
  // 2026-09-29 调度器：创建入队（queued）——由调度器按全局并发上限启动；同 service+creator 已有 ACTIVE 非 sync 任务 → blocked + blocked_by（对齐原版 task_scheduler 资源冲突）
  let conflict = null;
  if (service && creatorId) {
    conflict = core.listTasks().map(taskRecord).find(t => core.ACTIVE.has(t.status) && t.id !== taskId && t.spec && t.spec.service === service && String(t.spec.creator_id) === String(creatorId));
  }
  core.createTask({ id: taskId, spec: { kind: spec.kind || 'download', service, creator_id: creatorId, post_id: postId, post: postUrl, output: targetPath, dryrun, creators: (spec.kind === 'sync' && spec.creators) || (spec.kind === 'sync' && service ? [{ service, creator_id: creatorId }] : undefined) } });
  if (conflict) { // 资源冲突 → blocked（阻塞源记录——前端任务列表显示"被阻塞"；调度器在阻塞源结束后自动转 queued 启动）
    core.db.prepare('UPDATE tasks SET status = ?, blocked_by = ?, updated_at = ? WHERE id = ?').run('blocked', conflict.id, new Date().toISOString(), taskId);
  } else {
    core.scheduleTick(); // 无冲突 → 立即触发调度（queued 任务按全局并发上限启动；不空转等 60s tick）
  }
  return json(res, 201, taskRecord(core.getTask(taskId)));
}

/** 单任务详情/删除/编辑（GET/DELETE/PATCH /api/v1/tasks/{task_id}） */
async function handleTaskItem(method, pathname, url, req, res, core) {
  const p = matchPath(pathname, '/api/v1/tasks/{task_id}');
  if (!p) return null;
  const t = core.getTask(p.task_id);
  if (!t) return json(res, 404, { detail: 'task not found' });
  if (method === 'GET') return json(res, 200, taskRecord(t));
  if (method === 'DELETE') { core.abortTask(p.task_id); // 2026-09-29 删除前 abort 下载（真中断——后台不再继续）
    const deleteOutput = url.searchParams.get('delete_output') === 'true' || url.searchParams.get('delete_output') === '1'; // ③ delete outputs：前端删除对话框勾选——只删本任务安全产物（存在+未变）
    let cleanup = null;
    if (deleteOutput) cleanup = core.cleanupTaskArtifacts(p.task_id);
    core.db.prepare('DELETE FROM tasks WHERE id=?').run(p.task_id);
    core.removeTaskArtifacts(p.task_id);
    return json(res, 200, { ok: true, ...(cleanup ? { removable_files: cleanup.removable_files, removable_bytes: cleanup.removable_bytes } : {}) }); }
  if (method === 'PATCH') { const body = await readBody(req).catch(() => ({ /* 读请求体失败返回空对象 */ })); if (body.status) core.updateTaskStatus(p.task_id, body.status);
    if (body.spec) { // P1-2 任务编辑方案 A 修订（2026-09-29 子代理核对）：对齐原版——RUNNING 才拒改（queued/blocked/paused/stopped 可编辑）
      if (t.status === 'running') return json(res, 409, { detail: '任务运行中不可编辑' });
      core.db.prepare('UPDATE tasks SET spec_json = ? WHERE id = ?').run(JSON.stringify(body.spec), p.task_id);
    }
    return json(res, 200, taskRecord(core.getTask(p.task_id))); }
  return json(res, 405, { detail: 'method not allowed' });
}

/** 任务子资源：事件流 / attempts */
async function handleTaskSub(method, pathname, url, req, res, core) {
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
  return null;
}

/** 任务控制动作（run/stop/pause/resume/rerun/cleanup-preview） */
async function handleTaskAction(method, pathname, url, req, res, core) {
  for (const action of ['run', 'stop', 'pause', 'resume', 'rerun', 'cleanup-preview']) {
    const p = matchPath(pathname, `/api/v1/tasks/{task_id}/${action}`);
    if (!p) continue;
    if (action === 'cleanup-preview') { // ③ delete outputs 安全清理预览：只列可安全删除的产物（本任务本次真正落盘、存在、大小未变）——原版 tasks.md:37 preview 语义
      const removable = core.previewTaskArtifacts(p.task_id);
      return json(res, 200, { task_id: p.task_id, artifacts: removable, removable_files: removable.length, removable_bytes: removable.reduce((s, a) => s + a.size, 0) });
    }
    const t = core.getTask(p.task_id);
    if (!t) return json(res, 404, { detail: 'task not found' });
    const map = { run: 'queued', stop: 'stopped', pause: 'paused', resume: 'queued', rerun: 'queued' }; // run/resume 转 queued（调度器启动）；stop/pause 保持终态/暂停
    if (action === 'rerun') { // 真实重跑：清空进度/错误/失败记录 + 旧 attempts（sequence=1 可重建——否则 UNIQUE 冲突）+ revision+1（已存在文件走 hash 去重——不会重复下载）
      core.db.prepare('UPDATE tasks SET progress_json = ?, error = NULL, failure_json = NULL, revision = revision + 1, status = ?, updated_at = ? WHERE id = ?')
        .run('{}', 'queued', new Date().toISOString(), p.task_id);
      core.db.prepare('DELETE FROM task_attempts WHERE task_id = ?').run(p.task_id); // 2026-09-30 rerun bug 修复：旧 attempt(seq=1) 不清 → 重跑 startAttempt(1) UNIQUE 冲突 → 任务卡 running
    } else if (map[action]) {
      core.updateTaskStatus(p.task_id, map[action]);
    }
    if (action === 'stop' || action === 'pause' || action === 'cancel') core.abortTask(p.task_id); // 2026-09-29 真中断：stop/pause/取消级联 abort 下载（cli kill curl——不再删了还在下载）
    if (map[action] === 'queued') core.scheduleTick(); // 入队后立即触发调度（不等 60s tick）
    core.eventStore.publish({ event_type: 'task.progress', task_id: p.task_id, data: { phase: action } });
    return json(res, 200, taskRecord(core.getTask(p.task_id)));
  }
  return null;
}

/** 任务域分发：列表/创建 → 单任务 → 子资源 → 控制动作 → events SSE */
async function handleTasksGroup(method, pathname, url, req, res, core) {
  return (await handleTaskListOrCreate(method, pathname, url, req, res, core))
    || (await handleTaskItem(method, pathname, url, req, res, core))
    || (await handleTaskSub(method, pathname, url, req, res, core))
    || (await handleTaskAction(method, pathname, url, req, res, core))
    || (pathname === '/api/v1/events' && method === 'GET' ? (sseStream(req, res, core), undefined) : undefined);
}

async function handle(method, pathname, url, req, res, core) {
  const group =
    pathname.startsWith('/api/v1/tasks') || pathname === '/api/v1/events' ? handleTasksGroup(method, pathname, url, req, res, core)
    : pathname.startsWith('/api/v1/naming') ? handleNamingGroup(method, pathname, url, req, res, core)
    : pathname.startsWith('/api/v1/config') ? handleConfigGroup(method, pathname, url, req, res, core)
    : pathname.startsWith('/api/v1/creators') ? handleCreatorsGroup(method, pathname, url, req, res, core)
    : pathname.startsWith('/api/v1/filesystem') ? handleFilesystemGroup(method, pathname, url, req, res, core)
    : (pathname.startsWith('/api/v1/auto-sync') || pathname.startsWith('/api/v1/pawchive') || pathname === '/api/v1/blockers' || pathname === '/api/v1/posts') ? handleAutoSyncPawchiveGroup(method, pathname, url, req, res, core)
    : handleMiscGroup(method, pathname, url, req, res, core);
  return group;
}

module.exports = { handle };
