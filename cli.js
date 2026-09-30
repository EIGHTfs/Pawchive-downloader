#!/usr/bin/env node
/**
 * Pawchive 最小下载 CLI（零依赖，Node 18+ 全局 fetch）
 *
 * 功能：指定 Pawchive 页面 URL（创作者页 / 单帖页）与下载路径，拉取 API 并下载全部文件。
 *   特性：--dryrun 只列计划不写盘；拉取索引每页落盘、断点续拉（中断重跑不重复翻页）；
 *         查重跳过已有文件；.tmp 断点续传；429/5xx 自动重试；串行 TPS 限速。
 *
 * 用法：
 *   node cli.js <url> <path> [--dryrun] [--offset N] [--length N] [--concurrency N] [--index <索引文件>]
 *   --length N       只拉/下载最新 N 个帖子（如 --length 10 = 最新 10 帖）
 *   --offset N       从第 N 个帖子开始（配合 --length 分批）
 *   --concurrency N  并发下载数（默认 1 串行，受 TPS 限速约束），如 --concurrency 3
 *   --index <文件>   直接读已有索引文件（.pawchive/*.index.json）生成计划下载，0 API 请求
 *   例：node cli.js https://pawchive.pw/patreon/user/96944064 "/volume1/VirtualDSM/(Pawchive)/Pawchive" --dryrun
 *   例：node cli.js https://pawchive.pw/patreon/user/96944064 "/volume1/VirtualDSM/(Pawchive)/Pawchive" --length 10
 *   真实下载显示实时进度条（终端 TTY）：整体 N/M 文件数 + 百分比 + 总速度 + 当前文件进度/速度；
 *   非终端（管道/日志重定向）自动降级为逐行状态输出（同 gbmd/iwara/KToolBox 的 plain 模式）。
 *   索引：每次分页拉取都原子落盘到 <path>/.pawchive/<service>-<userId>.index.json，
 *         下次运行直接复用缓存并从游标继续，不用重新翻页。
 *
 * 可配置项（环境变量覆盖）
 *   PAWCHIVE_API_BASE     API 地址      默认 https://pawchive.pw/api/v1
 *   PAWCHIVE_FILES_BASE   文件 host     默认 https://file.pawchive.pw
 *   PAWCHIVE_FILES_PREFIX 文件路径前缀  默认 /data
 *   PAWCHIVE_TPS          每秒连接数    默认 1（反爬：file host 明示 ≤1 req/s）
 *   PAWCHIVE_RETRY_TIMES  下载重试次数  默认 10
 *
 * 命名模板（环境变量，详见 README「命名模板」）：
 *   PAWCHIVE_CREATOR_DIR_FORMAT  可用 {creator_name} {creator_id} {service}
 *   PAWCHIVE_POST_DIR_FORMAT     可用 {title} {post_id} {service} {creator_id} {published} {added}
 *   PAWCHIVE_FILENAME_FORMAT     {} 表示原文件名，可组合如 "[{published}]_{}"
 *   默认 = 纯作者名 / 纯标题 / 原名（与现有下载目录风格一致，可随时换模板不动旧数据）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto'); // 网盘文件内容 hash（跨帖去重键）

// ---------- .env 加载（可选，零依赖：同目录 .env 存在则解析 KEY=VALUE 注入 process.env；已有环境变量优先） ----------
(() => {
  try {
    const content = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const envVal = m[2].replace(/^['"]|['"]$/g, ''); // 去首尾引号
      if (!(m[1] in process.env)) process.env[m[1]] = envVal; // 不覆盖已设置的环境变量
    }
  } catch { /* 无 .env 或不可读则跳过（纯 env 亦可运行） */ }
})();

// ---------- 配置（全部读环境变量 PAWCHIVE_*，无外置配置文件；默认与 KToolBox Python 一致） ----------
const CONFIG = {
  apiBase: process.env.PAWCHIVE_API_BASE || 'https://pawchive.pw/api/v1',
  filesBase: process.env.PAWCHIVE_FILES_BASE || 'https://file.pawchive.pw',
  thumbBase: process.env.PAWCHIVE_THUMB_BASE || 'https://img.pawchive.pw/thumbnail', // 原图 404 时缩略图回退 base（img host /thumbnail 前缀）
  filePathPrefix: process.env.PAWCHIVE_FILES_PREFIX || '/data',
  pageSize: 50,               // API 每页帖子数（SEARCH_STEP）
  pageIntervalMs: Number(process.env.PAWCHIVE_PAGE_INTERVAL_MS) || 1000, // 列表翻页间隔（防反爬）
  apiTimeoutMs: 30000,        // API 请求超时（首次响应可能 9s+）
  apiRetryTimes: 3,           // API 请求重试次数
  apiRetryIntervalMs: 2000,   // API 重试间隔
  apiRetryStatus: [429, 500, 502, 503, 504], // 可重试的 HTTP 状态
  downloadTimeoutMs: 300000,  // 单文件下载超时（5 分钟）
  tempSuffix: process.env.PAWCHIVE_TEMP_SUFFIX || '.tmp', // 断点续传临时文件后缀（env 可配）
  strictVerify: process.env.PAWCHIVE_STRICT_VERIFY === '1', // 强校验模式（默认关）：下载完计算本地 sha256 vs 目标 serverPath hash——不符优先修复（重下）不保留坏文件

  // 命名模板（env 可配；默认纯作者名 / 纯标题 / 原名）
  creatorDirFormat: process.env.PAWCHIVE_CREATOR_DIR_FORMAT || '{creator_name}',
  postDirFormat: process.env.PAWCHIVE_POST_DIR_FORMAT || '{title}',
  fileFormat: process.env.PAWCHIVE_FILENAME_FORMAT || '{}',
  indexFilename: process.env.PAWCHIVE_INDEX_FILENAME || 'pawchive-index.html',
  creatorPrefixFormat: process.env.PAWCHIVE_CREATOR_PREFIX_FORMAT || '({service}) ', // 大小写冲突时目录前缀模板（可用 {service}）
  filenameSuffixFormat: process.env.PAWCHIVE_FILENAME_SUFFIX_FORMAT || '_{size}', // 同帖内同名不同内容文件的后缀模板（{size}=文件大小字节，无大小退序号；放扩展名前）

  // 下载 UA（可配；file host 反爬要求「可识别 UA」）
  userAgent: process.env.PAWCHIVE_USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',

  // 下载参数（env；默认 TPS=1 匹配 file host 明示 ≤1 req/s）
  tps: Number(process.env.PAWCHIVE_TPS) || 1,
  downloadRetryTimes: Number(process.env.PAWCHIVE_RETRY_TIMES) || 10,
  downloadRetryIntervalMs: Number(process.env.PAWCHIVE_RETRY_INTERVAL_MS) || 3000,
  slowSpeedKb: Number(process.env.PAWCHIVE_SLOW_SPEED_KB) || 5,
  slowDetectMs: Number(process.env.PAWCHIVE_SLOW_DETECT_MS) || 10000,
  slowWaitMs: Number(process.env.PAWCHIVE_SLOW_WAIT_MS) || 60000,
  slowMax: Number(process.env.PAWCHIVE_SLOW_MAX) || 3,
  dataRoot: process.env.PAWCHIVE_DATA_ROOT || '',
  // 附件子目录：env 里空 / "." / "/" 三者等价 = 帖根目录（不建子目录）；设 attachments 等可配
  attachmentsSubdir: ((v) => (v && v !== '.' && v !== '/' ? v : ''))(process.env.PAWCHIVE_ATTACHMENTS_SUBDIR || ''),
  downloadDrive: process.env.PAWCHIVE_DOWNLOAD_DRIVE !== '0', // 下载正文里的 Google Drive 网盘链接（默认开；'0'=关）
  fastSkip: process.env.PAWCHIVE_FAST_SKIP === '1', // 用户级 html 快速跳过已完整帖（默认关——历史帖全量 getPost 检查，补漏录的外链/网盘）
  includeRevisions: process.env.PAWCHIVE_INCLUDE_REVISIONS !== '0', // 下载帖子修订版本（默认开——内容 sha256 硬链接去重不占额外空间；'0'=关；参考原版 include_revisions：每修订版下到 帖目录/<revisionsSubdir>/<revision_id>/）
  writeCreatorIndex: true, // 创作者级 pawchive-index.html 写入：强制启用（pawchive-index.html 决定去重/网盘下载功能，不提供关闭）；PAWCHIVE_WRITE_CREATOR_INDEX 仅供上层读取写入状态
  revisionsSubdir: process.env.PAWCHIVE_REVISIONS_SUBDIR || 'revisions', // 修订版本子目录名（默认 'revisions'——原版 post_structure.revisions 同源；naming 响应/下载共用）
  webBase: process.env.PAWCHIVE_WEB_BASE || 'https://pawchive.pw', // 网页基址（原链接/创作者页 href）
  antibotSize: Number(process.env.PAWCHIVE_ANTIBOT_SIZE) || 376, // 反爬占位大小（file host bot 提示字节特征）
  http404PageMax: Number(process.env.PAWCHIVE_404_PAGE_MAX) || 4096, // 404/错误页判定：小于此大小才读头部判断
  curlConnectTimeout: Number(process.env.PAWCHIVE_CURL_CONNECT_TIMEOUT) || 30, // curl 连接超时秒（下载与流式请求统一）
};

// ---------- curl 可执行文件探测（Alpine/BusyBox/NAS 路径不一，不硬编码 /bin/curl；PAWCHIVE_CURL 可显式指定） ----------
const CURL_BIN = (() => {
  const candidates = [process.env.PAWCHIVE_CURL, '/usr/bin/curl', '/usr/local/bin/curl', '/bin/curl', 'curl'];
  for (const c of candidates) {
    if (!c) continue;
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* 下一个候选 */ }
  }
  return 'curl'; // 兜底走 PATH（spawn 找不到时显式报错，不静默）
})();

// ---------- 孤儿下载进程防护（spawn 的 curl 不随父进程退出而终止） ----------
const activeCurls = new Set(); // 全局跟踪运行中的 curl 子进程
/** 注册 curl 子进程（spawn 后调用）——close/error 时自动移除 */
function trackCurl(p) {
  activeCurls.add(p);
  const untrack = () => activeCurls.delete(p);
  p.on('close', untrack);
  p.on('error', untrack);
  return p;
}
/** 统一终止所有运行中的 curl（进程退出/信号时调用——覆盖父进程死亡场景，防孤儿下载） */
function killAllCurls() {
  for (const p of activeCurls) { try { p.kill('SIGTERM'); } catch { /* 已退出 */ } }
}
// 父进程退出/被杀信号 → 立即 kill 全部 curl（正常 stop/重启场景；kill -9 无法拦截由 server 启动清扫兜底）
process.on('exit', killAllCurls);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { killAllCurls(); process.exit(0); });

// ---------- 日志（ISO 时间 + 事件；下载/迁移共用，migrate.js 复用） ----------
const LOG_PATH = process.env.PAWCHIVE_LOG || path.join(__dirname, 'pawchive.log');
function log(event) {
  try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${event}\n`, 'utf8'); }
  catch { /* 日志写入失败不阻塞主流程 */ }
}

// ---------- URL 解析（照抄 KToolBox parse_webpage_url 逻辑） ----------
// /patreon/user/96944064            → service=patreon  user=96944064
// /fanbox/user/6570768/post/1836570 → 另含 post_id=1836570
function parseWebpageUrl(url) {
  // 2026-09-29：相对路径自动补全域名（用户输入 patreon/user/49965584 不带协议/主机——拼 webBase 避免 new URL Invalid）
  let u = String(url || '').trim();
  if (u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `${CONFIG.webBase}/${u.replace(/^\/+/, '')}`;
  const parts = new URL(u).pathname.split('/').filter(Boolean);
  const service = parts[0] || null;
  const userId = parts[1] === 'user' ? parts[2] || null : null;
  const postId = parts[3] === 'post' ? parts[4] || null : null;
  return { service, userId, postId };
}

// ---------- 文件名消毒（同 pathvalidate.sanitize_filename：替换非法字符） ----------
function sanitizeName(name, isDir = false) {
  let out = String(name || '')
    // 替换 Windows/Unix 非法字符；标题里的空格保留（现有目录标题带空格）
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, ''); // 结尾的点/空格（Windows 不允许）
  // 字节级截断（文件系统 NAME_MAX=255 字节——日文等多字节标题按字符 slice(0,200) 会超字节限制 → ENAMETOOLONG；Buffer 200 字节安全）
  const b = Buffer.from(out);
  if (b.length > 200) out = b.subarray(0, 200).toString('utf8').replace(/\uFFFD/g, '') || out.slice(0, 60);
  if (!out) out = isDir ? 'untitled' : 'file';
  return out.slice(0, 200);
}

// ---------- 命名模板渲染（对应 KToolBox 命名配置） ----------
/**
 * 渲染命名模板。
 * @param tpl       模板字符串，含 {变量} 或裸 {}（表示基本文件名/原文件名）
 * @param values    {key: value} 变量表
 * @param basicName 基本文件名（裸 {} 的替换值；不需要时可传 null）
 */
function renderTemplate(tpl, values, basicName = null) {
  let s = String(tpl);
  if (basicName !== null && s.includes('{}')) s = s.replace(/\{\}/g, basicName);
  s = s.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, k) => (k in values ? String(values[k]) : m));
  return s;
}

/** 帖子级模板变量表（published/added 取日期部分 YYYY-MM-DD） */
function postTemplateValues(post, extra = {}) {
  const fmt = d => (d ? String(d).slice(0, 10) : '');
  return {
    title: post.title || '',
    post_id: String(post.id || ''),
    // service/creator_id 不在列表帖内（索引文件名承载）；由调用方（finalizePlan 有 plan.service/userId）注入
    service: (extra.service ?? post.service) || '',
    creator_id: (extra.creator_id ?? post.user) || '',
    published: fmt(post.published),
    added: fmt(post.added),
  };
}

/** 文件名应用 filename_format 模板（basicName 含后缀；后缀保留在末尾，KToolBox generate_filename 同款） */
function applyFilenameFormat(post, basicName) {
  const parsed = path.posix.parse(basicName);
  const rendered = renderTemplate(CONFIG.fileFormat, postTemplateValues(post), parsed.name);
  const out = sanitizeName(rendered + parsed.ext);
  return out || basicName;
}

// ---------- Pawchive API client（fetch 封装 + 重试） ----------
async function apiRequest(method, pathname, params = {}) {
  // 注意：new URL(pathname, base) 在 pathname 以 "/" 开头时会覆盖 base 的路径（丢掉 /api/v1），
  // 所以手动拼接：base(去尾斜杠) + "/" 开头的 pathname
  const url = new URL(CONFIG.apiBase.replace(/\/+$/, '') + pathname);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  let lastErr;
  for (let attempt = 0; attempt <= CONFIG.apiRetryTimes; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CONFIG.apiTimeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: 'application/json' },
        signal: ctl.signal,
      });
      if (CONFIG.apiRetryStatus.includes(res.status) && attempt < CONFIG.apiRetryTimes) {
        await sleep(CONFIG.apiRetryIntervalMs);
        continue;
      }
      if (!res.ok) throw new Error(`API ${res.status} ${url.pathname}: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < CONFIG.apiRetryTimes) { await sleep(CONFIG.apiRetryIntervalMs); continue; }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('apiRequest failed');
}

const getCreatorProfile = (service, userId) =>
  apiRequest('GET', `/${service}/user/${encodeURIComponent(userId)}/profile`);

const listCreatorPosts = (service, userId, offset) =>
  // Pawchive 分页参数是 o（实测 o=0/50/100 返回不同页，stepping of 50 enforced），每页最多 50 条
  apiRequest('GET', `/${service}/user/${encodeURIComponent(userId)}`, { o: offset });

const getPost = (service, userId, postId) =>
  apiRequest('GET', `/${service}/user/${encodeURIComponent(userId)}/post/${encodeURIComponent(postId)}`);

/** 拉取帖子修订版本列表（Pawchive API /revisions——参考原版 list_post_revisions；Revision = Post + revision_id） */
const fetchPostRevisions = (service, userId, postId) =>
  apiRequest('GET', `/${service}/user/${encodeURIComponent(userId)}/post/${encodeURIComponent(postId)}/revisions`)
    .then(r => (Array.isArray(r) ? r : []))
    .catch(() => []); // 无修订/404 → 空列表（对齐原版 PawchiveNotFoundError 跳过）

