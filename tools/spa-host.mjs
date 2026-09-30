#!/usr/bin/env node
// 预渲染专用本地 SPA host：所有路径 serve React 单文件 index.html（SPA fallback 语义，页面 200）
// + /api/* 代理到真实后端（18400）——供 prerender.mjs 全程拿到 200 与真实 API
// 用法：node tools/spa-host.mjs [--port 8765]（后台常驻；Ctrl-C / kill 停）
"use strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number((process.argv.find(a => a.startsWith("--port=")) || "--port=8765").split("=")[1]);
const INDEX = path.join(import.meta.dirname, "..", "server", "public", "index.html");
const API_TARGET = process.env.SPA_HOST_API || "http://127.0.0.1:18400";

const indexHtml = fs.readFileSync(INDEX, "utf8");
const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/api/")) {
    // 代理到真实后端（预渲染需要登录/数据 API）
    const proxy = http.request(API_TARGET + url, { method: req.method, headers: req.headers, timeout: 30000 }, upstream => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on("error", () => { res.writeHead(502, { "Content-Type": "application/json" }); res.end('{"error":"API 代理失败"}'); });
    req.pipe(proxy);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(indexHtml);
});
server.listen(PORT, () => console.log(`SPA host: http://127.0.0.1:${PORT}（页面→单文件 index.html；/api→${API_TARGET}）`));