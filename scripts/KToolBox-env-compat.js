#!/usr/bin/env node
/**
 * KToolBox-env-compat —— env 翻译中枢（双向映射库 + CLI 双模式）
 *
 * 定位（设计文档第十节第 5 项）：兼容层（core/adapter）env 相关全走本模块；cli.js 不动（保持自读 PAWCHIVE_*）。
 *
 * 导出函数（require 用）：
 *   buildMapped()          正向：KTOOLBOX_* env / ktoolbox.toml [naming] → PAWCHIVE_*（现有）
 *   readPawchiveEnv(env?)  PAWCHIVE_* → 配置对象（兼容层 getNaming/config 用）
 *   toKToolBox(env?)       反向：PAWCHIVE_* → KTOOLBOX_* 配置对象（KToolBox 兼容我们——写真实值）
 *   writeEnv(key, value)   .env 更新（PATCH naming/config 保存用）
 *
 * CLI 模式（直接运行）：
 *   ① --gen-env [输出文件]：正向映射导出（KToolBox → PAWCHIVE_*）
 *   ② 同参数调用 cli：映射注入（已有 PAWCHIVE_* 优先）→ 透传启动 cli.js
 *
 * 优先级：已存在的 PAWCHIVE_*（外层环境） > KToolBox 映射 > cli.js 同目录 .env > 默认值。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');
const DEFAULT_ENV_PATH = path.join(__dirname, '..', '.env');

// ---------- 探测 KToolBox project_root（原版同款检测：load_configuration(project_root) 的 env_file=[.env, prod.env] 与 ktoolbox.toml 同一目录） ----------
const projectRoot = process.env.KTOOLBOX_PROJECT_CONFIG
  ? path.dirname(process.env.KTOOLBOX_PROJECT_CONFIG) // KTOOLBOX_PROJECT_CONFIG（原版 env）→ toml 所在目录 = project_root
  : path.join(__dirname, '..', 'docs', '.probe-ktoolbox'); // 默认：本项目参考克隆目录（.env / prod.env / ktoolbox.toml 同目录）
// ---------- 读 ktool .env（KTOOL_ENV 显式优先，否则 project_root 下 .env（prod.env 备用）——只取 KTOOLBOX_* 键） ----------
const envFile = process.env.KTOOL_ENV || path.join(projectRoot, '.env');
const ktoolEnv = {};
try {
  const text = fs.readFileSync(envFile, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const envMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (envMatch && envMatch[1].startsWith('KTOOLBOX_')) ktoolEnv[envMatch[1]] = envMatch[2].trim();
  }
} catch { /* 无 KToolBox .env：兼容层空转 */ }