// ---------- 创作者全量列表（搜索用——Pawchive /creators 15MB 全量，缓存 .pawchive/creators-cache.json + TTL） ----------
let creatorsCache = { ts: 0, data: null }; // 进程内缓存（避免多次拉 15MB）
/** 拉取全部创作者（对齐原版 list_creators——全量缓存，TTL PAWCHIVE_CREATORS_TTL_DAY 默认 7 天；独立 fetch 长超时 120s 拉 15MB——失败返回 null 由调用方降级） */
const fetchAllCreators = async (targetPath = '') => {
  const ttl = (Number(process.env.PAWCHIVE_CREATORS_TTL_DAY) || 7) * 24 * 3600 * 1000;
  const now = Date.now();
  if (creatorsCache.data && now - creatorsCache.ts < ttl) return creatorsCache.data;
  if (targetPath) { // 文件缓存（跨进程/重启复用——15MB 落 .pawchive gitignore 目录）
    try {
      const fp = path.join(targetPath, '.pawchive', 'creators-cache.json');
      if (fs.existsSync(fp)) {
        const cached = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (Array.isArray(cached.data) && now - cached.ts < ttl) { creatorsCache = cached; return cached.data; }
      }
    } catch { /* 缓存损坏按重拉 */ }
  }
  let data = null;
  try { // 独立 fetch（apiRequest 默认 30s 超时不够 15MB——长超时 120s）
    const url = CONFIG.apiBase.replace(/\/+$/, '') + '/creators';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok) data = await res.json();
  } catch { /* 拉取失败降级 null（搜索返回空） */ }
  if (Array.isArray(data)) {
    creatorsCache = { ts: now, data };
    if (targetPath) {
      try {
        const fp = path.join(targetPath, '.pawchive', 'creators-cache.json');
        await fs.promises.mkdir(path.dirname(fp), { recursive: true });
        await fs.promises.writeFile(fp, JSON.stringify({ ts: now, data }), 'utf8');
      } catch { /* 缓存写失败不影响搜索 */ }
    }
  }
  return data;
};

// ---------- 拉取索引（每页落盘、断点续拉） ----------
/** 索引文件路径：<目标路径>/.pawchive/<service>-<userId>.index.json */
function indexFileFor(targetPath, service, userId) {
  return path.join(targetPath, '.pawchive', `${service}-${userId}.index.json`);
}

/** 帖子精简为索引所需字段（只保留链接级：id/标题/时间；去掉 content/embed/file/attachments）
 *  按作者拉取时只解析帖子链接，完整内容（file/attachments）下载到该帖时才 getPost 按需解析。
 *  旧缓存索引若已含 file/attachments，downloadOnePost 会直接复用（兼容）。 */
function slimPost(p) {
  // 只留帖子链接级字段；user/service 由索引文件名（<service>-<userId>.index.json）承载，每帖重复冗余
  return {
    id: p.id, title: p.title ?? null,
    published: p.published ?? null, added: p.added ?? null,
  };
}

/** 读索引；缺失/损坏返回 null（视为无缓存，从头拉） */
function loadIndex(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.posts) && typeof j.next_offset === 'number') return j;
  } catch { /* 缺失或损坏 = 无索引 */ }
  return null;
}

/** 原子写索引（先写 .tmp 再 rename，防止写一半崩溃导致索引损坏） */
async function saveIndex(file, index) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmpPath = `${file}${CONFIG.tempSuffix}`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(index));
  await fs.promises.rename(tmpPath, file);
}

/**
 * 分页拉取某创作者帖子，带本地索引断点续拉：
 * - 每成功拉一页立即把「全部已拉帖子(精简) + 游标 next_offset」原子落盘；
 * - 重跑时先读索引：缓存已覆盖本次需求（offset+length）或已 done 则 0 API 直接复用；
 * - 否则从游标继续翻页，中断后再次运行只补拉缺的页。
 * @returns {{posts: Array, fetchedNew: number, done: boolean, indexFile: string|null}}
 */
async function fetchPostsWithResume(service, userId, { offset = 0, length, indexFile = null, creatorName = null } = {}) {
  const saved = indexFile ? loadIndex(indexFile) : null;
  // 旧索引缺 creator_name 时补写一次（仅 URL 模式知道名字；让 --index 模式能还原创作者目录名）
  if (saved && creatorName && !saved.creator_name && indexFile) {
    await saveIndex(indexFile, { ...saved, creator_name: creatorName }).catch(() => {});
  }
  const posts = saved ? saved.posts : [];       // 已缓存（从最新排到旧）
  const cachedTotal = posts.length;             // 复用前缓存总数（统计用）
  let nextOffset = saved ? saved.next_offset : 0;
  let done = saved ? !!saved.done : false;
  let fetchedNew = 0;
  const need = length !== undefined ? offset + length : undefined; // 需要的条数（含 offset 起点）

  // 缓存已覆盖需求 → 直接复用，但 done=true（全量拉完）后作者可能发新帖：拉最新一页校验
  if (done || (need !== undefined && posts.length >= need)) {
    if (done && posts.length) {
      try {
        const newest = await listCreatorPosts(service, userId, 0); // 最新一页（1 个请求）
        if (newest.length && String(newest[0].id) !== String(posts[0].id)) {
          log(`[索引] 作者有更新（缓存最新帖 ${posts[0].id} ≠ 源站 ${newest[0].id}），重新拉取`);
          done = false; nextOffset = 0; posts = []; // 失效：从头续拉
        }
      } catch { /* 校验失败：复用缓存，不阻塞 */ }
    }
    if (done) {
      const sliced = need !== undefined ? posts.slice(offset, need) : posts;
      return { posts: sliced, fetchedNew: 0, done, indexFile, cachedTotal };
    }
    // 有更新（done 失效）：posts 已清空，落入下方续拉循环从头拉取
  }

  // 续拉：从游标继续翻页，每页立即落盘
  for (;;) {
    if (need !== undefined && posts.length >= need) break;
    const page = await listCreatorPosts(service, userId, nextOffset);
    if (!Array.isArray(page) || page.length === 0) { done = true; break; } // 拉完了
    for (const p of page) posts.push(slimPost(p));
    nextOffset += page.length;
    fetchedNew += page.length;
    // 每页落盘一次：中断后下次从 nextOffset 续拉（creator_name 供 --index 模式还原创作者目录名）
    if (indexFile) await saveIndex(indexFile, { service, userId, creator_name: creatorName, posts, next_offset: nextOffset, done });
    if (page.length < CONFIG.pageSize) { done = true; break; } // 最后一页
    await sleep(CONFIG.pageIntervalMs); // 防反爬：页间间隔（列表翻页连发同样会触发 API 限流）
  }
  if (indexFile && (done || (need !== undefined && posts.length >= need))) {
    await saveIndex(indexFile, { service, userId, creator_name: creatorName, posts, next_offset: nextOffset, done });
  }
  const sliced = need !== undefined ? posts.slice(offset, need) : posts;
  return { posts: sliced, fetchedNew, done, indexFile, cachedTotal };
}

// ---------- 文件 URL 构造（照抄 get_file_url：文件 host + /data 前缀 + server_path） ----------
// server_path 形如 /25/b5/25b525....png（hash 分段）；最终 https://file.pawchive.pw/data/25/b5/....png
function getFileUrl(serverPath) {
  const host = CONFIG.filesBase.replace(/\/+$/, ''); // 纯文件 host：https://file.pawchive.pw
  const qi = serverPath.indexOf('?');
  const query = qi >= 0 ? serverPath.slice(qi) : '';
  let p = qi >= 0 ? serverPath.slice(0, qi) : serverPath;
  if (!p.startsWith('/')) p = `/${p}`;
  // server_path 通常不含 /data 前缀；已含则不重复加（KToolBox get_file_url 同款判断）
  if (p !== CONFIG.filePathPrefix && !p.startsWith(`${CONFIG.filePathPrefix}/`)) {
    p = `${CONFIG.filePathPrefix}${p}`;
  }
  return `${host}${p}${query}`;
}

/** 安全 decodeURIComponent：畸形百分号编码（如 %）返回原串，不抛 URIError */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 由 FileReference 生成文件名：优先 name 字段，否则取 path 末段（safeDecode 防畸形 URI） */
function referenceFilename(ref) {
  if (ref && ref.name) return sanitizeName(safeDecode(path.posix.basename(ref.name)));
  if (ref && ref.path) return sanitizeName(safeDecode(path.posix.basename(ref.path.split('?')[0])));
  return null;
}

// ---------- 任务计划生成 ----------
/**
 * 为单个帖子生成下载任务列表
 * @returns {{fileUrl, savePath, filename, serverPath}[]}
 */
function planPostFiles(post, postDir) {
  const jobs = [];
  const seen = new Set(); // 帖内 serverPath 去重：API 偶发 file 与 attachments 指向同一 hash（曾导致 dryrun 重复展示同一文件）
  const usedNames = new Set(); // 帖目录内已用文件名：同名不同内容（不同 hash）时按后缀模板加后缀，防互相覆盖
  const suffixTpl = CONFIG.filenameSuffixFormat; // env：默认 '_{size}'（{size}=文件大小，无大小退序号 {n}；放扩展名前）
  const uniqueName = (name, size) => {
    if (!usedNames.has(name)) { usedNames.add(name); return name; }
    const ext = path.extname(name);
    const base = path.posix.basename(name, ext);
    const suffixFor = n => {
      if (suffixTpl.includes('{size}')) return suffixTpl.replace('{size}', size != null ? String(size) : String(n)); // 无 size 时退序号
      return suffixTpl.replace('{n}', n);
    };
    let n = 2, cand;
    do { cand = `${base}${suffixFor(n)}${ext}`; n++; } while (usedNames.has(cand));
    usedNames.add(cand);
    return cand;
  };
  let seq = 0; // 函数内兜底序号（统一替代原全局 planPostFiles._seq）
  const fallback = n => sanitizeName(n) || 'file';
  const sub = CONFIG.attachmentsSubdir ? sanitizeName(CONFIG.attachmentsSubdir) : ''; // 附件子目录（PAWCHIVE_ATTACHMENTS_SUBDIR，默认空=帖根目录；同名同 hash 时第二个被已存在/去重跳过）
  // 附件（默认与主文件同目录=帖根目录；可配子目录如 attachments/）
  for (const att of post.attachments || []) {
    if (!att || !att.path || seen.has(att.path)) continue;
    seen.add(att.path);
    const base = referenceFilename(att) || `${++seq}.bin`;
    const filename = uniqueName(applyFilenameFormat(post, base) || fallback(base)); // 同名不同 hash → 自动加后缀
    jobs.push({
      fileUrl: getFileUrl(att.path),
      serverPath: att.path,
      filename,
      savePath: sub ? path.join(postDir, sub, filename) : path.join(postDir, filename),
      apiSize: Number(att.size) || null, // API 返回的 size（实测常为 null；有值时替代探测作大小基准）
    });
  }
  // 主文件（封面，放帖子目录），真实原名
  if (post.file && post.file.path) {
    if (seen.has(post.file.path)) return jobs; // 主文件与某附件同 hash：附件项已入队，跳过重复
    seen.add(post.file.path);
    const base = referenceFilename(post.file) || `${++seq}.bin`;
    const filename = uniqueName(applyFilenameFormat(post, base) || fallback(base));
    jobs.push({
      fileUrl: getFileUrl(post.file.path),
      serverPath: post.file.path,
      filename,
      savePath: path.join(postDir, filename),
      apiSize: Number(post.file.size) || null, // API 返回的 size（实测常为 null；有值时替代探测作大小基准）
    });
  }
  return jobs;
}

/**
 * 【按作者/按单帖获取帖子数组】解析 Pawchive URL → 帖子数组 + 创作者元信息。
 * 按作者下载 = 拉作者全部分页帖子（索引断点续拉，重跑复用缓存）返回数组；
 * 按单帖下载 = 单元素数组。返回 {posts, meta}，统一交给 downloadAuthor / downloadOnePost（按帖下载）。
 */
async function fetchPostsByUrl(url, targetPath, { offset = 0, length } = {}) {
  const { service, userId, postId } = parseWebpageUrl(url);
  if (!service || !userId) throw new Error(`无法从 URL 解析 service/user：${url}`);
  // 同作者跨渠道/同平台分号关联（方案 D：Akt / AnimationAkt_SP / akt 三号一人的场景就靠它识别）
  const links = await apiRequest('GET', `/${service}/user/${encodeURIComponent(userId)}/links`).catch(() => []);
  if (postId) {
    // 按单帖：posts = [该帖]（单帖模式也拉 creator profile 拿作者名，否则目录退化为裸 id，如 96944064/）
    const post = await getPost(service, userId, postId);
    const profile = await getCreatorProfile(service, userId).catch(() => null);
    return {
      posts: [post],
      meta: {
        mode: 'post', service, userId, postId,
        creatorName: (profile && profile.name) || post.user || userId,
        links,
      },
    };
  }
  // 按作者：拉作者全部帖子数组（索引断点续拉，每页落盘，重跑复用缓存）
  const profile = await getCreatorProfile(service, userId).catch(() => null);
  const creatorName = (profile && profile.name) || userId;
  const indexFile = indexFileFor(targetPath, service, userId);
  const { posts, fetchedNew, done, cachedTotal } = await fetchPostsWithResume(service, userId, {
    offset, length, indexFile, creatorName,
  });
  return {
    posts,
    meta: {
      mode: 'creator', service, userId, postId: null,
      creatorName, links, indexFile, fetchedNew, cachedTotal, indexDone: done,
    },
  };
}

/**
 * 大小写冲突唯一化：若 targetPath 顶层已存在「大小写不敏感同名、但大小写不同」的目录
 * （如已有 akt、本次 Akt），则本次目录加「(平台) 」前缀（Akt → (patreon) Akt），
 * 兼容 Windows/macOS/网盘等大小写不敏感文件系统，避免两目录互踩覆盖。
 * 已存在的旧目录不改名（改名牵连已下载文件路径，风险大）；新生成的加前缀保证唯一。
 */
async function ensureUniqueCreatorDir(creatorDir, targetPath, service) {
  const base = path.basename(creatorDir);
  const lower = base.toLowerCase();
  try {
    const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
    // 只处理「纯大小写不同」冲突：存在同名不同大小写目录才加前缀（前缀格式读 env：PAWCHIVE_CREATOR_PREFIX_FORMAT）。
    // 加前缀后的目录若已存在（前次冲突产物）直接复用同名目录——下载按文件级去重，不会覆盖已有内容。
    const caseClash = entries.some(ent => ent.isDirectory() && ent.name.toLowerCase() === lower && ent.name !== base);
    if (caseClash) {
      const prefix = renderTemplate(CONFIG.creatorPrefixFormat, { service, creator_name: base });
      return path.join(path.dirname(creatorDir), `${prefix}${base}`);
    }
  } catch { /* 目标不可读时返回原名 */ }
  return creatorDir;
}

/** 把帖子转成目录结构计划（creatorDir = <路径>/<创作者目录模板渲染，冲突自动加平台前缀>） */
async function finalizePlan(plan, targetPath) {
  // 创作者目录名：模板渲染，空则回退 creator_id；大小写冲突时自动加 "(平台) " 前缀
  const baseName = sanitizeName(renderTemplate(CONFIG.creatorDirFormat, {
    creator_name: plan.creatorName || plan.userId, // creatorName null 时兜底 userId（防模板渲染成 "null" 目录）
    creator_id: plan.userId,
    service: plan.service,
  }), true) || plan.userId;
  const creatorDir = await ensureUniqueCreatorDir(path.join(targetPath, baseName), targetPath, plan.service);
  plan.creatorDir = creatorDir;
  const files = [];
  plan.posts.forEach((post, idx) => {
    // 帖子目录名：post_dirname_format 模板渲染，空则回退 post_id（service/creator_id 由 plan 注入，列表帖无冗余字段）
    const title = sanitizeName(renderTemplate(CONFIG.postDirFormat, postTemplateValues(post, { service: plan.service, creator_id: plan.userId })), true)
      || String(post.id || idx + 1);
    const postDir = path.join(creatorDir, title);
    // 文件计划惰性化：列表帖子轻量（slimPost 已去 file/attachments）→ 不预生成，
    // 由 downloadOnePost 每帖按需 getPost 详情后生成；旧缓存索引带 file/attachments 时仍预生成（兼容）。
    if (post.file || (post.attachments && post.attachments.length)) {
      const postJobs = planPostFiles(post, postDir).map(j => ({ ...j, post, postDir }));
      files.push(...postJobs);
    }
  });
  plan.files = files;
  plan.postDirByPost = plan.posts.map(post =>
    path.join(creatorDir, sanitizeName(renderTemplate(CONFIG.postDirFormat, postTemplateValues(post, { service: plan.service, creator_id: plan.userId })), true)
      || String(post.id)));
  return plan;
}

/** 检查目标文件是否存在（stat 成功即存在；0 字节文件也算存在——修复原「size>0 才存在」导致空文件无限重下） */
async function fileExists(filePath) {
  try {
    await fs.promises.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------- 下载器（含查重、断点续传、重试、TPS） ----------
let lastRequestAt = 0; // 全局 TPS 节流：串行下载时控制每秒连接数
async function tpsGate() {
  const slotMs = 1000 / CONFIG.tps;
  const now = Date.now();
  const waitMs = Math.max(0, lastRequestAt + slotMs - now);
  lastRequestAt = now + waitMs;
  if (waitMs > 0) await sleep(waitMs);
}

/** 从 -D - 头文本解析文件总大小（同 KToolBox downloader：优先 Content-Range 的 / 后值——206 续传时 Content-Length 只是剩余量；无则 Content-Length——200 全量响应；-L 多响应取最后一个） */
function parseContentLength(headerText) {
  let len = null;
  let m;
  const crRe = /^Content-Range:\s*bytes\s+\d+-\d+\/(\d+)/gim;
  while ((m = crRe.exec(headerText)) !== null) len = Number(m[1]);
  if (len != null) return len;
  const clRe = /^Content-Length:\s*(\d+)/gim;
  while ((m = clRe.exec(headerText)) !== null) len = Number(m[1]);
  return len;
}

/** 从 -D - 头文本解析 Content-Disposition 原始文件名（Google Drive 直链等）；解析失败返回 null */
function parseContentDisposition(headerText) {
  const m = /^Content-Disposition:\s*(?:attachment|inline);\s*filename="?([^";]+)"?/gim.exec(headerText || '');
  return m ? m[1] : null;
}

