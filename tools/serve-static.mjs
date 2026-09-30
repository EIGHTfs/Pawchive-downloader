#!/usr/bin/env node
// 纯 HTML 版独立静态 server（对比用）：serve server/public/prerender/* + 前端路由映射
// 用法：node tools/serve-static.mjs [--port 18500]
"use strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number((process.argv.find(a => a.startsWith("--port=")) || "--port=18500").split("=")[1]);
const PRERENDER = path.join(import.meta.dirname, "..", "server", "public", "prerender");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };

// 前端路由 → 预渲染页面（route 空 = index）
const ROUTES = { "": "index.html", login: "login.html", tasks: "tasks.html", creators: "creators.html", posts: "posts.html", setting: "setting.html", naming: "naming.html", system: "system.html", about: "about.html", blockers: "blockers.html", "auto-sync": "auto-sync.html", mcp: "mcp.html" };
const API_TARGET = process.env.STATIC_API || "http://127.0.0.1:18400";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = url.pathname;
  // /api/* 代理到自建后端（登录/会话/数据）
  if (p.startsWith("/api/")) {
    const proxy = http.request(API_TARGET + p + (url.search || ""), { method: req.method, headers: req.headers, timeout: 30000 }, upstream => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on("error", () => { res.writeHead(502, { "Content-Type": "application/json" }); res.end('{"error":"API 代理失败"}'); });
    req.pipe(proxy);
    return;
  }
  if (p === "/" || p === "/index.html") { serveFile(res, path.join(PRERENDER, "index.html")); return; }
  // /prerender/* 静态（app.css/sidebar.html/i18n/*.json/html）
  if (p.startsWith("/prerender/")) {
    const file = path.join(PRERENDER, p.slice("/prerender/".length));
    serveFile(res, file);
    return;
  }
  // 前端路由映射
  const route = p.slice(1).replace(/\/.*$/, "");
  if (route in ROUTES) { serveFile(res, path.join(PRERENDER, ROUTES[route])); return; }
  res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"未找到"}');
});

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"未找到"}'); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}
server.listen(PORT, () => console.log(`纯 HTML 版: http://<本机IP>:${PORT}/（对比用——原版 React 在 :18400）`));