// ---------- 读 ktoolbox.toml 的 [naming] 表（KTOOLBOX_TOML / KTOOLBOX_PROJECT_CONFIG 显式优先，否则 project_root 下 ktoolbox.toml——与 env 同目录） ----------
const tomlFile = process.env.KTOOLBOX_TOML || process.env.KTOOLBOX_PROJECT_CONFIG || path.join(projectRoot, 'ktoolbox.toml');
const tomlNaming = {};
try {
  let inNaming = false;
  for (const line of fs.readFileSync(tomlFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) { inNaming = trimmed === '[naming]'; continue; }
    if (!inNaming || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const kvMatch = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(trimmed);
    if (kvMatch) tomlNaming[kvMatch[1]] = kvMatch[2];
  }
} catch { /* 无 ktoolbox.toml */ }

// ---------- 正向：KToolBox → PAWCHIVE_*（现有 buildMapped——两种模式共用） ----------
function buildMapped() {
  const mapped = {};
  const set = (k, v) => { if (v !== undefined && v !== null && String(v) !== '') mapped[k] = String(v); };
  set('PAWCHIVE_CONCURRENCY', ktoolEnv['KTOOLBOX_JOB__COUNT']); // 下载并发
  set('PAWCHIVE_FILES_BASE', ktoolEnv['KTOOLBOX_DOWNLOADER__FILES_NETLOC']); // 文件 host
  set('PAWCHIVE_FILES_PREFIX', ktoolEnv['KTOOLBOX_DOWNLOADER__FILE_PATH_PREFIX']); // /data 前缀
  set('PAWCHIVE_CREATOR_DIR_FORMAT', tomlNaming.creator_dirname_format);
  set('PAWCHIVE_POST_DIR_FORMAT', tomlNaming.post_dirname_format);
  set('PAWCHIVE_FILENAME_FORMAT', tomlNaming.filename_format);
  set('PAWCHIVE_ATTACHMENTS_SUBDIR', ktoolEnv['KTOOLBOX_JOB__POST_STRUCTURE__ATTACHMENTS']);
  set('PAWCHIVE_INDEX_FILENAME', ktoolEnv['KTOOLBOX_JOB__POST_STRUCTURE__CONTENT']); // 正文文件 ↔ 详情索引文件名
  set('PAWCHIVE_REVISIONS_SUBDIR', ktoolEnv['KTOOLBOX_JOB__POST_STRUCTURE__REVISIONS']); // 修订目录
  if (ktoolEnv['KTOOLBOX_JOB__INCLUDE_REVISIONS'] !== undefined) set('PAWCHIVE_INCLUDE_REVISIONS', ktoolEnv['KTOOLBOX_JOB__INCLUDE_REVISIONS'] === 'true' ? '1' : '0');
  // API base 组合：SCHEME://NETLOC + PATH
  if (ktoolEnv['KTOOLBOX_API__NETLOC']) {
    set('PAWCHIVE_API_BASE', `${ktoolEnv['KTOOLBOX_API__SCHEME'] || 'https'}://${ktoolEnv['KTOOLBOX_API__NETLOC']}${ktoolEnv['KTOOLBOX_API__PATH'] || ''}`);
  }
  if (mapped.PAWCHIVE_FILES_BASE && !/^https?:/i.test(mapped.PAWCHIVE_FILES_BASE)) {
    mapped.PAWCHIVE_FILES_BASE = 'https://' + mapped.PAWCHIVE_FILES_BASE;
  }
  return mapped;
}

// ---------- 反向：PAWCHIVE_* → KTOOLBOX_*（KToolBox 兼容我们——写真实值；设计文档第十节映射定稿） ----------
function toKToolBox(env = process.env) {
  const out = {};
  const getVal = (k, defaultVal = '') => { const v = env[k]; return v === undefined || v === null ? defaultVal : String(v); };
  const isFalse = (k) => env[k] === undefined || String(env[k]).toUpperCase() === 'FALSE'; // PAWCHIVE_FALSE 无值/有值都=关
  // API base → scheme/netloc/path
  const apiBase = getVal('PAWCHIVE_API_BASE');
  if (apiBase) {
    try {
      const parsedUrl = new URL(apiBase);
      out.KTOOLBOX_API__SCHEME = parsedUrl.protocol.replace(':', '');
      out.KTOOLBOX_API__NETLOC = parsedUrl.host;
      out.KTOOLBOX_API__PATH = parsedUrl.pathname.replace(/\/$/, '') || '/api/v1';
    } catch { /* 非法 URL 跳过 */ }
  }
  // 文件 host
  const filesBase = getVal('PAWCHIVE_FILES_BASE');
  if (filesBase) {
    try { const parsedUrl = new URL(/^https?:/i.test(filesBase) ? filesBase : 'https://' + filesBase); out.KTOOLBOX_DOWNLOADER__SCHEME = parsedUrl.protocol.replace(':', ''); out.KTOOLBOX_DOWNLOADER__FILES_NETLOC = parsedUrl.host; } catch { /* 跳过 */ }
  }
  out.KTOOLBOX_JOB__COUNT = getVal('PAWCHIVE_CONCURRENCY');
  out.KTOOLBOX_JOB__INCLUDE_REVISIONS = getVal('PAWCHIVE_INCLUDE_REVISIONS', '1') !== '0' ? 'true' : 'false'; // 反向写真实值（默认开→true）
  out.KTOOLBOX_JOB__CREATOR_DIRNAME_FORMAT = getVal('PAWCHIVE_CREATOR_DIR_FORMAT');
  out.KTOOLBOX_JOB__POST_DIRNAME_FORMAT = getVal('PAWCHIVE_POST_DIR_FORMAT');
  out.KTOOLBOX_JOB__FILENAME_FORMAT = getVal('PAWCHIVE_FILENAME_FORMAT');
  out.KTOOLBOX_JOB__POST_STRUCTURE__ATTACHMENTS = getVal('PAWCHIVE_ATTACHMENTS_SUBDIR') || '.';
  out.KTOOLBOX_JOB__POST_STRUCTURE__CONTENT = getVal('PAWCHIVE_INDEX_FILENAME', 'pawchive-index.html');
  out.KTOOLBOX_JOB__POST_STRUCTURE__REVISIONS = getVal('PAWCHIVE_REVISIONS_SUBDIR', 'revisions');
  // external_links：PAWCHIVE_FALSE（存在但不用）→ 原版默认路径 + 生成开关 false
  out.KTOOLBOX_JOB__POST_STRUCTURE__EXTERNAL_LINKS = 'external_links.txt';
  out.KTOOLBOX_JOB__EXTRACT_EXTERNAL_LINKS = isFalse('PAWCHIVE_EXTERNAL_LINKS') ? 'false' : getVal('PAWCHIVE_EXTERNAL_LINKS');
  // 无对应组（过滤/时区/任务上限）→ 官方默认/关闭：max_active_tasks 对齐并发配置，其余不写（原版默认空）
  out.KTOOLBOX_WEBUI__MAX_ACTIVE_TASKS = getVal('PAWCHIVE_CONCURRENCY');
  return out;
}

// ---------- PAWCHIVE_* → 配置对象（兼容层 getNaming/config 用——统一读 env） ----------
function readPawchiveEnv(env = process.env) {
  const getVal = (k, defaultVal = '') => { const v = env[k]; return v === undefined || v === null ? defaultVal : String(v); };
  return {
    dataRoot: getVal('PAWCHIVE_DATA_ROOT'),
    apiBase: getVal('PAWCHIVE_API_BASE'),
    filesBase: getVal('PAWCHIVE_FILES_BASE'),
    concurrency: getVal('PAWCHIVE_CONCURRENCY', '5'),
    includeRevisions: getVal('PAWCHIVE_INCLUDE_REVISIONS', '1') !== '0', // 默认开
    creatorDirFormat: getVal('PAWCHIVE_CREATOR_DIR_FORMAT'),
    postDirFormat: getVal('PAWCHIVE_POST_DIR_FORMAT'),
    filenameFormat: getVal('PAWCHIVE_FILENAME_FORMAT'),
    attachmentsSubdir: getVal('PAWCHIVE_ATTACHMENTS_SUBDIR'),
    indexFilename: getVal('PAWCHIVE_INDEX_FILENAME', 'pawchive-index.html'),
    revisionsSubdir: getVal('PAWCHIVE_REVISIONS_SUBDIR', 'revisions'),
    userAgent: getVal('PAWCHIVE_USER_AGENT'),
  };
}

// ---------- .env 写（PATCH naming/config 保存用——KEY=VALUE 替换/追加） ----------
function writeEnv(key, value, envPath = DEFAULT_ENV_PATH) {
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { /* 无 .env 则新建 */ }
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, 'm').test(text)) text = text.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  else text += (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
  fs.mkdirSync(path.dirname(envPath), { recursive: true }); // envPath 父目录可自定义缺失——防 ENOENT
  fs.writeFileSync(envPath, text, 'utf8');
}