/** 计算文件内容 sha256（网盘文件跨帖去重键：同内容同 hash，不同 Drive ID 的同文件也能复用） */
function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', c => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/** 从链接提取 Google Drive 文件 ID：drive.google.com/file/d/<ID>/ 或 open?id=<ID>；非 drive 链接返回 null */
function driveIdOf(url) {
  const m = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/.exec(url) || /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/.exec(url);
  return m ? m[1] : null;
}

// ============ 网盘下载模块（可扩展：新增网盘类型只需注册一个 provider） ============
/** 网盘 provider 注册表：{ match(正文识别), extract(链接→文件ID), downloadUrl(ID→直链), key(ID→去重键前缀) }
 * 去重键：内容 sha256 → `<type>:<hash>`（跨帖同内容复用）；ID 键 → `<type>Id:<ID>`（同链接复用）。 */
const NETDISK_PROVIDERS = {
  drive: {
    match: /drive\.google\.com\/(?:file\/d\/[a-zA-Z0-9_-]+|open\?id=[a-zA-Z0-9_-]+)/,
    extract: driveIdOf,
    downloadUrl: id => `https://drive.usercontent.google.com/download?id=${id}&export=download`,
    share: id => `https://drive.google.com/file/d/${id}/view`, // 记录/复用用完整分享 URL（与正文链接同构）
    key: id => `drive:${id}`,
  },
  // Dropbox：分享链接（scl/fi 新格式或 s/ 旧格式）→ dl=1 强制下载（最终 host dl.dropboxusercontent.com 支持 Range 断点续传）
  dropbox: {
    match: /https?:\/\/[^\s"'<>]*dropbox\.com\/(?:scl\/fi\/[a-zA-Z0-9_-]+|s\/[a-zA-Z0-9_-]+)[^\s"'<>]*/,
    extract: u => { // 规范 URL：解码 HTML 实体、去锚点、去分享/下载参数（dl/rlkey/st/e）——同文件不同分享链接归一到同一 URL 作去重/复用键
      const url = String(u || '').replace(/&amp;/g, '&').split('#')[0];
      return url.replace(/[?&]dl=\d+/g, '').replace(/[?&](?:rlkey|st|e)=[^&]+/g, '').replace(/[?&]$/, '');
    },
    downloadUrl: id => `${id}${id.includes('?') ? '&' : '?'}dl=1`, // 强制下载
    key: id => `dropbox:${id}`,
  },
  // 未来扩展示例（新增网盘：加一个 provider 即可，其余逻辑通用）：
  // mega:  { match: /mega\.nz\/file\/[A-Za-z0-9_-]+/, extract: u => u.match(/file\/([A-Za-z0-9_-]+)/)?.[1] || null, downloadUrl: id => `https://mega.nz/api/...`, key: id => `mega:${id}` },
  // baidu: { match: /pan\.baidu\.com\/s\/[A-Za-z0-9_-]+/, extract: ..., downloadUrl: ..., key: id => `baidu:${id}` },
};

/** 提取正文所有外部链接（URL 正则去重——外链表格/正文本地化共用） */
function extractContentLinks(content) {
  return [...new Set((content || '').match(/https?:\/\/[^\s"'<>（）()，。、；；]+/g) || [])];
}

/** 匹配正文第一个网盘链接 → {type, id(extract 结果), key(去重/复用键=完整 URL：drive 构造 share URL、dropbox 即规范 URL)}；无 → null（遍历 provider——新增网盘自动识别） */
function matchNetdiskLink(content) {
  for (const [type, p] of Object.entries(NETDISK_PROVIDERS)) {
    const m = (content || '').match(p.match);
    if (m) { const id = p.extract(m[0]); return { type, id, key: p.share ? p.share(id) : id }; }
  }
  return null;
}

/** 构建 网盘URL→本地文件 映射（新格式 serverPath=完整网址作键；旧格式 netdiskId 兼容） */
function buildNetdiskFileMap(files) {
  const map = new Map();
  for (const f of (files || [])) {
    if (f.serverPath && /^https?:/i.test(f.serverPath)) map.set(f.serverPath, f);
    else if (f.netdiskId) map.set(f.netdiskId, f);
  }
  return map;
}

/** 下载正文里的网盘链接（遍历已注册 provider）到帖子目录；文件名取响应头原始名。
 * 返回记录项 [{filename, size, exists, serverPath(网盘=完整网址), rel, savePath}]——并入帖 html files[] 展示。 */
async function downloadNetdiskFiles(detail, postDir, hashIndex) {
  const out = [];
  if (!CONFIG.downloadDrive) return out;
  const content = detail.content || '';
  for (const [type, p] of Object.entries(NETDISK_PROVIDERS)) {
    const ids = [...new Set((content.match(p.match) || []).map(u => p.extract(u)).filter(Boolean))];
    for (const id of ids) {
      // 跨帖复用：hashIndex 里该网盘 ID 已下载（同链接/同内容）→ 硬链接/复制复用，不重复下载
      const urlKey = p.share ? p.share(id) : id; // 记录/复用统一键 = 完整网盘 URL（drive 构造分享 URL、dropbox 即规范 URL；http/https 前缀天然标识网盘）
      const rec = hashIndex && hashIndex.get(urlKey);
      if (rec && rec.rel && await fileExists(rec.rel)) {
        const srcName = path.basename(rec.rel);
        const final = path.join(postDir, srcName);
        if (final !== rec.rel && !(await fileExists(final))) {
          const how = await linkOrCopy(rec.rel, final);
          console.log(`  [网盘复用] ${srcName}（${type}:${id}，${how === 'linked' ? '硬链接' : '复制'}复用）`);
          log(`[下载] 网盘复用 ${srcName}（${type}:${id}）`);
        } else {
          console.log(`  [网盘已存在] ${srcName}`); // 本帖已下载（复用源即本帖或目标已存在）
        }
        out.push({ filename: srcName, size: rec.size ?? null, exists: true, serverPath: urlKey, rel: path.relative(postDir, final), savePath: final });
        continue;
      }
      const url = p.downloadUrl(id);
      const netdiskTmp = path.join(postDir, sanitizeName(`netdisk_${type}_${id}`) + CONFIG.tempSuffix); // dropbox 等以完整 URL 作 id：tmp 名必须消毒（否则 https:// 的 // 被当路径分隔 → 创建 netdisk_dropbox_https: 目录树）
      // 断点续传：Drive 直链支持 Range（accept-ranges 实测 206）；疑似病毒确认页残留（<64KB 小文件）删掉从头下
      let tempSize = 0;
      try { if ((await fs.promises.stat(netdiskTmp)).size < 65536) await fs.promises.rm(netdiskTmp, { force: true }).catch(() => {}); } catch { /* 无残留 */ }
      try { tempSize = (await fs.promises.stat(netdiskTmp)).size; } catch { tempSize = 0; }
      let result;
      try { result = await streamOnce(url, netdiskTmp, tempSize, null, { shouldAbort: () => false }); } catch { result = { status: 'err' }; }
      if (result.status !== 'ok') {
        console.log(`  [网盘失败] ${type}:${id}（${result.status}）`);
        log(`[下载] 网盘 ${type}:${id} 失败（${result.status}）`);
        await fs.promises.rm(netdiskTmp, { force: true }).catch(() => {});
        continue;
      }
      let size = 0;
      try { size = (await fs.promises.stat(netdiskTmp)).size; } catch { /* 0 */ }
      // Google Drive 大文件（>100MB 无法扫描病毒）会返回确认页而非文件：识别后带 confirm=t 重下
      if (size < 65536) {
        const head = await fs.promises.readFile(netdiskTmp, 'utf8').catch(() => '');
        if (/Virus scan warning|uc-warning-caption|name="confirm"/.test(head)) {
          console.log(`  [网盘确认] ${type}:${id} 大文件病毒扫描确认页，带 confirm 重下`);
          await fs.promises.rm(netdiskTmp, { force: true }).catch(() => {});
          try { result = await streamOnce(`${url}&confirm=t`, netdiskTmp, 0, null, { shouldAbort: () => false }); } catch { result = { status: 'err' }; }
          if (result.status !== 'ok') {
            console.log(`  [网盘失败] ${type}:${id}（${result.status}）`);
            log(`[下载] 网盘 ${type}:${id} 失败（${result.status}）`);
            await fs.promises.rm(netdiskTmp, { force: true }).catch(() => {});
            continue;
          }
          try { size = (await fs.promises.stat(netdiskTmp)).size; } catch { /* 0 */ }
        }
      }
      // 通用内容校验：响应若为 HTML 页（dropbox 失效链接返回网页、drive 确认页重试后仍异常等）→ 视为失败不落盘
      const headHtml = await fs.promises.readFile(netdiskTmp).then(b => b.subarray(0, 512).toString('utf8')).catch(() => '');
      if (/^\s*<(!doctype\s+html|html)/i.test(headHtml)) {
        console.log(`  [网盘失败] ${type}:${id.slice(0, 50)}（响应为 HTML 页，非文件）`);
        log(`[下载] 网盘 ${type}:${id} 失败（响应为 HTML 页）`);
        await fs.promises.rm(netdiskTmp, { force: true }).catch(() => {});
        continue;
      }
      const fallbackName = (t, i) => { const m = /[^/?#]+(?=\?|$)/.exec(String(i).split('#')[0]); return m ? `${t}_${m[0]}` : `${t}_${i}`; }; // fallback 取 URL 末段文件名（如 dropbox 链接的 Miku_Study...mp4），避免整 URL 作文件名
      const name = sanitizeName(result.disposition || fallbackName(type, id)); // 响应头原始文件名，失败退 <type>_<URL末段>
      const final = path.join(postDir, name);
      if (await fileExists(final)) { // 本目录已下载（存在即跳过）
        await fs.promises.rm(netdiskTmp, { force: true }).catch(() => {});
        console.log(`  [网盘已存在] ${name}`);
        const hash = await fileSha256(final).catch(() => null);
        if (hash && hashIndex) { hashIndex.set(`sha256:${hash}`, { rel: final, size }); hashIndex.set(urlKey, { rel: final, size }); }
        out.push({ filename: name, size, exists: true, serverPath: urlKey, rel: path.relative(postDir, final), savePath: final });
        continue;
      }
      await fs.promises.rename(netdiskTmp, final);
      console.log(`  [网盘下载] ${name} ${fmtBytes(size)}`);
      log(`[下载] 网盘 ${name}（${type}:${id}，${fmtBytes(size)}）`);
      // 内容 hash 作去重键（跨帖同内容复用）+ 网盘 ID 键（同链接复用）
      const hash = await fileSha256(final).catch(() => null);
      if (hash && hashIndex) { hashIndex.set(`sha256:${hash}`, { rel: final, size }); hashIndex.set(urlKey, { rel: final, size }); }
      out.push({ filename: name, size, exists: true, serverPath: urlKey, rel: path.relative(postDir, final), savePath: final });
    }
  }
  return out;
}

/** 计算文件 sha256（流式——大文件不占内存；失败返回 null） */
async function sha256File(filePath) {
  try {
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(filePath);
      rs.on('data', d => h.update(d));
      rs.on('end', resolve);
      rs.on('error', reject);
    });
    return h.digest('hex');
  } catch { return null; }
}

/** 跨进程文件锁（2026-09-29——同 serverPath 并发多 cli 防重复下载）：.pawchive/locks/<sha1(serverPath)>.lock
 * fs.open('wx') 原子创建——同文件并发只有一个拿锁；拿不到=别处在下 → 返回 null（调用方跳过）；
 * 锁内容写 pid；mtime 超 24h 视为死锁（进程崩溃残留）自动清理重试 */
const LOCK_STALE_MS = 24 * 3600 * 1000;
async function acquireLock(serverPath) {
  const dir = path.join(CONFIG.dataRoot || '', '.pawchive', 'locks');
  await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
  const lockPath = path.join(dir, crypto.createHash('sha1').update(serverPath).digest('hex').slice(0, 24) + '.lock');
  for (let i = 0; i < 2; i++) {
    try {
      const fh = await fs.promises.open(lockPath, 'wx');
      await fh.writeFile(String(process.pid)).catch(() => {});
      await fh.close().catch(() => {});
      return lockPath;
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        try {
          const st = await fs.promises.stat(lockPath);
          // 死锁检测（中断残留）：锁内容写 pid——进程已死（/proc/<pid> 不存在）或超 24h 视为死锁，删锁重试（不阻塞后续续传）
          const pidStr = (await fs.promises.readFile(lockPath, 'utf8').catch(() => '')).trim();
          const pidAlive = pidStr && fs.existsSync(`/proc/${pidStr}`);
          if (!pidAlive || Date.now() - st.mtimeMs > LOCK_STALE_MS) { await fs.promises.rm(lockPath, { force: true }).catch(() => {}); continue; }
        } catch { continue; }
        return null; // 别处 cli 正在下载——跳过
      }
      return null;
    }
  }
  return null;
}
async function releaseLock(lockPath) { if (lockPath) await fs.promises.rm(lockPath, { force: true }).catch(() => {}); }

/**
 * 下载单个文件到 savePath（流式写 .tmp，完成后重命名）。
 * @param onProgress 进度回调 {filename, doneBytes, total, percent, speed}
 * 返回状态：'exists'（已有文件跳过）| 'downloaded'（完成）| 'failed:msg'
 */
async function downloadFile(job, { onProgress = null, expectedSize: optExpected = null, abortCtl = null } = {}) {
  const finalPath = job.savePath;
  if (await fileExists(finalPath)) return { status: 'exists', job };
  const tmpPath = `${finalPath}${CONFIG.tempSuffix}`;
  let tempSize = 0;
  try { tempSize = (await fs.promises.stat(tmpPath)).size; } catch { /* 无临时文件则从头下 */ }

  // 大小基准来自上游（html 记录 / API size），不再单独探测请求；进度百分比用该值（无则显示 ?）
  const probeTotal = optExpected;

  // speed 滑动窗口差分（iwara downloader 同款：doneBytes 变化 / 时间差）
  let spLast = tempSize, spLastTime = 0, speed = 0;
  // 慢速退避状态：连续慢速 slowDetectMs 毫秒 → streamOnce 中断 curl → 退避等待后续传
  let slowSince = 0, slowCount = 0, antiBotCount = 0; // antiBotCount：反爬占位重试计数（长等待，限次数）
  const progressCb = (written, total) => {
    const effectiveTotal = total || probeTotal;
    const now = Date.now();
    const dt = (now - spLastTime) / 1000;
    if (spLastTime && dt > 0) speed = Math.max(0, (written - spLast) / dt);
    spLast = written; spLastTime = now;
    // 限频检测：有实际速度且持续低于阈值 → 记为慢速开始
    if (speed > 0 && speed < CONFIG.slowSpeedKb * 1024) {
      if (!slowSince) slowSince = now;
    } else {
      slowSince = 0;
    }
    if (onProgress) onProgress({
      filename: job.filename,
      doneBytes: written,
      total: effectiveTotal || null,
      percent: effectiveTotal ? Math.min(100, (written / effectiveTotal) * 100) : 0,
      speed,
    });
  };

  for (let attempt = 0; attempt <= CONFIG.downloadRetryTimes; attempt++) {
    if (abortCtl && abortCtl.shouldAbort()) return { status: 'failed:aborted', job }; // 任务 abort（2026-09-29——真中断级联）
    await tpsGate(); // 每次建连前限速，保持每秒 <= tps 个连接
    try {
      const result = await streamOnce(job.fileUrl, tmpPath, tempSize, progressCb, {
        shouldAbort: () => (abortCtl && abortCtl.shouldAbort ? abortCtl.shouldAbort() : false) || (slowSince > 0 && Date.now() - slowSince > CONFIG.slowDetectMs), // 合并：外部 abort + 慢速退避
      });
      if (result.status !== 'ok') {
        // 慢速退避：curl 被 SIGTERM（exit 143）且确实是限速 → 等待窗口恢复后续传
        const isSlowLimited = result.status === 'curl_exit_143' && slowSince > 0;
        if (isSlowLimited && slowCount < CONFIG.slowMax) {
          slowCount++;
          console.log(`  [限速退避 ${slowCount}/${CONFIG.slowMax}] ${job.filename}（<${CONFIG.slowSpeedKb}KB/s 持续 ${CONFIG.slowDetectMs / 1000}s，等待 ${CONFIG.slowWaitMs / 1000}s 后续传）`);
          log(`[下载] 限速退避 ${slowCount}/${CONFIG.slowMax} ${job.filename}`);
          await sleep(CONFIG.slowWaitMs);
          try { tempSize = (await fs.promises.stat(tmpPath)).size; } catch { tempSize = 0; }
          spLast = tempSize; spLastTime = 0; speed = 0; slowSince = 0;
          attempt--; // 慢速退避不消耗重试配额（continue 会 attempt++，先抵消；退避由 slowCount/slowMax 独立计数）
          continue;
        }
        // curl 失败（exit 18/28/92 等）：按重试策略处理。
        // 【断点续传】file host 带 UA 后 Range 续传正常（实测带浏览器头 9.4MB/s）：
        // 失败重试保留 .tmp 并从断点续传（重新 stat .tmp 大小 → curl -C 续传）。
        if (attempt < CONFIG.downloadRetryTimes && shouldRetry(result.status)) {
          if (onProgress) onProgress({ filename: job.filename, state: `retry:${result.status}` }); // 引擎重试上报（与 catch 分支一致——835 curl 失败重试也发 retry 状态→download.retrying 事件→waiting_retries 面板）
          console.log(`  [重试 ${attempt + 1}/${CONFIG.downloadRetryTimes}] ${job.filename} (${result.status})`);
          await sleep(CONFIG.downloadRetryIntervalMs);
          try { tempSize = (await fs.promises.stat(tmpPath)).size; } catch { tempSize = 0; }
          spLast = tempSize; spLastTime = 0; speed = 0; slowSince = 0;
          continue;
        }
        // HTTP 错误（curl_exit_22 = 4xx/5xx，如 404 失效链接）：回退缩略图（img.pawchive.pw/thumbnail/），
        // 缩略图下载成功 → 文件名加 _thumb 后缀标记（降级产物，非原图质量）；缩略图也失败 → 判定失败（删 tmp 防残留）
        if (/^curl_exit_22/.test(String(result.status))) {
          await fs.promises.rm(tmpPath, { force: true }).catch(() => {}); // 清原图残留（404 无续传价值）
          const pp = path.parse(finalPath);
          const thumbPath = path.join(pp.dir, `${pp.name}_thumb${pp.ext}`);
          // 缩略图已存在（上次回退成功）→ 不重复下载
          if (await fileExists(thumbPath)) {
            let ts = 0;
            try { ts = (await fs.promises.stat(thumbPath)).size; } catch { /* 0 */ }
            console.log(`  [缩略图已存在] ${path.basename(thumbPath)}`);
            log(`[下载] 缩略图已存在 ${path.basename(thumbPath)}`);
            return { status: 'thumb_exists', job, size: ts };
          }
          const thumbUrl = job.fileUrl.replace(CONFIG.filesBase, CONFIG.thumbBase); // file host → img host/thumbnail（保留 /data 前缀）
          const thumbResult = await streamOnce(thumbUrl, tmpPath, 0, progressCb, { shouldAbort: () => false });
          if (thumbResult.status === 'ok') {
            let ts = 0;
            try { ts = (await fs.promises.stat(tmpPath)).size; } catch { /* 0 */ }
            if (ts === CONFIG.antibotSize || (thumbResult.contentLength != null && ts !== thumbResult.contentLength)) { // 缩略图也异常
              await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
              return { status: `failed:${result.status}`, job };
            }
            await fs.promises.rename(tmpPath, thumbPath); // pp/thumbPath 已在回退分支顶部定义
            console.log(`  [缩略图回退] ${job.filename}（原图 404，已下载缩略图 ${fmtBytes(ts)}）`);
            log(`[下载] 缩略图回退 ${job.filename}（${fmtBytes(ts)}）`);
            return { status: 'downloaded_thumb', job, size: ts, savePath: thumbPath }; // savePath=实际缩略图路径（③产物登记用——原图 404 回退时 job.savePath 是原图路径不存在）
          }
          await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
          return { status: `failed:${result.status}`, job };
        }
        return { status: `failed:${result.status}`, job };
      }
      // 完整性校验：落盘大小与预期（探测/Content-Length）比对；376B 或大小不符 = 反爬占位，
      // 删除占位不落正式文件，等待后重试（防「下载完成但文件是 376B bot 提示」）
      let actualSize = 0, headSample = '';
      try {
        const st = await fs.promises.stat(tmpPath);
        actualSize = st.size;
        if (actualSize > 0 && actualSize < CONFIG.http404PageMax) headSample = (await fs.promises.readFile(tmpPath, 'utf8')).slice(0, 200); // 小文件读头部判断错误页
      } catch { /* tmp 缺失按 0 处理 */ }
      const headerLen = result.contentLength; // DDoS-Guard 中间响应可能给出异常小的头（challenge），仅当不小于实际落盘量才可信
      const expectedSize = (headerLen != null && headerLen >= actualSize) ? headerLen : (optExpected ?? null);
      const is404Page = actualSize < CONFIG.http404PageMax && /^<(html|!doctype)/i.test(headSample.trim()); // 404/错误页特征（curl -f 未拦截时的兜底）
      const antiBot = actualSize === CONFIG.antibotSize || is404Page || (expectedSize != null && actualSize !== expectedSize);
      if (antiBot) {
        await fs.promises.rm(tmpPath, { force: true }); // 占位/不完整：删掉 .tmp，不落正式文件
        // 反爬窗口期快速重试只会加深限流：等待慢速退避时长（slowWaitMs）后重试，最多 slowMax 次
        if (antiBotCount < CONFIG.slowMax) {
          antiBotCount++;
          console.log(`  [反爬占位 ${antiBotCount}/${CONFIG.slowMax}] ${job.filename}（落盘 ${actualSize}B${expectedSize ? ` ≠ 预期 ${expectedSize}B` : ''}，等待 ${CONFIG.slowWaitMs / 1000}s 再试）`);
          log(`[下载] 反爬占位 ${antiBotCount}/${CONFIG.slowMax} ${job.filename}`);
          await sleep(CONFIG.slowWaitMs);
          tempSize = 0; spLast = 0; spLastTime = 0; speed = 0; slowSince = 0;
          continue;
        }
        return { status: 'failed:anti_bot', job, size: actualSize };
      }
      // 落盘成功：临时文件改名成目标文件（整文件完整且大小校验通过后才改名）
      await fs.promises.rename(tmpPath, finalPath);
      // 原图恢复下载成功：清理旧缩略图（降级产物，原图已可用则无用）
      const pp = path.parse(finalPath);
      const oldThumb = path.join(pp.dir, `${pp.name}_thumb${pp.ext}`);
      if (oldThumb !== finalPath) await fs.promises.rm(oldThumb, { force: true }).catch(() => {});
      if (onProgress) onProgress({
        filename: job.filename, doneBytes: result.totalSize || actualSize, total: result.totalSize,
        percent: 100, speed: 0, state: 'done',
      });
      // 强校验模式（PAWCHIVE_STRICT_VERIFY=1 默认关）：下载完成计算本地 sha256 vs 目标 serverPath hash（内容寻址）
      // 不符 → 本轮优先修复（删坏文件 + 整文件重下——不是不重下）；重下耗尽配额才判失败（对齐用户语义：不符→修复，修复不了→整文件重下）
      if (CONFIG.strictVerify) {
        const targetHash = /([a-f0-9]{64})/i.exec(job.serverPath);
        if (targetHash) {
          const localHash = await sha256File(job.savePath);
          if (localHash && localHash !== targetHash[1]) {
            await fs.promises.rm(job.savePath, { force: true }).catch(() => {}); // 删坏文件（不把坏文件当成功）
            if (attempt < CONFIG.downloadRetryTimes) { // 本轮重下：重新下载整文件（强校验内容寻址——只用配额内次数，避免死循环）
              console.log(`  [强校验不符 ${attempt + 1}/${CONFIG.downloadRetryTimes}] ${job.filename}（内容不一致——已删坏文件，本轮重新下载）`);
              log(`[下载] 强校验不符重下 ${job.filename}`);
              await sleep(CONFIG.downloadRetryIntervalMs);
              tempSize = 0; spLast = 0; spLastTime = 0; speed = 0; slowSince = 0; // 归零续传态 → 整文件重下（续传是损坏文件无意义）
              continue;
            }
            console.log(`  [强校验不符] ${job.filename}（sha256 不匹配目标，重下 ${CONFIG.downloadRetryTimes} 次仍不符——不再保留失败）`);
            return { status: 'failed:hash_mismatch', job };
          }
        }
      }
      return { status: 'downloaded', job, size: actualSize };
    } catch (err) {
      const status = extractStatus(err);
      if (attempt < CONFIG.downloadRetryTimes && shouldRetry(status)) {
        if (onProgress) onProgress({ filename: job.filename, state: `retry:${status}` });
        console.log(`  [重试 ${attempt + 1}/${CONFIG.downloadRetryTimes}] ${job.filename} (${status})`);
        await sleep(CONFIG.downloadRetryIntervalMs);
        // 同样保留 .tmp 断点续传
        // fsync（2026-09-29 对齐）：续传前强制落盘再 stat（防 OS 缓存 stat 与实际不一致——空洞定位错）
        try { const fd = await fs.promises.open(tmpPath, 'r+'); await fd.sync().catch(() => {}); await fd.close(); } catch { /* .tmp 不存在则 0 */ }
        try { tempSize = (await fs.promises.stat(tmpPath)).size; } catch { tempSize = 0; }
        spLast = tempSize; spLastTime = 0; speed = 0; slowSince = 0;
        continue;
      }
      return { status: `failed:${status}`, job };
    }
  }
  return { status: 'failed:unknown', job };
}

/**
 * 一次传输：curl 断点续传写入临时文件末尾。
 * 为什么用 curl 而非 fetch：实测 file.pawchive.pw 对 Node TLS 客户端指纹限速——
 * curl 连接 0.3s / 下载正常，Node fetch/https 连接 8.7s+ 且 body 卡死；curl 快 30 倍。
 * 为什么强制 HTTP/1.1 + 带 UA/Accept：实测 file host 对「无 UA 的 Range>0 请求」限速
 * （~5-9KB/s；带浏览器头 9.4MB/s，wget 同）——带头后断点续传正常。
 * 进度：轮询 .tmp 文件大小（同 iwara aria2 tellStatus 轮询思路）。
 * 返回 {status, totalSize}；非 ok 由上层按重试策略处理。
 */
async function streamOnce(fileUrl, tmpPath, tempSize, onProgress = null, abortCtl = null) {
  await fs.promises.mkdir(path.dirname(tmpPath), { recursive: true }); // curl 不会自动建目录（移出 Promise executor，async executor 抛错会变未处理 rejection）
  return new Promise(resolve => {
    const args = [
      '-sS', '-f', '-L', '--http1.1', '--connect-timeout', String(CONFIG.curlConnectTimeout), '--max-time', String(Math.ceil(CONFIG.downloadTimeoutMs / 1000)), // -f：HTTP 4xx/5xx 时 curl 直接失败（exit 22），404 页面不落盘
      '-H', `User-Agent: ${CONFIG.userAgent}`,
      '-H', 'Accept: */*',
      '-D', '-', // 响应头输出到 stdout（解析 Content-Length 作完整性校验基准，替代探测请求）
      '-C', String(tempSize), // 从断点续传（服务器不支持 Range 时会重下整文件，file host 实测支持 206）
      '-o', tmpPath,
      fileUrl,
    ];
    const p = trackCurl(spawn(CURL_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })); // stdout=头文本、stderr=错误，均须 pipe（ignore 会使对应流为 null）；trackCurl 全局跟踪防孤儿
    let stderr = '', headerText = '';
    p.stdout.on('data', c => { headerText += c; }); // -D - 的头文本（-o 已把 body 写文件）
    p.stderr.on('data', c => { stderr += c; });
    let lastEmit = 0;
    const timer = setInterval(() => { // 500ms 轮询 .tmp 大小做实时进度
      const now = Date.now();
      // 慢速退避钩子：上层检测到持续限速（限频窗口）时 SIGTERM 中断 curl，保留 .tmp 供续传
      if (abortCtl && abortCtl.shouldAbort()) {
        p.kill('SIGTERM');
        return;
      }
      if (!onProgress || now - lastEmit < 200) return;
      fs.promises.stat(tmpPath).then(st => {
        if (st.size !== tempSize) { lastEmit = now; onProgress(st.size, null); }
      }).catch(() => {});
    }, 500);
    p.on('close', code => {
      clearInterval(timer);
      if (code === 0) {
        fs.promises.stat(tmpPath).then(st => {
          if (onProgress) onProgress(st.size, null);
          resolve({ status: 'ok', totalSize: st.size, contentLength: parseContentLength(headerText), disposition: parseContentDisposition(headerText) });
        }).catch(() => resolve({ status: 'no_file' }));
      } else {
        resolve({ status: `curl_exit_${code}`, stderr: stderr.slice(0, 500) }); // 交给上层重试（exit 28=timeout 等；带 stderr 供调试）
      }
    });
    p.on('error', err => { clearInterval(timer); resolve({ status: `curl_spawn:${err.code || err.message}` }); });
  });
}

/** 真实下载不落盘测速（curl -o /dev/null，窗口内速度）；返回 {speedBps, sizeB, code} */
function probeFileSpeed(fileUrl, windowMs = 5000) {
  return new Promise(resolve => {
    const p = trackCurl(spawn(CURL_BIN, [
      '-s', '-o', '/dev/null', '-w', '%{speed_download} %{size_download}',
      '--http1.1', '--connect-timeout', String(CONFIG.curlConnectTimeout), '--max-time', String(Math.ceil(windowMs / 1000) + 1),
      '-H', `User-Agent: ${CONFIG.userAgent}`,
      '-H', 'Accept: */*',
      fileUrl,
    ], { stdio: ['ignore', 'pipe', 'ignore'] }));
    let out = '';
    p.stdout.on('data', c => { out += c; });
    p.on('close', code => {
      const [s, sz] = out.trim().split(/\s+/);
      resolve({ speedBps: parseFloat(s) || 0, sizeB: parseInt(sz, 10) || 0, code });
    });
    p.on('error', () => resolve({ speedBps: 0, sizeB: 0, code: -1 }));
  });
}

function extractStatus(err) {
  if (err && err.name === 'AbortError') return 'timeout';
  if (err && err.cause) return String(err.cause.code || err.cause.message);
  return String(err && err.message || 'error');
}
function shouldRetry(status) {
  if (typeof status === 'number') return CONFIG.apiRetryStatus.includes(status);
  if (status === 'timeout') return true;
  if (/^curl_exit_22/.test(String(status))) return false; // HTTP 4xx/5xx（404 失效链接等）：确定性失败，重试无意义
  return /(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|fetch failed|curl_exit_|curl_spawn)/i.test(String(status));
}

// ---------- 下载进度聚合与并发执行 ----------
/** 字节格式化（B/KB/MB/GB，同 rich.filesize.decimal 用途） */
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)}${u[i]}`;
}
const fmtSpeed = n => (n == null || isNaN(n) ? '?/s' : `${fmtBytes(n)}/s`);

// ---------- pawchive-index.html 索引（对齐 gbmd description.html：人读页 + 内嵌 JSON 机读块） ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmtDate = d => (d ? String(d).slice(0, 10) : '-');
const postUrlOf = post => `${CONFIG.webBase}/${post.service}/user/${post.user}/post/${post.id}`;

/** 机读索引块（gbmd buildIndexBlock 同构；重跑/去重时 parseIndexObj 读回，不重爬 API） */
function buildIndexJsonBlock(obj) {
  return `<script id="pawchive-index" type="application/json">\n${JSON.stringify(obj, null, 2)}\n</script>`;
}

/** 从 html 文本解析机读索引块（schema 不符/缺失返回 null） */
function parseIndexObj(html) {
  if (!html) return null;
  const m = html.match(/<script id="pawchive-index"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    if (parsed && parsed.schema === 1) return parsed;
  } catch { /* 解析失败 = 无效索引 */ }
  return null;
}

const PINDEX_STYLE = `
  body{font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:960px;margin:0 auto;padding:24px;color:#222;background:#fafafa}
  h1{font-size:24px;margin:0 0 4px;word-break:break-all}
  .meta{color:#666;margin:0 0 16px;font-size:13px}
  table{width:100%;border-collapse:collapse;margin:16px 0;background:#fff}
  th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;font-size:13px;word-break:break-all}
  th{background:#f0f0f0}
  a{color:#0a58ca}.desc{background:#fff;border:1px solid #eee;border-radius:8px;padding:16px;margin:16px 0}.desc img{max-width:100%}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin:16px 0}
  .thumb{width:100%;border-radius:6px;border:1px solid #ddd;object-fit:cover;aspect-ratio:1;background:#eee}`;

/** 文件类型判定（html「真实显示」分区用：图片/视频/压缩包/其他） */
function fileKind(name) {
  if (/\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(name)) return 'image';
  if (/\.(mp4|webm|mkv|avi|mov|flv|ts)$/i.test(name)) return 'video';
  if (/\.(zip|7z|rar|tar|tgz|gz|xz|bz2)$/i.test(name)) return 'archive';
  return 'file';
}

/**
 * 帖子级索引 html：人读（标题/meta/文件列表表/正文）+ JSON 机读块。
 * @param postDirDisplay 帖子目录的显示名（相对目标根，避免绝对路径写入索引；迁移/换机可用）
 * files: [{filename, size, exists, serverPath, rel}]  rel=相对帖子目录的落盘路径（去重登记用）
 *
 * ── HTML 生成机制（下载前/下载后双写 + 网盘记录时机）──
 * 1. 前置 html（downloadOnePost ③，下载前写）：图片/附件初态；网盘【尚未下载】→ 正文链接保持原始 URL
 * 2. 下载（图片/附件）+ 网盘下载（downloadNetdiskFiles，⑤.5——成功才 push 记录）
 * 3. 后置 html（downloadOnePost ⑤，下载后刷新）：网盘【成功项】进 files 列表 + 正文 desc 本地化
 * ── 网盘成功/失败判定（无需失败字段，正文本地化即状态）──
 * · 正文里网盘链接【已本地化（href=本地文件）】= 下载成功
 * · 正文里网盘链接【仍是原始 URL】= 没下载成功/没下载（失败网盘项从不记录进 html）
 * · serverPath：pawchive 文件=相对路径（/data/...）；网盘=完整网址（http/https 前缀天然标识网盘，
 *   域名区分类型，URL 本身作去重/复用键——dropbox 规范 URL 去 rlkey 等分享参数，drive 用完整分享 URL）
 * · 无 netdiskId 字段（URL 即身份）；旧格式（type: 前缀 + netdiskId）读取兼容，
 *   且下载该帖重跑时 html 重新生成（writeOnePostIndex）→ 自然清理旧格式无效字段（自动迁移为新格式）
 */
function buildPostIndexHtml(post, creatorName, postDirDisplay, files) {
  // 标注类型，并按「真实显示」分区：图片墙 / 视频播放器 / 压缩包下载卡片
  const typed = (files || []).map(f => ({ ...f, kind: fileKind(f.filename) }));
  // 正文外部链接统计（一般是网盘下载地址等）：提取 http(s) 链接去重成表
  const extLinks = extractContentLinks(post.content);
  // 外链表格保持原样（原始 URL 链接，展示来源；正文里的网盘链接才本地化）
  const netdiskFileByUrl = buildNetdiskFileMap(files);
  const extRows = extLinks
    .map((u, i) => {
      let host = '';
      try { host = new URL(u).hostname; } catch { /* 畸形 URL */ }
      return `<tr><td>${i + 1}</td><td><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></td><td>${esc(host)}</td></tr>`;
    })
    .join('');
  const imgs = typed.filter(f => f.exists && f.kind === 'image');
  const vids = typed.filter(f => f.exists && f.kind === 'video');
  const archs = typed.filter(f => f.exists && f.kind === 'archive');
  const gridHtml = imgs
    .map(f => `<a href="${esc(f.rel)}" target="_blank"><img src="${esc(f.rel)}" loading="lazy" class="thumb" alt="${esc(f.filename)}"></a>`)
    .join('');
  const videoHtml = vids
    .map(f => `<video src="${esc(f.rel)}" controls preload="metadata" style="max-width:100%;border-radius:6px;border:1px solid #ddd;margin:4px 0"></video>`)
    .join('');
  const archRows = archs
    .map(f => `<tr><td>📦 ${esc(f.filename)}</td><td>${f.size ? fmtBytes(f.size) : '-'}</td><td><a href="${esc(f.rel)}" download>下载</a></td></tr>`)
    .join('');
  const kindLabel = { image: '图片', video: '视频', archive: '压缩包', file: '文件' };
  const rows = typed
    .map(f => `<tr><td>${esc(kindLabel[f.kind] || '文件')}</td><td>${esc(f.filename)}</td><td>${f.size ? fmtBytes(f.size) : '-'}</td><td>${f.exists ? '已下载' : '缺失'}</td></tr>`)
    .join('');
  const index = {
    schema: 1, type: 'post', service: post.service || '', userId: post.user || '', postId: post.id,
    title: post.title || '', creatorName, url: postUrlOf(post),
    published: post.published || null, postDir: postDirDisplay || null,
    driveLinks: !!matchNetdiskLink(post.content), // 正文是否有网盘链接（遍历 provider 判断，新增网盘自动识别；快速跳过有网盘不跳，防历史帖漏下网盘）
    files: typed.map(f => ({ filename: f.filename, size: f.size || null, exists: !!f.exists, serverPath: f.serverPath, rel: f.rel, kind: f.kind })),
  };
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(post.title || post.id)} - ${esc(creatorName)}</title>
<style>${PINDEX_STYLE}</style>
</head>
<body>
  <h1>${esc(post.title || post.id)}</h1>
  <p class="meta">
    平台：${esc(post.service || '-')}　创作者：${esc(creatorName)}（${esc(post.user || '-')}）<br>
    发布时间：${fmtDate(post.published)}　本地目录：${esc(postDirDisplay || '-')}<br>
    原链接：<a href="${esc(postUrlOf(post))}">${esc(postUrlOf(post))}</a>
  </p>
  ${imgs.length ? `<h2>图片（${imgs.length}）</h2><div class="grid">${gridHtml}</div>` : ''}
  ${vids.length ? `<h2>视频（${vids.length}）</h2>${videoHtml}` : ''}
  ${archs.length ? `<h2>压缩包（${archs.length}）</h2><table><tr><th>文件</th><th>大小</th><th>操作</th></tr>${archRows}</table>` : ''}
  <h2>文件列表（${typed.length}）</h2>
  <table>
    <tr><th>类型</th><th>文件名</th><th>大小</th><th>状态</th></tr>
    ${rows || '<tr><td colspan="4">（本帖无文件）</td></tr>'}
  </table>
  <h2>正文</h2>
  <div class="desc">${(() => {
    // 正文里的网盘链接（已下载）→ a 标签指向本地文件；外链表格保持原始 URL
    let h = post.content || '<p>（无正文）</p>';
    h = h.replace(/<a\s+[^>]*href="([^"]+)"/gi, (m, url) => {
      let id = null;
      for (const p of Object.values(NETDISK_PROVIDERS)) { id = p.extract(url); if (id) break; }
      const local = id && netdiskFileByUrl.get(id);
      return local ? m.replace(url, local.rel) : m;
    });
    return h;
  })()}</div>
  ${extLinks.length ? `<h2>外部链接（${extLinks.length}）</h2><table><tr><th>#</th><th>链接</th><th>域名</th></tr>${extRows}</table>` : ''}
  ${buildIndexJsonBlock(index)}
</body>
</html>`;
}

/**
 * 创作者级总览索引 html：人读（创作者信息 + 关联渠道 + 帖子导航表）+ JSON 机读块。
 * postsSummary: [{title, postId, published, relDir, fileCount, downloaded}]
 * links: 关联渠道账号 [{id, name, service}]
 */
/** 下载创作者头像（Pawchive og:image 模式：{webBase}/icons/{service}/{id}）；主账号 + 关联渠道各账号都要；已存在跳过（avatars/avatar-{service}-{id}.*）。返回 [{service,id,name,rel,size,exists}] 供创作者 html 展示 */
async function downloadCreatorAvatars(plan, abortCtl = null) {
  const avatarsDir = path.join(plan.creatorDir, 'avatars');
  await fs.promises.mkdir(avatarsDir, { recursive: true });
  const out = [];
  const accounts = [{ service: plan.service, id: plan.userId, name: plan.creatorName }, ...(plan.links || [])];
  for (const acc of accounts) {
    if (!acc || !acc.id) continue;
    const prefix = `avatar-${acc.service}-${acc.id}`;
    let existing = null;
    try {
      for (const f of await fs.promises.readdir(avatarsDir)) {
        if (f.startsWith(prefix) && !f.endsWith(CONFIG.tempSuffix)) { existing = f; break; }
      }
    } catch { /* 目录异常按新下载 */ }
    if (existing) { // 已存在 → 校验源站是否换头像：重拉对比内容 hash，不同才替换（作者换头像自动更新；未变不写盘）
      const full = path.join(avatarsDir, existing);
      const url = `${CONFIG.webBase}/icons/${acc.service}/${acc.id}`;
      const tmp = path.join(avatarsDir, `${prefix}${CONFIG.tempSuffix}`);
      let result;
      try { result = await streamOnce(url, tmp, 0, null, { shouldAbort: () => (abortCtl && abortCtl.shouldAbort ? abortCtl.shouldAbort() : false) }); } catch { result = { status: 'err' }; }
      if (result.status === 'ok') {
        const newHash = await fileSha256(tmp).catch(() => null);
        const oldHash = await fileSha256(full).catch(() => null);
        let newSize = 0;
        try { newSize = (await fs.promises.stat(tmp)).size; } catch { /* 0 */ }
        if (newHash && oldHash && newHash !== oldHash) {
          await fs.promises.rm(full, { force: true }).catch(() => {});
          await fs.promises.rename(tmp, full);
          console.log(`  [头像更新] ${acc.service}/${acc.id} ${fmtBytes(newSize)}`);
          log(`[下载] 头像更新 ${acc.service}/${acc.id}（${fmtBytes(newSize)}）`);
          out.push({ service: acc.service, id: acc.id, name: acc.name || '', rel: path.relative(plan.creatorDir, full), size: newSize, exists: true });
          continue;
        }
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
      } else {
        await fs.promises.rm(tmp, { force: true }).catch(() => {}); // 源站失败：保留旧头像
      }
      let size = 0;
      try { size = (await fs.promises.stat(full)).size; } catch { /* 0 */ }
      out.push({ service: acc.service, id: acc.id, name: acc.name || '', rel: path.relative(plan.creatorDir, full), size, exists: true });
      continue;
    }
    const url = `${CONFIG.webBase}/icons/${acc.service}/${acc.id}`;
    const tmp = path.join(avatarsDir, `${prefix}${CONFIG.tempSuffix}`);
    let result;
    try { result = await streamOnce(url, tmp, 0, null, { shouldAbort: () => (abortCtl && abortCtl.shouldAbort ? abortCtl.shouldAbort() : false) }); } catch { result = { status: 'err' }; }
    if (result.status !== 'ok') { await fs.promises.rm(tmp, { force: true }).catch(() => {}); continue; }
    let size = 0;
    try { size = (await fs.promises.stat(tmp)).size; } catch { /* 0 */ }
    // 魔数检测扩展名（icons 响应为 octet-stream，无明确 image 类型）
    const head = await fs.promises.readFile(tmp).then(b => b.subarray(0, 12)).catch(() => Buffer.alloc(0));
    const ext = head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
      : head.length >= 2 && head[0] === 0xff && head[1] === 0xd8 ? 'jpg'
      : head.length >= 2 && head[0] === 0x89 && head[1] === 0x50 ? 'png' : 'img';
    const final = path.join(avatarsDir, `${prefix}.${ext}`);
    await fs.promises.rename(tmp, final);
    console.log(`  [头像] ${acc.service}/${acc.id} ${fmtBytes(size)}`);
    out.push({ service: acc.service, id: acc.id, name: acc.name || '', rel: path.relative(plan.creatorDir, final), size, exists: true });
  }
  return out;
}

function buildCreatorIndexHtml(plan, postsSummary, links, avatars) {
  const rows = postsSummary
    .map(p => {
      const href = p.relDir ? `${esc(p.relDir)}/${esc(CONFIG.indexFilename)}` : '#';
      return `<tr><td><a href="${href}">${esc(p.title || p.postId)}</a></td><td>${fmtDate(p.published)}</td><td>${p.fileCount}</td><td>${p.downloaded}/${p.fileCount}</td></tr>`;
    })
    .join('');
  const linkRows = (links || [])
    .map(l => `<tr><td>${esc(l.service || '-')}</td><td>${esc(l.name || '-')}</td><td><a href="${esc(CONFIG.webBase)}/${esc(l.service)}/user/${esc(l.id)}">${esc(l.id)}</a></td></tr>`)
    .join('');
  const avatarList = (avatars || []).filter(a => a.exists);
  const avatarHtml = avatarList
    .map(a => `<a href="${esc(a.rel)}" target="_blank" title="${esc(a.name || a.service + '/' + a.id)}"><img src="${esc(a.rel)}" loading="lazy" alt="${esc(a.name || a.service + '/' + a.id)}" style="max-width:100px;border-radius:50%;border:1px solid #ddd"></a>`)
    .join('');
  const index = {
    schema: 1, type: 'creator', service: plan.service, userId: plan.userId, creatorName: plan.creatorName,
    postCount: postsSummary.length,
    links: (links || []).map(l => ({ id: l.id, name: l.name || '', service: l.service })),
    avatars: (avatars || []).map(a => ({ service: a.service, id: a.id, name: a.name || '', rel: a.rel, size: a.size || null, exists: !!a.exists })),
    posts: postsSummary.map(p => ({ postId: p.postId, title: p.title || '', published: p.published || null, relDir: p.relDir, fileCount: p.fileCount, downloaded: p.downloaded, driveLinks: p.driveLinks === true })),
  };
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(plan.creatorName)} [${esc(plan.service)}-${esc(plan.userId)}]</title>
<style>${PINDEX_STYLE}</style>
</head>
<body>
  <h1>${esc(plan.creatorName)}</h1>
  <p class="meta">
    平台：${esc(plan.service || '-')}　创作者 ID：${esc(plan.userId || '-')}　帖子数：${postsSummary.length}<br>
    本地目录：${esc(CONFIG.dataRoot ? path.relative(CONFIG.dataRoot, plan.creatorDir) : plan.creatorDir)}
  </p>
  ${(links || []).length ? `<h2>关联渠道（同作者其他平台）</h2>
  <table><tr><th>平台</th><th>名字</th><th>账号链接</th></tr>${linkRows}</table>` : ''}
  ${avatarHtml ? `<h2>头像（${avatarList.length}）</h2><div class="grid">${avatarHtml}</div>` : ''}
  <h2>帖子索引（${postsSummary.length}）</h2>
  <table>
    <tr><th>标题</th><th>发布时间</th><th>文件数</th><th>已下载</th></tr>
    ${rows || '<tr><td colspan="4">（无帖子）</td></tr>'}
  </table>
  ${buildIndexJsonBlock(index)}
</body>
</html>`;
}

// ---------- hash 去重（同 server_path 内容寻址：只下一份，其余位置硬链接/复制） ----------
/** 递归找目标树内所有索引 html（文件名取 PAWCHIVE_INDEX_FILENAME，默认 pawchive-index.html；跳过 .pawchive/.trash 等内部目录） */
async function walkHtmlFiles(dir) {
  const out = [];
  const indexName = CONFIG.indexFilename;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.name === '.pawchive' || ent.name === '.trash' || ent.name === '.git'
      || ent.name === 'node_modules' || ent.name === '.cache') continue; // 跳过依赖/缓存目录（防误扫描大目录）
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walkHtmlFiles(full));
    else if (ent.name === indexName) out.push(full);
  }
  return out;
}

