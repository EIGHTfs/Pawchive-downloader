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
const core = require('./core.js');

const STATIC_DIR = path.join(__dirname, 'webui-static');
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
    if (fs.existsSync(idx)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(idx)); return; }
    res.writeHead(404); res.end('Not Found'); return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000' });
  res.end(fs.readFileSync(file));
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
    json(res, 500, { detail: String(err && err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[web] Pawchive WebUI 兼容层 http://${HOST}:${PORT}（协议: ${protocolName}，DB: ${core.db ? path.basename(process.env.PAWCHIVE_WEB_DB || 'webui.db') : '-'}）`);
});
