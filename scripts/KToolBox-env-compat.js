#!/usr/bin/env node
/**
 * KToolBox-env-compat —— 独立兼容层（不改 cli.js），双模式：
 *
 * ① 一次性映射导出（推荐）：--gen-env [输出文件]
 *    读 KToolBox 的 .env（KTOOLBOX_*，KTOOL_ENV 指定路径，默认 docs/.probe-ktoolbox/.env）
 *    与 ktoolbox.toml 的 [naming] 表（KTOOLBOX_TOML 指定路径，默认 docs/.probe-ktoolbox/ktoolbox.toml），
 *    映射为 PAWCHIVE_* 键值——输出到文件（写盘）或 stdout（打印），跑一次之后 node cli.js 连续直接用。
 *
 * ② 同参数调用 cli（映射注入后透传启动）：
 *    node scripts/KToolBox-env-compat.js <与 cli.js 完全相同的参数...>
 *
 * 优先级：已存在的 PAWCHIVE_*（外层环境） > KToolBox 映射 > cli.js 同目录 .env > 默认值。
 * 用法：
 *   node scripts/KToolBox-env-compat.js --gen-env ktool-mapped.env
 *   node scripts/KToolBox-env-compat.js --gen-env            # 打印到 stdout
 *   node scripts/KToolBox-env-compat.js "https://pawchive.pw/patreon/user/96944064" /path/to/downloads
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');

// ---------- 读 ktool .env（只取 KTOOLBOX_* 键） ----------
const envFile = process.env.KTOOL_ENV || path.join(__dirname, '..', 'docs', '.probe-ktoolbox', '.env');
const ktoolEnv = {};
try {
  const text = fs.readFileSync(envFile, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && m[1].startsWith('KTOOLBOX_')) ktoolEnv[m[1]] = m[2].trim();
  }
} catch { /* 无 KToolBox .env：兼容层空转 */ }

// ---------- 读 ktoolbox.toml 的 [naming] 表（零依赖 mini 解析：key = "value" 行） ----------
const tomlFile = process.env.KTOOLBOX_TOML || path.join(__dirname, '..', 'docs', '.probe-ktoolbox', 'ktoolbox.toml');
const tomlNaming = {};
try {
  let inNaming = false;
  for (const line of fs.readFileSync(tomlFile, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) { inNaming = t === '[naming]'; continue; }
    if (!inNaming || t.startsWith('#') || !t.includes('=')) continue;
    const m = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(t);
    if (m) tomlNaming[m[1]] = m[2];
  }
} catch { /* 无 ktoolbox.toml */ }

// ---------- 构建 PAWCHIVE_* 映射（一次性计算，两种模式共用） ----------
function buildMapped() {
  const mapped = {};
  const set = (k, v) => { if (v !== undefined && v !== null && String(v) !== '') mapped[k] = String(v); };
  // .env 映射：KTOOLBOX_* → PAWCHIVE_*
  set('PAWCHIVE_CONCURRENCY', ktoolEnv['KTOOLBOX_JOB__COUNT']); // 下载并发
  set('PAWCHIVE_FILES_BASE', ktoolEnv['KTOOLBOX_DOWNLOADER__FILES_NETLOC']); // 文件 host
  set('PAWCHIVE_FILES_PREFIX', ktoolEnv['KTOOLBOX_DOWNLOADER__FILE_PATH_PREFIX']); // /data 前缀
  // 命名模板：ktoolbox.toml [naming] → 我们的 env 命名模板（变量双向兼容）
  set('PAWCHIVE_CREATOR_DIR_FORMAT', tomlNaming.creator_dirname_format);
  set('PAWCHIVE_POST_DIR_FORMAT', tomlNaming.post_dirname_format);
  set('PAWCHIVE_FILENAME_FORMAT', tomlNaming.filename_format);
  // API base 组合：SCHEME://NETLOC + PATH
  if (ktoolEnv['KTOOLBOX_API__NETLOC']) {
    set('PAWCHIVE_API_BASE', `${ktoolEnv['KTOOLBOX_API__SCHEME'] || 'https'}://${ktoolEnv['KTOOLBOX_API__NETLOC']}${ktoolEnv['KTOOLBOX_API__PATH'] || ''}`);
  }
  // filesBase 补 scheme
  if (mapped.PAWCHIVE_FILES_BASE && !/^https?:/i.test(mapped.PAWCHIVE_FILES_BASE)) {
    mapped.PAWCHIVE_FILES_BASE = 'https://' + mapped.PAWCHIVE_FILES_BASE;
  }
  return mapped;
}

// ---------- 模式判定 ----------
const genIdx = process.argv.indexOf('--gen-env');
if (genIdx !== -1) {
  // ① 一次性映射导出：--gen-env [输出文件]（缺省打印 stdout），不启动 cli
  const outFile = process.argv[genIdx + 1] && !process.argv[genIdx + 1].startsWith('-') ? process.argv[genIdx + 1] : null;
  const lines = Object.entries(buildMapped()).map(([k, v]) => `${k}=${v}`);
  const out = lines.join('\n') + (lines.length ? '\n' : '');
  if (outFile) { fs.writeFileSync(outFile, out); console.log(`✓ 已导出映射到 ${outFile}（${lines.length} 项）；之后直接 node cli.js 使用`); }
  else { process.stdout.write(out); }
  process.exit(0);
}

// ② 同参数调用 cli：映射注入（已有 PAWCHIVE_* 优先）→ 启动 cli.js（参数原样透传）
for (const [k, v] of Object.entries(buildMapped())) {
  if (!process.env[k]) process.env[k] = v;
}
const r = spawnSync(process.execPath, [CLI, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
process.exit(r.status === null ? 1 : r.status);