/**
 * 构建全局记录索引：扫描已有 pawchive-index.html 的 JSON 块（type=post 的 files 登记），
 * 得到 Map<serverPath, {rel, size}>。下载依据 = html 记录的 size（不按 hash 校验/复用）。
 * 帖子目录 = pawchive-index.html 所在目录（html 直接放帖子目录下，不依赖 JSON 里的绝对路径）。
 */
async function buildHashIndex(targetPath, plan) {
  // 去重索引只扫「该作者所有账号」的目录（不扫全目录）：
  // 1) 主账号目录 = plan.creatorDir（finalizePlan 已算好，含大小写冲突前缀）
  // 2) 关联账号清单 = 创作者级 html 的 links 机读块（记录了所有账号 {id,name,service}）
  // 3) 各账号目录 = 与 finalizePlan 同款「命名模板渲染 + 自动重命名（大小写冲突加前缀）」机制推导，保证与实际落盘目录一致
  const scopeDirs = new Set([plan.creatorDir]);
  // 关联账号清单：优先运行时 plan.links（本次 fetch 的最新，首次运行也能跨账号去重），
  // 创作者级 html 的 links 机读块兜底（旧 html 可能未写过 links——曾导致首次运行只扫主目录、跨账号硬链接复用失效）
  let creatorIndex = null;
  const creatorHtml = path.join(plan.creatorDir, CONFIG.indexFilename);
  try { creatorIndex = parseIndexObj(await fs.promises.readFile(creatorHtml, 'utf8')); } catch { /* 无 html */ }
  const links = (plan && Array.isArray(plan.links) && plan.links.length) ? plan.links
    : (creatorIndex && Array.isArray(creatorIndex.links) ? creatorIndex.links : []);
  if (links.length) {
    const entries = await fs.promises.readdir(targetPath, { withFileTypes: true }).catch(() => []);
    const dirNames = new Set(entries.filter(e => e.isDirectory()).map(e => e.name.toLowerCase()));
    for (const l of links) {
      if (!l || !l.id) continue;
      const baseName = sanitizeName(renderTemplate(CONFIG.creatorDirFormat, {
        creator_name: l.name || '', creator_id: l.id, service: l.service || '',
      }), true) || String(l.id);
      // 账号目录 = 实际存在者：原名，或大小写冲突时加过前缀的 (service) 名（与下载时自动重命名机制一致）
      const plain = path.join(targetPath, baseName);
      const prefixed = await ensureUniqueCreatorDir(plain, targetPath, l.service || '');
      for (const cand of [plain, prefixed]) {
        if (dirNames.has(path.basename(cand).toLowerCase())) { scopeDirs.add(cand); break; }
      }
    }
  }

  // 聚合各账号目录下的 pawchive-index.html 记录：serverPath -> {rel, size}
  const index = new Map();
  for (const dir of scopeDirs) {
    for (const htmlPath of await walkHtmlFiles(dir)) {
      let html;
      try { html = await fs.promises.readFile(htmlPath, 'utf8'); } catch { continue; }
      const postIndex = parseIndexObj(html);
      if (!postIndex || !Array.isArray(postIndex.files)) continue;
      const postDir = path.dirname(htmlPath); // html 所在目录即帖子目录（迁移安全）
      for (const f of postIndex.files) {
        if (f.serverPath && f.rel && f.exists && !path.isAbsolute(f.rel)) {
          const rec = { rel: path.join(postDir, f.rel), size: f.size != null ? Number(f.size) : null };
          index.set(f.serverPath, rec);
          // 网盘项：完整 URL 即键（http/https 前缀天然标识网盘；dropbox 规范 URL 已去 rlkey 等分享参数——同文件不同分享链接归一同复用）；旧格式（typeId:）兼容
          if (/^https?:/i.test(f.serverPath)) index.set(f.serverPath, rec);
          else if (/^[a-z]+:/i.test(f.serverPath) && f.netdiskId) index.set(`${f.serverPath.split(':')[0]}Id:${f.netdiskId}`, rec);
        }
      }
    }
  }
  log(`[索引] 去重扫描范围 ${scopeDirs.size} 个作者账号目录（主账号 + 关联渠道），聚合 ${index.size} 条记录`);
  return index;
}