module.exports = { buildMapped, readPawchiveEnv, toKToolBox, writeEnv, ktoolEnv, tomlNaming, DEFAULT_ENV_PATH };

// ---------- CLI 模式（直接运行；被 require 时只导出不执行） ----------
if (require.main === module) {
  const genIdx = process.argv.indexOf('--gen-env');
  if (genIdx !== -1) {
    // ① 一次性映射导出：--gen-env [输出文件]（缺省打印 stdout），不启动 cli
    const outFile = process.argv[genIdx + 1] && !process.argv[genIdx + 1].startsWith('-') ? process.argv[genIdx + 1] : null;
    const lines = Object.entries(buildMapped()).map(([k, v]) => `${k}=${v}`);
    const out = lines.join('\n') + (lines.length ? '\n' : '');
    if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, out); console.log(`✓ 已导出映射到 ${outFile}（${lines.length} 项）；之后直接 node cli.js 使用`); }
    else { process.stdout.write(out); }
    process.exit(0);
  }
  // ② 同参数调用 cli：映射注入（已有 PAWCHIVE_* 优先）→ 启动 cli.js（参数原样透传）
  for (const [k, v] of Object.entries(buildMapped())) {
    if (!process.env[k]) process.env[k] = v;
  }
  const r = spawnSync(process.execPath, [CLI, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
  process.exit(r.status === null ? 1 : r.status);
}
