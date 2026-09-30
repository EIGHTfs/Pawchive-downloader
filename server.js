#!/usr/bin/env node
/**
 * server.js —— 协议切换兼容层入口（零依赖 node:http）
 *
 * 分层：HTTP 服务 + 静态托管 + 协议选择（适配器）→ 业务内核 core.js
 * 协议：PAWCHIVE_WEB_PROTOCOL（默认 KToolBox-webui；native 预留）
 * 存储：PAWCHIVE_WEB_DB（默认 ./webui.db，SQLite）
 * 端口：PAWCHIVE_WEB_HOST/PORT（默认 0.0.0.0:8789，对齐 KToolBox）
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// debug 开关常量（PAWCHIVE_WEB_DEBUG=1 开启——服务启动时自动检查核心端点并写自检日志）
const DEBUG = process.env.PAWCHIVE_WEB_DEBUG === '1';

/** 启动端点自检（DEBUG 开启时——启动即自动检查核心端点——每端点即时写日志；legacy-migration 重扫描 40s 不纳入） */
async function startupSelfCheck() {
  const endpoints = ['/api/v1/health', '/api/v1/session', '/api/v1/creators', '/api/v1/tasks', '/api/v1/project', '/api/v1/naming', '/api/v1/config/schema?locale=zh-CN', '/api/v1/config/project', '/api/v1/filesystem?path=', '/api/v1/auto-sync/plans', '/api/v1/config/dotenv/.env'];
  const base = `http://${HOST}:${PORT}`;
  console.log(`[web] 启动端点自检开始（DEBUG）：${endpoints.length} 端点`);
  let bad = 0;
  for (const ep of endpoints) {
    try {
      const r = await fetch(base + ep, { signal: AbortSignal.timeout(10000) });
      const ok = /^2/.test(String(r.status));
      if (!ok) bad++;
      console.log(`  ${ok ? '✓' : '✗'} ${r.status} ${ep}`);
    } catch (e) { bad++; console.log(`  ✗ FAIL ${ep}: ${String(e.message || e).slice(0, 50)}`); }
  }
  console.log(`[web] 启动端点自检完成：异常 ${bad} 个`);
}
const core = require('./core.js');

const STATIC_DIR = path.join(__dirname, 'webui-static');