/** 硬链接目标；失败（跨卷/NFS 不支持）回退复制，保证功能正确 */
async function linkOrCopy(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.link(src, dest);
    return 'linked';
  } catch {
    await fs.promises.copyFile(src, dest);
    return 'copied';
  }
}

/**
 * 下载流程（每帖：先生成 html → 校验 → 去重 → 下载）：
 * 1) 【去重】目标已存在：与 html 记录 size 比对——一致 → exists 跳过；
 *    不一致（损坏/不完整/源站变更）→ 删除旧文件重新下载（.tmp 断点续传保留）
 * 2) 【校验·反爬检测】将下载的文件：html 记录有 size → 探测源站大小
 *    与记录不符（源站返回占位/变更）→ 不下载 record_mismatch
 * 3) in-flight 同 URL 并发 → 等首个完成再判断（竞态防护）
 * 4) 硬链接复用：记录 rel 本地存在 → 0 下载复用（校验/去重通过后）
 * 5) 下载（downloadFile .tmp 续传）→ 成功后登记 size（下次 html 刷新/校验依据）
 * 返回状态：'exists' | 'record_mismatch' | 'linked' | 'copied' | 'downloaded' | 'failed:...'
 */
async function downloadWithDedup(job, hashIndex, inFlight, opts = {}) {
  const rec = hashIndex.get(job.serverPath); // html 记录 {rel, size}
  const expected = rec && rec.size != null ? Number(rec.size) : (job.apiSize ?? null); // 大小基准：html 记录 → API size 兜底

  // .tmp 分类：正式缺失 + .tmp 在 = 断点续传基础（保留）；正式已存在 + .tmp 残留 = 冗余（下载完成——续传无意义）→ 清
  if (await fileExists(job.savePath) && await fileExists(job.savePath + CONFIG.tempSuffix)) {
    await fs.promises.rm(job.savePath + CONFIG.tempSuffix, { force: true }).catch(() => {});
    log(`[.tmp 冗余清理] ${job.filename}（正式已存在——清除残留 .tmp）`);
  }

  // ---- 1) 去重：目标已存在时按大小判定（正确 → 跳过；大小不符 → 覆盖重下） ----
  if (await fileExists(job.savePath)) {
    if (expected == null) return { status: 'exists', job }; // 无记录可比，保守跳过
    let localSize = null;
    try { localSize = (await fs.promises.stat(job.savePath)).size; } catch { /* 竞态：文件刚消失则继续下载 */ }
    if (localSize !== null && localSize === expected) return { status: 'exists', job };
    // 大小不符：删除错误的正式文件，保留 .tmp 走续传重新下载
    console.log(`  [大小不符覆盖] ${job.filename}（本地 ${localSize ?? '缺失'}B ≠ 记录 ${expected}B，删除重下）`);
    log(`[去重] ${job.filename} 大小不符（本地 ${localSize} ≠ 记录 ${expected}），覆盖重下`);
    await fs.promises.rm(job.savePath, { force: true });
  }

  // ---- 2)【已移除探测请求】反爬检测改为下载后完整性校验（downloadFile 校验 Content-Length / 376 占位）：
  //      每文件仅 1 请求（下载），376B 占位是字节级代价，探测是请求级——用下载后校验兜底更省 ----

  // ---- 3) in-flight 并发同 URL：等首个完成（之后命中记录复用或 exists） ----
  if (inFlight.has(job.serverPath)) {
    await inFlight.get(job.serverPath);
    const rec2 = hashIndex.get(job.serverPath);
    if (rec2 && rec2.rel && rec2.rel !== job.savePath && await fileExists(rec2.rel)) {
      const how = await linkOrCopy(rec2.rel, job.savePath);
      await fs.promises.rm(job.savePath + CONFIG.tempSuffix, { force: true }).catch(() => {}); // 链接复用成功——正式已就位——清冗余 .tmp
      return { status: how === 'linked' ? 'linked' : 'copied', job };
    }
    if (await fileExists(job.savePath)) return { status: 'exists', job };
  }

  // ---- 4) 硬链接去重复用：记录 rel 本地存在 → 0 下载复用（校验过后） ----
  if (rec && rec.rel && rec.rel !== job.savePath && await fileExists(rec.rel)) {
    const how = await linkOrCopy(rec.rel, job.savePath);
    await fs.promises.rm(job.savePath + CONFIG.tempSuffix, { force: true }).catch(() => {}); // 链接复用成功——正式已就位——清冗余 .tmp
    return { status: how === 'linked' ? 'linked' : 'copied', job };
  }

  // ---- 5) 下载（跨进程文件锁：同 serverPath 并发多 cli 只有一个下——拿不到=别处 cli 在下 → 跳过防重复） ----
  const lockPath = await acquireLock(job.serverPath);
  if (!lockPath) return { status: 'exists', job }; // 跨进程锁（2026-09-29——别处正在下载——跳过）
  const p = downloadFile(job, { ...opts, expectedSize: expected, abortCtl: opts.abortCtl || null }); // 任务 abort 级联（2026-09-29——真中断）
  inFlight.set(job.serverPath, p);
  try {
    const r = await p;
    if (r.status === 'downloaded') { // 登记 size（落盘实际大小，供 html 刷新/下次校验）
      const st = await fs.promises.stat(job.savePath).catch(() => null);
      hashIndex.set(job.serverPath, { rel: job.savePath, size: st ? st.size : null });
    }
    return r;
  } finally {
    inFlight.delete(job.serverPath);
    await releaseLock(lockPath); // 跨进程锁释放（2026-09-29）
  }
}

// ---------- 下载结果索引落盘（pawchive-index.html；dryrun 不调用） ----------
/** 按帖聚合文件并 stat 实态（一次遍历，避免多次全量扫描） */
async function collectPostFiles(plan) {
  // 从磁盘扫各帖 html 聚合（惰性计划下 plan.files 为空——文件按帖下载时才生成；
  // 依赖磁盘真实状态而非内存计划，保证创作者总览的 fileCount/downloaded 准确）
  const out = new Map();
  for (const htmlPath of await walkHtmlFiles(plan.creatorDir)) {
    let postIndex;
    try { postIndex = parseIndexObj(await fs.promises.readFile(htmlPath, 'utf8')); } catch { continue; }
    if (!postIndex || postIndex.type !== 'post' || !postIndex.postId) continue;
    const postDir = path.dirname(htmlPath);
    const files = [];
    for (const f of (postIndex.files || [])) {
      if (!f.rel) continue;
      let size = 0;
      try { size = (await fs.promises.stat(path.join(postDir, f.rel))).size; } catch { /* 缺失/未下载 */ }
      files.push({ filename: f.filename || f.rel, size: f.size ?? size, exists: size > 0, serverPath: f.serverPath, rel: f.rel });
    }
    out.set(String(postIndex.postId), { post: { id: postIndex.postId, title: postIndex.title || '', published: postIndex.published || null, driveLinks: postIndex.driveLinks === true }, postDir, files });
  }
  return out;
}

/**
 * 每帖生成索引 html（含正文 + files hash 登记 = 去重登记源）。
 * 下载流程约定：每帖**下载前先写**（html 先落盘，size=当前落盘/缺失），
 * 帖内文件下载完成后**再刷新一次**（size=实际落盘，图片墙/状态更新）。
 * 文件名取 PAWCHIVE_INDEX_FILENAME；postDir 写相对目标根路径。
 */
async function writeOnePostIndex(post, jobs, creatorName, targetPath) {
  if (!jobs || !jobs.length) return; // 纯文字帖等无文件帖子：不生成索引（也无目录可写）
  const postDir = jobs[0].postDir;
  const files = [];
  for (const j of jobs) {
    let size = 0;
    try { size = (await fs.promises.stat(j.savePath)).size; } catch { /* 缺失/未下载 */ }
    files.push({ filename: j.filename, size: j.apiSize ?? size, exists: size > 0, serverPath: j.serverPath, rel: path.relative(postDir, j.savePath) }); // size：API 值优先（文件真实大小），本地 stat 兜底；网盘项 serverPath=完整网址（天然标识网盘 + 去重/复用键）
  }
  const html = buildPostIndexHtml(post, creatorName, path.relative(targetPath, postDir), files);
  await fs.promises.mkdir(postDir, { recursive: true });
  await fs.promises.writeFile(path.join(postDir, CONFIG.indexFilename), html, 'utf8');
  log(`[索引] ${path.relative(targetPath, postDir)}/${CONFIG.indexFilename} 已生成`);
}

/** 创作者级总览 html（帖子导航 + 关联渠道 links）；串行写锁：并发多帖完成时逐个刷新，防同文件写交错 */
let creatorIndexWriteChain = Promise.resolve();
async function writeCreatorIndex(plan, targetPath, abortCtl = null) {
  const task = creatorIndexWriteChain.then(async () => {
    const avatars = await downloadCreatorAvatars(plan, abortCtl); // 头像：主账号 + 关联渠道各账号（已存在跳过）；abort 透传（任务中断不再下头像）
    const byPost = await collectPostFiles(plan);
    const summary = [];
    // 基于磁盘全部帖 html（不是 plan.posts——部分运行如 --length N 时 plan.posts 只是子集，避免覆盖丢失全量记录）
    for (const [postId, entry] of byPost) {
      summary.push({
        title: entry.post.title || '', postId, published: entry.post.published || null,
        relDir: entry.postDir ? path.relative(targetPath, entry.postDir) : null,
        fileCount: entry.files.length,
        downloaded: entry.files.filter(f => f.exists).length,
        driveLinks: entry.post.driveLinks === true, // 正文有网盘链接 → 快速跳过会漏网盘，需标记
      });
    }
    summary.sort((a, b) => String(b.published || '').localeCompare(String(a.published || ''))); // 时间倒序（新帖在前）
    const html = buildCreatorIndexHtml(plan, summary, plan.links || [], avatars);
    await fs.promises.mkdir(plan.creatorDir, { recursive: true });
    await fs.promises.writeFile(path.join(plan.creatorDir, CONFIG.indexFilename), html, 'utf8');
  });
  creatorIndexWriteChain = task.catch(() => {});
  return task;
}

/**
 * 下载进度聚合器（数据模型对齐 KToolBox Rich / gbmd / iwara）：
 * - 文件级：filename / doneBytes / total / percent / speed / state
 * - 整体级：filesDone / filesTotal / overallPercent / totalSpeed / 状态计数
 */
function createProgressTracker(totalFiles, tty) {
  const counts = { downloaded: 0, existed: 0, failed: 0 };
  const active = new Map();       // savePath -> {filename, doneBytes, total, percent, speed, state}
  const failedSet = new Set();
  let lastRender = 0;
  let prevLen = 0;

  const overall = () => {
    const done = counts.downloaded + counts.existed;
    const pct = totalFiles ? Math.min(100, (done / totalFiles) * 100) : 0;
    const totalSpeed = [...active.values()].reduce((s, a) => s + (a.speed || 0), 0); // 总速度=活动求和（iwara totalSpeed 同款）
    return { done, pct, totalSpeed };
  };

  return {
    counts, failedSet, overall,
    /** 文件级进度事件（downloadFile.onProgress 转发） */
    onProgress(p) {
      const key = p.savePath || p.filename;
      const prev = active.get(key) || {};
      active.set(key, { ...prev, ...p });
      if (tty) this.maybeRender();
    },
    /** 文件结束：status = downloaded | existed | failed */
    onFinish(filename, status) {
      active.delete(filename);
      if (status === 'downloaded') counts.downloaded++;
      else if (status === 'existed') counts.existed++;
      else { counts.failed++; failedSet.add(filename); }
      if (tty) this.render();
    },
    maybeRender() {
      const now = Date.now();
      if (now - lastRender >= 200) { lastRender = now; this.render(); } // 200ms 节流刷新（同 KToolBox refresh_per_second=10）
    },
    /** TTY 单行实时进度条（\r 刷新，非 TTY 不调用）。学 KToolBox rich 输出：图形 BarColumn + 颜色 + 速度列 */
    render() {
      const { done, pct, totalSpeed } = overall();
      const barW = 18;
      const filled = Math.round((pct / 100) * barW);
      const bar = `\x1b[32m${'█'.repeat(filled)}\x1b[90m${'░'.repeat(barW - filled)}\x1b[0m`; // 绿=完成 灰=待下载（rich BarColumn 同款）
      const activeLines = [...active.values()].slice(0, 2)
        .map(a => `${String(a.filename || '').slice(0, 26)} ${(a.percent || 0).toFixed(0)}% ${fmtSpeed(a.speed)}`)
        .join(' | ');
      const line = `\r[下载] ${bar} ${done}/${totalFiles} ${pct.toFixed(1)}% 新${counts.downloaded} 跳${counts.existed} 败${counts.failed} 总速 ${fmtSpeed(totalSpeed)}  ${activeLines}`;
      const pad = ' '.repeat(Math.max(0, prevLen - line.length));
      process.stdout.write(line + pad + '\r');
      prevLen = line.length;
    },
    finishLine() { process.stdout.write('\n'); }, // 结束进度条行
  };
}

/**
 * 下载上下文（一次作者任务共享）：计划目录结构、全局 hash 去重索引、统计与展示状态。
 */
async function initDownloadCtx(posts, meta, targetPath) {
  const plan = await finalizePlan({ ...meta, posts }, targetPath);
  const hashIndex = await buildHashIndex(targetPath, plan); // 只扫该作者全部账号目录（links 从创作者级 html 读）
  return {
    plan, hashIndex,
    tty: !!process.stdout.isTTY && !process.env.NO_COLOR, // 同 KToolBox plain 判定
    allChecked: [],        // 全量 checked（终态 plan.files，供创作者总览索引）
    newCount: 0, existCount: 0, probeSlow: 0, probeFail: 0,
    sw: { downloaded: 0, existed: 0, failed: 0, failedNames: [], skipPosts: 0 },
    dlStartMs: Date.now(),
  };
}

/**
 * 【下载帖子修订版本】参考原版 include_revisions：每个修订版下载到 帖目录/revisions/<revision_id>/（revision_dirname_format 用 {revision_id}）。
 * 复用现有下载机制（planPostFiles + downloadWithDedup + hashIndex 去重 + writeOnePostIndex 写修订版索引）。
 */