// 前端全局错误捕获（①层——browser-error-observability 三件套）：window.onerror + unhandledrejection + 资源 error
// → POST /api/v1/client-error → adapter 写 .client-errors.jsonl → AI read/tail 定位（AI 无视觉感知浏览器错误）
const ERROR_REPORTER = '<script>\n(function(){var N="/api/v1/client-error",n=0;function r(p){if(n++>20)return;try{navigator.sendBeacon(N,JSON.stringify(Object.assign({ts:Date.now(),href:location.href,ua:navigator.userAgent},p)));}catch(_){try{fetch(N,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p),keepalive:true}).catch(function(){})}catch(__){}}}\nwindow.addEventListener("error",function(e){if(e.target&&e.target!==window){r({type:"resource",tag:e.target.tagName,src:e.target.src||e.target.href});}else{var f=e.filename||"";if(f.indexOf("chrome-extension://")===0)return;r({type:"error",message:String(e.message),source:f,lineno:e.lineno,colno:e.colno,stack:(e.error&&e.error.stack)||""});}},true);\nwindow.addEventListener("unhandledrejection",function(e){var er=e.reason;r({type:"unhandledrejection",message:(er&&er.message)||String(er),stack:(er&&er.stack)||""});});\n})();\n</script>';
let cachedIndexHtml = null; // 注入结果缓存（性能：避免每次响应 replace）
const HOST = process.env.PAWCHIVE_WEB_HOST || '0.0.0.0';
const PORT = Number(process.env.PAWCHIVE_WEB_PORT) || 8789;
const protocolName = process.env.PAWCHIVE_WEB_PROTOCOL || 'KToolBox-webui';
const PROTOCOLS = {
  'KToolBox-webui': require('./adapters/KToolBox-webui.js'),
  'native': null, // 预留：自研前端协议
};
const protocol = PROTOCOLS[protocolName] || PROTOCOLS['KToolBox-webui'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function serveStatic(pathname, req, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(STATIC_DIR, rel));
  if (!file.startsWith(STATIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA fallback：非 API 路径回 index.html
    const idx = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      if (cachedIndexHtml === null) cachedIndexHtml = fs.readFileSync(idx, 'utf8').replace('</head>', ERROR_REPORTER + '</head>'); // 注入 error-reporter（①层——Spa fallback 也注入）
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(cachedIndexHtml); return;
    }
    res.writeHead(404); res.end('Not Found'); return;
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' && rel === 'index.html' && cachedIndexHtml === null) cachedIndexHtml = fs.readFileSync(file, 'utf8').replace('</head>', ERROR_REPORTER + '</head>');
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000' });
  res.end(cachedIndexHtml !== null && ext === '.html' && rel === 'index.html' ? cachedIndexHtml : fs.readFileSync(file));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      await protocol.handle(req.method, pathname, url, req, res, core);
    } else {
      serveStatic(pathname, req, res);
    }
  } catch (err) {
    console.error(`[web] 500 ${req.method} ${pathname}: ${err && err.stack || err}`); // 错误落日志（可观测性——客户端报错可查栈）
    json(res, 500, { detail: String(err && err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[web] Pawchive WebUI 兼容层 http://${HOST}:${PORT}（协议: ${protocolName}，DB: ${core.db ? path.basename(process.env.PAWCHIVE_WEB_DB || 'webui.db') : '-'}）`);
  sweepOrphanCurls(); // 孤儿下载 curl 清扫（上一轮 server 崩溃/被杀遗留的下载子进程——kill -9 无法被 cli 退出钩子拦截，此兜底 TERM 掉）
  if (typeof core.startAutoSyncScheduler === 'function') core.startAutoSyncScheduler(core.CONFIG.dataRoot || ''); // 自动同步调度（计划到期触发 sync 任务）
  if (typeof core.startTaskScheduler === 'function') core.startTaskScheduler(core.CONFIG.dataRoot || '', { maxActive: Number(process.env.PAWCHIVE_CONCURRENCY) || 5 }); // 任务调度器（queued/blocked 排队 + 全局并发上限）
  if (DEBUG) startupSelfCheck(); // debug 开关——启动端点自检（写日志）
});

/** 启动清扫孤儿下载 curl：扫描 /proc/<pid>/cmdline 中 curl 且 -o 目标在数据根内、非本进程及其子进程 → SIGTERM（覆盖 kill -9/崩溃遗留） */
function sweepOrphanCurls() {
  const dataRoot = core.CONFIG.dataRoot || '';
  const selfPid = String(process.pid);
  const children = new Set();
  try { const out = require('node:child_process').execSync('ps -o pid= --ppid ' + selfPid, { encoding: 'utf8' }); for (const l of out.trim().split(/\s+/)) if (l) children.add(l.trim()); } catch { /* 无子进程 */ }
  let n = 0;
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || entry === selfPid || children.has(entry)) continue;
      let cmd;
      try { cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8'); } catch { continue; }
      const args = cmd.replace(/\0/g, ' ').trim();
      if (!/curl/.test(args) || !/ -o /.test(args)) continue;
      // -o 目标是否在数据根内（孤儿下载的判定：下载目标属于我们的数据目录）
      const outMatch = / -o ([^ ]+)/.exec(args);
      if (!outMatch) continue;
      const target = outMatch[1];
      if (dataRoot && !target.startsWith(dataRoot)) continue;
      try {
        process.kill(Number(entry), 'SIGTERM');
        n++;
        console.log(`[web] 清扫孤儿下载 curl pid=${entry}（-o ${target}）`);
      } catch { /* 已退出 */ }
    }
  } catch { /* /proc 不可用（非 Linux）跳过 */ }
  if (n) console.log(`[web] 孤儿下载清扫完成：TERM ${n} 个`);
}