async function downloadRevision(revision, postDir, hashIndex, { concurrency = 1, tty = false, creatorName = '', dryrun = false, onEvent } = {}) {
  const emit = onEvent || (() => {});
  const revisionDir = path.join(postDir, CONFIG.revisionsSubdir, String(revision.revision_id));
  const jobs = planPostFiles(revision, revisionDir).map(j => ({ ...j, post: revision, postDir: revisionDir }));
  const checked = [];
  for (const job of jobs) {
    let exists = false;
    if (await fileExists(job.savePath)) exists = true; // 修订版无历史记录可比——存在即跳过
    checked.push({ ...job, exists, corrupt: false });
  }
  if (dryrun) { // 复用现有 dryrun 语义：只展示计划不落盘（修订版文件列表）
    console.log(`  [修订 ${revision.revision_id} DRYRUN] ${checked.map(j => `${j.exists ? '[已存在]' : '[新建]'} ${j.filename}`).join('\n  ')}`);
    return { files: checked.length, downloaded: 0, existed: checked.filter(j => j.exists).length };
  }
  const todo = checked.filter(j => !j.exists);
  const tracker = createProgressTracker(Math.max(1, todo.length), tty);
  if (tty) tracker.render();
  const inFlight = new Map(); // 同 URL 并发锁
  let next = 0;
  const postConc = Math.max(1, Math.min(concurrency, todo.length));
  const workers = Array.from({ length: postConc }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= todo.length) return;
      const job = todo[idx];
      emit({ type: 'job.queued', data: { creator: (job.post && job.post.creatorName) || '', filename: job.filename } }); // 文件 job 入队（对齐原版 job_queued——queued_files 累计）
      emit({ type: 'download.started', data: { filename: job.filename, creator: (job.post && job.post.creatorName) || '' } }); // 下载开始事件（引擎全流程自含，字段留给上层聚合）
      let retryCount = 0; // download.retrying 重试计数（downloadFile 重试时累加）
      const r = await downloadWithDedup(job, hashIndex, inFlight, {
        abortCtl: opts.abortCtl || null, // 任务 abort 级联（2026-09-29——真中断）
        onProgress: p => {
          tracker.onProgress({ ...p, savePath: job.savePath });
          emit({ type: 'job.progress', data: { filename: job.filename, percent: p.percent ?? null, size: p.doneBytes ?? p.size ?? null, speed: p.speed ?? null, totalSize: p.total ?? null, creator: (job.post && job.post.creatorName) || '' } });
          if (String(p.state).startsWith('retry:')) { // 下载重试状态事件（引擎重试上报，字段供上层判断）
            emit({ type: 'download.retrying', data: { filename: job.filename, retry_count: ++retryCount } });
          }
        },
      });
      const status = ['downloaded', 'downloaded_thumb', 'linked', 'copied'].includes(r.status) ? 'downloaded'
        : ['exists', 'record_mismatch', 'thumb_exists'].includes(r.status) ? 'existed'
        : r.status === 'failed:aborted' ? 'aborted' : 'failed'; // abort 不标 failed（对齐原版 CancelledError——不虚高 failed_files）
      tracker.onFinish(job.savePath, status);
      emit({ type: `job.${status}`, data: { filename: job.filename, size: r.size ?? null, savePath: r.savePath || job.savePath, rawStatus: r.status } }); // savePath/rawStatus：产物登记（③ delete outputs——core 只登记真下载 downloaded/downloaded_thumb；linked/copied 硬链接复用/exists 不算本任务产物；downloaded_thumb 用实际缩略图路径）
      emit({ type: 'download.finished', data: { filename: job.filename, outcome: status, status, size: r.size ?? null } }); // 下载完成事件（引擎结果上报：outcome/status/size）
      if (!tty) console.log(`  [修订${status === 'downloaded' ? '下载' : status === 'existed' ? '已存在' : '失败'}] ${job.filename}`);
    }
  });
  await Promise.all(workers);
  if (tty) tracker.finishLine();
  await writeOnePostIndex(revision, checked, creatorName, revisionDir); // 修订版索引 html（含文件列表/机读块）
  emit({ type: 'revision.completed', data: { postId: revision.id, revisionId: revision.revision_id, files: checked.length, downloaded: tracker.counts.downloaded, existed: tracker.counts.existed } });
  console.log(`  [修订 ${revision.revision_id}] ${checked.length} 文件（新 ${tracker.counts.downloaded} / 已有 ${tracker.counts.existed}）`);
  return { files: checked.length, downloaded: tracker.counts.downloaded, existed: tracker.counts.existed };
}

/**
 * 【按帖子下载】只接受一个帖子链接（列表项）：解析该帖完整内容（getPost）并在其目录执行
 * 完整下载流程：前置 html → 源站校验[反爬检测] → 去重[大小不符覆盖] → 下载[.tmp 续传] →
 * 后置刷新 html。被 downloadAuthor 循环调用（次数 = 帖子数）；独立调用时自行初始化上下文并收尾。
 * @param listPost 单个帖子（链接级；旧缓存已含 file 时直接复用）
 * @param postIndex 该帖在 posts 数组中的下标（用于定位 postDir；独立调用传 0）
 * @param shared 下载上下文（downloadAuthor 传入复用；null = 独立单帖调用）
 */
async function downloadOnePost(listPost, meta, targetPath, opts = {}, shared = null, postIndex = 0) {
  const { dryrun, probe, concurrency, inPostConcurrency, abortCtl } = opts;
  const emit = opts.onEvent || (() => {}); // 可选事件回调（core 事件化；纯附加不影响下载逻辑）
  const ctx = shared || await initDownloadCtx([listPost], meta, targetPath);
  const { plan, hashIndex, tty, sw, allChecked } = ctx;
  const mode = probe ? 'PROBE' : (dryrun ? 'DRYRUN' : 'DOWNLOAD');
  if (!shared) {
    // 独立单帖调用：打印上下文头
    console.log(`[${mode}] 创作者目录: ${plan.creatorDir}`);
    console.log(`[${mode}] 帖子数: ${plan.posts.length}`);
  }
  const postDir = plan.postDirByPost[postIndex];
  log(`[下载] 帖子 ${listPost.id} 开始`);
  // ① 按需解析该帖完整内容：列表/旧缓存已含 file 则直接复用，否则 getPost（只解析当前这一帖）
  const detail = (listPost.file || (listPost.attachments && listPost.attachments.length))
    ? listPost
    : await getPost(meta.service, meta.userId, listPost.id).catch(err => {
      console.log(`  [详情失败] ${listPost.title || listPost.id}（${extractStatus(err)}），跳过该帖`);
      log(`[详情] 帖子 ${listPost.id} 解析失败 ${extractStatus(err)}，跳过`);
      return null;
    });
  if (!detail) return { files: 0, downloaded: 0, failed: 0 };
  emit({ type: 'post.started', data: { postId: detail.id || listPost.id, title: detail.title || listPost.title || '' } });
  const jobs = planPostFiles(detail, postDir).map(j => ({ ...j, post: detail, postDir }));

  // ② 该帖大小感知检查（html 记录 size 与本地一致 → 跳过；存在但大小不符 → 覆盖重下；缺失 → 新建）
  const checked = [];
  for (const job of jobs) {
    const rec = hashIndex.get(job.serverPath);
    let exists = false, corrupt = false;
    if (await fileExists(job.savePath)) {
      if (rec && rec.size != null) {
        let localSize = null;
        try { localSize = (await fs.promises.stat(job.savePath)).size; } catch { /* 竞态：文件刚消失则按新建处理 */ }
        corrupt = (localSize !== null && localSize !== Number(rec.size)) || localSize === CONFIG.antibotSize; // 反爬占位特征，视为损坏覆盖重下
        exists = !corrupt;
        // 冗余 = 该文件【正式版已下载完成（存在且大小与记录一致）】且【.tmp 同时存在】→ 残留 tmp 无续传意义，清掉；
        // 其余情况（正式缺失 + .tmp 在 = 断点续传基础；corrupt 大小不符 = 覆盖前保留 .tmp 续传）一律不清
        if (exists) await fs.promises.rm(job.savePath + CONFIG.tempSuffix, { force: true }).catch(() => {});
      } else {
        exists = true; // 无记录可比，保守视为已存在（不重下）
        await fs.promises.rm(job.savePath + CONFIG.tempSuffix, { force: true }).catch(() => {}); // 正式在（保守已存在）——残留 .tmp 为冗余，清
      }
    }
    checked.push({ ...job, exists, corrupt });
  }
  ctx.newCount += checked.filter(j => !j.exists).length;
  ctx.existCount += checked.filter(j => j.exists).length;
  if (checked.length) console.log(`  ── ${detail.title || detail.id}（${checked.length} 文件）──`);
  for (const job of checked) {
    const tag = job.corrupt ? '[覆盖]   ' : (job.exists ? '[已存在]' : '[新建]   ');
    console.log(`  ${tag} ${job.filename}  <- ${job.fileUrl}`);
  }

  // probe：该帖真实下载不落盘测速（观察 file host 限频窗口）
  if (probe) {
    const windowMs = Number(process.env.PAWCHIVE_PROBE_MS || 5000);
    for (const job of checked) {
      const r = await probeFileSpeed(job.fileUrl, windowMs);
      const limited = r.speedBps > 0 && r.speedBps < CONFIG.slowSpeedKb * 1024;
      if (limited) ctx.probeSlow++;
      else if (r.speedBps === 0) ctx.probeFail++;
      console.log(`  ${(limited ? '⚠慢速' : r.speedBps > 0 ? 'ok' : '失败').padEnd(6)} ${fmtSpeed(r.speedBps).padStart(10)} ${job.filename}`);
      await sleep(100); // 每文件间隔，避免测速本身触发限频
    }
    allChecked.push(...checked);
    return { files: checked.length, downloaded: 0, failed: ctx.probeFail };
  }
  if (dryrun) {
    // dryrun 也展示修订版本计划（默认开修订——fetchPostRevisions + downloadRevision dryrun 不落盘）
    if (CONFIG.includeRevisions) {
      const revisions = await fetchPostRevisions(meta.service, meta.userId, detail.id || listPost.id);
      for (const rev of revisions) {
        if (!rev || rev.revision_id == null) continue;
        await downloadRevision(rev, postDir, hashIndex, { concurrency, tty, creatorName: plan.creatorName, dryrun, onEvent: emit });
      }
    }
        // dryrun 模拟网盘下载：只解析正文网盘链接展示计划（不请求网盘网络——网盘不可访问也能看到将下载项）
    let netdiskPlan = 0;
    if (CONFIG.downloadDrive) {
      const content = detail.content || '';
      for (const [type, p] of Object.entries(NETDISK_PROVIDERS)) {
        const m = content.match(p.match);
        if (m) {
          netdiskPlan++;
          const id = p.extract(m[0]);
          const fbMatch = /[^/?#]+(?=\?|$)/.exec(String(id).split('#')[0]);
          const fb = fbMatch ? fbMatch[0] : `${type}_${id}`;
          console.log(`  [网盘计划] ${type} ${fb} <- ${String(id).slice(0, 70)}${CONFIG.downloadDrive ? '' : '（网盘下载已关）'}`);
        }
      }
      // dryrun 模拟 html 变更：下载后 html 将写入的记录（附件/图片 + 网盘成功项）与正文本地化
      console.log(`  [HTML] 将写 pawchive-index.html：文件 ${checked.length} 项 + 网盘 ${netdiskPlan} 项（成功则正文网盘链接本地化 ${netdiskPlan} 处；失败项不记录、正文保持原始 URL）`);
    } else {
      console.log(`  [HTML] 将写 pawchive-index.html：文件 ${checked.length} 项（网盘下载已关）`);
    }
    allChecked.push(...checked); return { files: checked.length, downloaded: 0, failed: 0 };
  } // dryrun 只展示计划

  // ③ 前置 html：下载前先生成该帖索引（html 先落盘；已存在则覆盖重写，size 按下载前实态）
  await writeOnePostIndex(detail, checked, plan.creatorName, targetPath);
  // ③.5 附件子目录（PAWCHIVE_ATTACHMENTS_SUBDIR，默认空=帖根目录；非空时预建子目录供附件落盘）
  if (CONFIG.attachmentsSubdir) await fs.promises.mkdir(path.join(postDir, sanitizeName(CONFIG.attachmentsSubdir)), { recursive: true });
  // ④ 帖内下载：同帖文件并发（独立调用用 concurrency；downloadAuthor 并行模式下传 1——全局并发=并行帖数，等价 worker 池式并发）
  const todoJobs = checked.filter(j => !j.exists); // 新建 + 大小不符覆盖
  log(`[下载] 帖子 ${detail.id} 待下载 ${todoJobs.length} 个文件（html 记录 ${hashIndex.size} 条，按记录 size 对照）`);
  const tracker = createProgressTracker(Math.max(1, todoJobs.length), tty);
  if (tty) tracker.render();
  const inFlight = new Map(); // 同 URL 并发锁（防同帖重复项重复下载）
  const postConc = Math.max(1, Math.min(inPostConcurrency ?? concurrency, todoJobs.length));
  let next = 0;
  const workers = Array.from({ length: postConc }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= todoJobs.length) return;
      const job = todoJobs[idx];
      emit({ type: 'job.queued', data: { creator: '', filename: job.filename } }); // 修订文件入队（对齐原版 job_queued）
      emit({ type: 'download.started', data: { filename: job.filename, creator: '' } }); // 下载开始事件（修订下载路径——引擎全流程自含）
      let retryCount = 0;
      const r = await downloadWithDedup(job, hashIndex, inFlight, {
        abortCtl: opts.abortCtl || null, // 任务 abort 级联（2026-09-29——真中断）
        onProgress: p => {
          tracker.onProgress({ ...p, savePath: job.savePath });
          emit({ type: 'job.progress', data: { filename: job.filename, percent: p.percent ?? null, size: p.doneBytes ?? p.size ?? null, speed: p.speed ?? null, totalSize: p.total ?? null, creator: (job.post && job.post.creatorName) || '' } });
          if (String(p.state).startsWith('retry:')) {
            emit({ type: 'download.retrying', data: { filename: job.filename, retry_count: ++retryCount } });
          }
        },
      });
      // downloaded/downloaded_thumb/linked/copied 都算完成（linked/copied=0 下载硬链接/复制复用；downloaded_thumb=缩略图回退新下载；thumb_exists=缩略图已存在→计入已存在跳过）
      const status = ['downloaded', 'downloaded_thumb', 'linked', 'copied'].includes(r.status) ? 'downloaded'
        : ['exists', 'record_mismatch', 'thumb_exists'].includes(r.status) ? 'existed'
        : r.status === 'failed:aborted' ? 'aborted' : 'failed'; // abort 不标 failed（对齐原版 CancelledError——不虚高 failed_files）
      tracker.onFinish(job.savePath, status);
      emit({ type: `job.${status}`, data: { filename: job.filename, size: r.size ?? null, savePath: r.savePath || job.savePath, rawStatus: r.status } }); // savePath/rawStatus：产物登记（③ delete outputs——core 只登记真下载 downloaded/downloaded_thumb；linked/copied 硬链接复用/exists 不算本任务产物；downloaded_thumb 用实际缩略图路径）
      emit({ type: 'download.finished', data: { filename: job.filename, outcome: status, status, size: r.size ?? null } });
      // 日志带文件大小（反爬 376B 占位一目了然）
      log(`[下载] ${r.status} ${job.filename}${r.size != null ? ` ${fmtBytes(r.size)}` : ''}`);
      if (!tty) { // 非 TTY（管道/重定向/NO_COLOR）：逐行状态输出
        const mark = r.status === 'downloaded' ? '下载完成'
          : r.status === 'downloaded_thumb' ? '缩略图回退'
          : r.status === 'thumb_exists' ? '缩略图已存在'
          : r.status === 'linked' ? '硬链接复用'
          : r.status === 'copied' ? '复制复用' : r.status === 'exists' ? '已存在跳过' : r.status === 'record_mismatch' ? '记录不符跳过' : `失败(${r.status})`;
        console.log(`  [${mark}] ${job.filename}${r.size != null ? ` ${fmtBytes(r.size)}` : ''}`);
      }
    }
  });
  await Promise.all(workers);
  if (tty) tracker.finishLine();
  sw.downloaded += tracker.counts.downloaded;
  sw.existed += tracker.counts.existed;
  sw.failed += tracker.counts.failed;
  sw.failedNames.push(...tracker.failedSet);

  // ⑤.5 网盘（可扩展 provider：drive/mega/baidu...）下载：正文网盘链接 → 下载/跨帖复用 → 并入 checked 写进 html 记录
  const netdiskJobs = await downloadNetdiskFiles(detail, postDir, hashIndex);
  if (netdiskJobs.length) checked.push(...netdiskJobs);
  for (const nj of netdiskJobs) emit({ type: 'netdisk.downloaded', data: { filename: nj.filename, size: nj.size ?? null } });

  // ⑤ 后置 html：下载完成刷新该帖索引（size=实际落盘，图片墙/状态更新）
  await writeOnePostIndex(detail, checked, plan.creatorName, targetPath);
  allChecked.push(...checked);
  // ⑥ 每帖下载完即刷新创作者级总览 html（含全跳过帖；并发完成由串行写锁逐个刷新，中断后可看实时进度）
  await writeCreatorIndex(plan, targetPath, abortCtl);
  // ⑥.5 修订版本下载（PAWCHIVE_INCLUDE_REVISIONS=1 时——参考原版 include_revisions：每修订版下到 帖目录/revisions/<revision_id>/）
  if (CONFIG.includeRevisions) {
    const revisions = await fetchPostRevisions(meta.service, meta.userId, detail.id || listPost.id);
    for (const rev of revisions) {
      if (!rev || rev.revision_id == null) continue;
      await downloadRevision(rev, postDir, hashIndex, { concurrency: postConc, tty, creatorName: plan.creatorName, dryrun, onEvent: emit });
    }
  }
  emit({ type: 'post.completed', data: { postId: detail.id || listPost.id, title: detail.title || '', files: checked.length, downloaded: tracker.counts.downloaded, existed: checked.filter(j => j.exists && !j.corrupt).length, failed: tracker.counts.failed, hasJobs: todoJobs.length > 0 } }); // hasJobs：该帖是否发过 job.* 事件（2026-09-29 修复 progressReducer 双计——有 job 事件时帖级汇总不叠加）
  return { files: checked.length, downloaded: tracker.counts.downloaded, failed: tracker.counts.failed };
}

/**
 * 【按作者下载】= 获取作者帖子链接数组后，循环调用 downloadOnePost，循环次数 = 帖子数。
 * 严格按帖串行：一帖完整走完（解析 → 检查 → 前置 html → 校验/去重/下载 → 后置 html）
 * 并帖间等待后才解析/下载下一帖；绝不在下载前批量解析帖子内容（防反爬）。
 * 最后写创作者级总览索引并汇总。
 */
/** 从旧帖 html 提取人读正文区（<div class="desc">…</div>，平衡 div 深度防嵌套截断） */
function extractDescHtml(html) {
  const open = '<div class="desc">';
  const s = String(html || '').indexOf(open);
  if (s < 0) return null;
  let i = s + open.length;
  let depth = 1;
  const h = String(html);
  while (i < h.length) {
    const ni = h.indexOf('<div', i);
    const nc = h.indexOf('</div>', i);
    if (nc < 0) return null;
    if (ni >= 0 && ni < nc) { depth++; i = ni + 5; }
    else { depth--; if (depth === 0) return h.slice(s + open.length, nc); i = nc + 6; }
  }
  return null;
}

/** 快速跳过：纯本地 html 刷新（零网络/零下载配额）——旧 html 记录 + 磁盘 stat 校验 + 正文网盘项重建 → 重写帖 html。
 * 返回 true=下载完成（已刷新 html）；false=未完成（文件缺失/大小不符/正文网盘本地无对应文件/无旧 html）→ 调用方回退正常下载。 */
async function refreshPostIndexLocal(listPost, plan, targetPath, hashIndex) {
  const postDir = path.join(targetPath, listPost.relDir);
  const htmlPath = path.join(postDir, CONFIG.indexFilename);
  let oldHtml = '';
  let old;
  try { oldHtml = await fs.promises.readFile(htmlPath, 'utf8'); old = parseIndexObj(oldHtml); } catch { return false; }
  if (!old || !Array.isArray(old.files)) return false; // 无旧 html（人为删除）→ 未完成走下载
  const files = [];
  for (const f of old.files) {
    const full = path.join(postDir, f.rel);
    let size = 0;
    try { size = (await fs.promises.stat(full)).size; } catch { return false; } // 缺文件 → 未完成
    if (f.size != null && size !== Number(f.size)) return false; // 大小不符 → 未完成
    files.push({ filename: f.filename, size, exists: true, serverPath: f.serverPath, rel: f.rel, kind: f.kind });
  }
  // 正文网盘项重建（旧 html 未记录网盘也能发现）：复用 cli 公共逻辑——matchNetdiskLink 解析正文网盘链接 + hashIndex URL 键查本地文件（不手写文件名查找）
  const content = extractDescHtml(oldHtml);
  if (content) {
    const hit = matchNetdiskLink(content);
    if (hit) {
      const rec = hashIndex && hashIndex.get(hit.key); // key=完整 URL（drive 构造 share URL、dropbox 规范 URL）——与 buildHashIndex 登记键一致
      if (!rec || !rec.rel) return false; // 正文有网盘链接但本地无对应文件（未下载/未记录）→ 未完成（走正常下载补网盘）
      let size = 0;
      try { size = (await fs.promises.stat(rec.rel)).size; } catch { return false; }
      files.push({ filename: path.basename(rec.rel), size, exists: true, serverPath: hit.key, rel: path.relative(postDir, rec.rel), kind: 'archive' });
    }
  }
  // 重写 html：直接 buildPostIndexHtml + 写已知 postDir（不调 writeOnePostIndex——它按 post.id 派生目录，与创作者总览 relDir 实际目录可能不一致）
  const post = { id: old.postId, service: old.service, user: old.userId, title: old.title, published: old.published, content: content || '' };
  const html = buildPostIndexHtml(post, plan.creatorName, path.relative(targetPath, postDir), files);
  await fs.promises.writeFile(htmlPath, html);
  return true;
}

async function downloadAuthor(posts, meta, targetPath, opts = {}) {
  const { dryrun, probe, concurrency } = opts;
  const emit = opts.onEvent || (() => {}); // 可选事件回调（core 事件化；纯附加）
  const mode = probe ? 'PROBE' : (dryrun ? 'DRYRUN' : 'DOWNLOAD');
  const ctx = await initDownloadCtx(posts, meta, targetPath);
  const { plan, tty } = ctx;
  emit({ type: 'task.started', data: { mode, service: meta.service, userId: meta.userId, posts: posts.length } });

  if (meta.mode === 'creator' && meta.indexFile) {
    console.log(`[${mode}] 索引: ${meta.indexFile}（缓存 ${meta.cachedTotal} 帖（仅链接）/ 本次新拉 ${meta.fetchedNew} 帖${meta.indexDone ? ' / 已拉完' : ''}，帖子详情按帖下载时解析）`);
  }
  // 同作者跨渠道/分号展示（方案 D：三号一人场景活动链接识别）
  if (plan.links && plan.links.length) {
    console.log(`[${mode}] 关联渠道（同作者）：${plan.links.map(l => `${l.service}/${l.id} (${l.name || '-'})`).join('、')}`);
  }
  console.log(`[${mode}] 创作者目录: ${plan.creatorDir}`);
  console.log(`[${mode}] 帖子数: ${plan.posts.length}`);

  // 根据创作者级 html 快速跳过已完整下载的帖（downloaded==fileCount 且 fileCount>0、帖目录存在）：
  // 不再 getPost 解析详情与重复检查（0 文件帖/未生成帖 html 的不跳，照常处理）
  // 【设计】单帖模式（用户显式指定单帖 URL）不做快速跳过——单帖=明确要处理该帖（可能修复/重下/检查），
  // 快速跳过仅面向创作者批量模式：全量补漏时对已完整且无网盘链接的帖零网络本地刷新，省下载配额。
  const completedPosts = new Set();
  try {
    const creatorIndex = parseIndexObj(await fs.promises.readFile(path.join(plan.creatorDir, CONFIG.indexFilename), 'utf8'));
    for (const p of (creatorIndex && creatorIndex.posts) || []) {
      if (meta.mode !== 'post' && CONFIG.fastSkip && p.relDir && p.fileCount > 0 && p.downloaded === p.fileCount && p.driveLinks === false) completedPosts.add(String(p.postId)); // 快速跳过受 PAWCHIVE_FAST_SKIP 控制（默认关→全量检查补外链/网盘；开→仅明确无网盘链接的完整帖跳过）
    }
    if (completedPosts.size) log(`[索引] 创作者总览检测到 ${completedPosts.size} 帖已完整，直接跳过（不解析详情）`);
  } catch { /* 无创作者级 html（首次）→ 全量处理 */ }

  // 并行下载（worker 池式）：同时最多 concurrency 个帖子在处理（每帖内文件串行），
  // 全局下载并发 = concurrency（等价 KToolBox DownloadWorkerPool：N 个 worker 各下各文件）
  const slotCount = Math.max(1, Math.min(Number(concurrency) || 1, posts.length));
  const active = new Set(); // 处理中的帖子 promise（槽位）
  for (let i = 0; i < posts.length; i++) {
    if (meta.mode !== 'post' && completedPosts.has(String(posts[i].id))) {
      // 快速跳过：纯本地 html 刷新（零网络/零下载配额——不拉详情不下载）；磁盘校验不符 → 回退正常下载
      // （单帖模式不跳过——见上方 completedPosts 构建注释：单帖=明确处理该帖）
      const refreshed = await refreshPostIndexLocal(posts[i], plan, targetPath, ctx.hashIndex);
      if (!refreshed) {
        completedPosts.delete(String(posts[i].id));
        log(`[索引] ${posts[i].title || posts[i].id} 本地校验未完成（缺文件/大小不符/网盘未下），回退正常下载`);
      } else {
        if (!tty) console.log(`  [已下载跳过] ${posts[i].title || posts[i].id}（本地刷新 html，零网络）`);
        ctx.sw.skipPosts++; // 快速跳过帖计入统计（finishDownload 汇总显示）
        emit({ type: 'post.skipped', data: { postId: posts[i].id, title: posts[i].title || '' } });
        continue; // 快速跳过：不占槽位、不等待
      }
    }
    // 并发维持：槽位满 → 等任一完成【立即补位】（不额外 sleep，保持并发数恒满）
    if (active.size >= slotCount) {
      await Promise.race([...active].map(p => p.catch(() => null)));
    }
    const p = downloadOnePost(posts[i], meta, targetPath, { ...opts, inPostConcurrency: 1 }, ctx, i)
      .catch(err => {
        console.error(`  [帖子失败] ${posts[i].id} ${err && err.message || err}`);
        log(`[下载] 帖子 ${posts[i].id} 失败: ${err && err.message || err}`);
        return null;
      });
    active.add(p);
    p.finally(() => active.delete(p));
  }
  await Promise.all([...active]);

  return finishDownload(ctx, meta, posts, targetPath, opts);
}

/** 收尾：probe/dryrun 汇总、创作者级总览索引、最终统计（downloadAuthor 与独立单帖共用） */
async function finishDownload(ctx, meta, posts, targetPath, opts) {
  const { dryrun, probe } = opts;
  const mode = probe ? 'PROBE' : (dryrun ? 'DRYRUN' : 'DOWNLOAD');
  const { plan, allChecked, newCount, existCount, probeSlow, probeFail, sw, dlStartMs } = ctx;
  const subject = meta.indexFile ? `索引:${meta.indexFile}`
    : `${meta.service}/${meta.userId}${meta.postId ? `/post/${meta.postId}` : ''}`;
  log(`[任务] ${mode} ${subject} → ${targetPath}（帖子 ${posts.length}，文件计划 ${allChecked.length}，新下载 ${newCount}，已存在 ${existCount}）`);

  if (probe) {
    console.log(`\n[PROBE] 完成：${allChecked.length} 文件，慢速/限频 ${probeSlow} 个、失败 ${probeFail} 个（慢速阈值 ${CONFIG.slowSpeedKb}KB/s）`);
    log(`[probe] ${allChecked.length} 文件测速，慢速 ${probeSlow}，失败 ${probeFail}`);
    return { downloaded: 0, existed: existCount, failed: probeFail, failedNames: [] };
  }
  if (dryrun) {
    // 目录模拟：列出将创建/写入的目录结构
    const dirs = new Set([plan.creatorDir]);
    for (const j of allChecked) if (j.postDir) dirs.add(j.postDir);
    console.log(`\n[DRYRUN] 目录模拟（将创建/写入）：`);
    for (const d of [...dirs].sort()) console.log(`  ${path.relative(targetPath, d) || d}`);
    console.log(`\n[DRYRUN] 仅模拟：以上 ${newCount} 个新文件将被下载（真实运行会写盘），0 字节写入。`);
    log(`[dryrun] ${newCount} 个文件将被下载，目录 ${dirs.size} 个（模拟结束）`);
    return { downloaded: 0, existed: existCount, failed: 0, failedNames: [] };
  }

  // 创作者级总览索引（帖子级 pawchive-index.html 已在每帖下载前写入、下载后刷新；此处只写创作者总览）
  plan.files = allChecked; // collectPostFiles 依赖 plan.files（job 含 post/postDir/savePath）
  await writeCreatorIndex(plan, targetPath, opts.abortCtl);
  console.log(`[DOWNLOAD] 索引已写: ${path.join(plan.creatorDir, CONFIG.indexFilename)}（每帖 ${CONFIG.indexFilename} 下载前生成/完成后刷新）`);

  const dlCostSec = ((Date.now() - dlStartMs) / 1000).toFixed(0);
  console.log(`\n[DOWNLOAD] 完成: 新下载 ${sw.downloaded} / 已存在 ${existCount + sw.existed} / 快速跳过 ${sw.skipPosts} 帖 / 失败 ${sw.failed}${sw.failedNames.length ? `（失败文件: ${sw.failedNames.join(', ')}）` : ''}`);
  if (opts.onEvent) opts.onEvent({ type: 'task.completed', data: { downloaded: sw.downloaded, existed: existCount + sw.existed, failed: sw.failed, skipPosts: sw.skipPosts, failedNames: sw.failedNames } });
  log(`[下载] 完成：新下载 ${sw.downloaded} / 已存在跳过 ${existCount + sw.existed} / 快速跳过 ${sw.skipPosts} 帖 / 失败 ${sw.failed}，用时 ${dlCostSec}s${sw.failedNames.length ? `，失败文件: ${sw.failedNames.join(' | ')}` : ''}`);
  return { downloaded: sw.downloaded, existed: existCount + sw.existed, failed: sw.failed, failedNames: sw.failedNames };
}

// ---------- 主流程 ----------
async function main() { // dsh-skip-func-length（主流程编排，含计划/下载/索引/汇总，拆分收益低）
  const args = process.argv.slice(2);
  const flags = { dryrun: false, probe: false, offset: 0, length: undefined, concurrency: Number(process.env.PAWCHIVE_CONCURRENCY) || 1, index: null };
  const positional = [];
  let positionalOnly = false; // 遇 -- 后所有参数按位置参数处理（路径可含 - 开头）
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { positionalOnly = true; continue; }
    if (positionalOnly) { positional.push(a); continue; }
    if (a === '--dryrun') flags.dryrun = true;
    else if (a === '--probe') flags.probe = true;
    else if (a === '--offset') flags.offset = parseInt(args[++i], 10) || 0;
    else if (a === '--length') flags.length = parseInt(args[++i], 10);
    else if (a === '--concurrency') flags.concurrency = Math.max(1, parseInt(args[++i], 10) || 1);
    
    else if (a === '--index') flags.index = args[++i];
    else if (a.startsWith('-')) { console.error(`未知参数: ${a}`); process.exit(2); }
    else positional.push(a);
  }
  // 2026-09-29：只给 URL 不给 path 时 → 用 .env 的 PAWCHIVE_DATA_ROOT 作下载地址（CONFIG.dataRoot）；两者皆无才报用法
  if (flags.index) {
    if (positional.length < 1) { console.error('用法: node cli.js --index <索引文件> [path]'); process.exit(2); }
  } else if (positional.length < 1) {
    console.error('用法: node cli.js <url> [path] [--dryrun] [--probe] [--offset N] [--length N] [--concurrency N] [--index <索引文件>]'); process.exit(2);
  }
  const url = flags.index ? null : positional[0];
  const targetPath = flags.index ? (positional[1] || CONFIG.dataRoot || '') : (positional[1] || CONFIG.dataRoot || '');
  if (!targetPath) { console.error('缺少下载路径：请在参数传入 path，或 .env 配置 PAWCHIVE_DATA_ROOT'); process.exit(2); }
  const mode = flags.probe ? 'PROBE' : (flags.dryrun ? 'DRYRUN' : 'DOWNLOAD');

  console.log(`[${mode}] ${flags.index ? `索引输入: ${flags.index}` : `URL: ${url}`}`);
  console.log(`[${mode}] 目标: ${targetPath}`);
  console.log(`[${mode}] 拉取 API 并生成计划...`);

  // 获取帖子数组：按作者 = fetchPostsByUrl 拉作者全部帖子链接返回数组；按单帖 = 单元素数组
  let posts, meta;
  if (flags.index) {
    const idx = loadIndex(flags.index);
    if (!idx) { console.error(`无法读取索引文件: ${flags.index}`); process.exit(2); }
    const userId = idx.userId || (idx.posts[0] && idx.posts[0].user) || 'unknown';
    posts = idx.posts;
    meta = {
      mode: 'creator', service: idx.service, userId, postId: null,
      creatorName: idx.creator_name || userId, links: [],
      indexFile: flags.index, fetchedNew: 0, cachedTotal: idx.posts.length, indexDone: !!idx.done,
    }; // --index 模式 0 API，不拉关联渠道
  } else {
    const fetched = await fetchPostsByUrl(url, targetPath, { offset: flags.offset, length: flags.length });
    posts = fetched.posts;
    meta = fetched.meta;
  }
  const dlOpts = { dryrun: flags.dryrun, probe: flags.probe, concurrency: flags.concurrency };
  // 统一走 downloadAuthor（单帖 = 1 帖的作者流程）：共享 finishDownload 收尾——完成统计/创作者级索引；
  // 单帖模式此前直调 downloadOnePost 会跳过收尾（无 [DOWNLOAD] 完成统计）
  const result = await downloadAuthor(posts, meta, targetPath, dlOpts);
  if (result.failed > 0) process.exitCode = 1;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// require.main 守卫：被 migrate.js 等工具 require 时不自动跑 CLI
if (require.main === module) {
  main().catch(err => {
    console.error(`\n[ERROR] ${err && err.stack || err}`);
    process.exit(1);
  });
}

// 导出复用（migrate.js 反推 pawchive-index.html 等工具使用）
module.exports = {
  CONFIG, LOG_PATH, log,
  esc, fmtBytes, fileKind, sanitizeName, buildIndexJsonBlock, parseIndexObj,
  buildPostIndexHtml, buildCreatorIndexHtml,
  walkHtmlFiles, buildHashIndex, linkOrCopy, downloadWithDedup, downloadFile, streamOnce,
  finalizePlan, collectPostFiles, writeOnePostIndex, writeCreatorIndex,
  fetchPostsByUrl, downloadOnePost, downloadAuthor,
  getPost, fetchPostRevisions, fetchAllCreators, // Pawchive 单帖详情 + 修订版本列表 + 创作者全量（引擎 API——供上层调用）
  NETDISK_PROVIDERS, downloadNetdiskFiles, // 网盘 provider 注册表 + 下载（引擎 API——供上层复用）
  extractContentLinks, matchNetdiskLink, buildNetdiskFileMap, extractDescHtml, refreshPostIndexLocal, // 公共函数（外链提取/网盘匹配/URL映射/正文提取/快速跳过本地刷新）
  indexFileFor, loadIndex, saveIndex, fetchPostsWithResume,
};