#!/usr/bin/env node
// 通用前端契约提取器：扫任意前端目录（KToolBox / iwara / gbmd / gallery 等）的全部 API 调用
// 适配模式：
//   A. fetch("URL", {method, body})           原生 fetch（URL 字面量，含 /api 前缀或相对）
//   B. api<T>("path", {method, body})         KToolBox 风格统一封装（自动补 /api/v1 前缀）
//   C. fetch(API_BASE + "/path", ...)         拼接风格（gallery api-client 封装内部）
//   D. xxx.get("path") / xxx.post("path",..)  封装方法调用（axios 风格 / 自定义 client）
// 用法：node tools/extract-contract.cjs <前端目录> [--json]
//   例：node tools/extract-contract.cjs .probe-ktoolbox/webui/src
//       node tools/extract-contract.cjs <bench-template>/templates/_downloader
//       node tools/extract-contract.cjs <bench-template>/templates/_gallery/js
"use strict";
const fs = require("fs");
const path = require("path");

const asJson = process.argv.includes("--json");
const root = process.argv.slice(2).find(a => !a.startsWith("--"));
if (!root) { console.error("用法: node tools/extract-contract.cjs <前端目录> [--json]"); process.exit(2); }

// ---------- 递归收集源码文件（js/ts/tsx/mjs/cjs/html；跳过 test/spec/dist/node_modules） ----------
const EXTS = /\.(js|ts|tsx|mjs|cjs|html)$/;
function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/node_modules|\.git|dist|build|test$/.test(entry.name)) continue;
      collect(full, out);
    } else if (EXTS.test(entry.name) && !/\.(test|spec|d)\.(js|ts|tsx|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// ---------- 四种模式提取 ----------
function extractFromFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const hits = [];
  // 提取 path 字面量 + 该调用后窗口内的 method/body
  function push(method, rawPath, type, kind, idx) {
    const after = src.slice(idx, idx + 400);
    let m = method;
    if (!m) { const mm = after.match(/method\s*:\s*['"]([A-Z]+)['"]/); m = mm ? mm[1] : "GET"; }
    const bodyKeys = [];
    const bm = after.match(/body\s*:\s*\{([^}]*)\}/);
    if (bm) bodyKeys.push(...bm[1].split(",").map(s => s.trim().split(/[:=]/)[0]).filter(Boolean));
    hits.push({ method: m, type: type || "", path: rawPath, bodyKeys, kind, loc: file });
  }
  // A: fetch("URL"|'URL'|`URL`)
  let re = /fetch\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  let m;
  while ((m = re.exec(src))) push("", m[1], "", "fetch", m.index);
  // C: fetch(API_BASE + "path") 拼接（path 以 / 开头）
  re = /fetch\s*\(\s*[A-Za-z_$][\w$]*\s*\+\s*(`\/[^`]*`|'\/[^']*'|"\/[^"]*")/g;
  while ((m = re.exec(src))) push("", m[1], "", "fetch(concat)", m.index);
  // B: api<T>("path", {method, body}) —— KToolBox 封装（自动补 /api/v1 前缀）
  re = /api(?:\s*<([^>]+)>)?\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  while ((m = re.exec(src))) push("", m[2], m[1] || "", "api(v1)", m.index);
  // D: 封装方法调用 xxx.get("path") / .post("path", body)
  re = /\.(get|post|put|patch|delete)\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  while ((m = re.exec(src))) push(m[1].toUpperCase(), m[2], "", "client.method", m.index);
  return hits;
}

// ---------- 归一化 ----------
function norm(raw, kind) {
  let s = raw.trim();
  if ((s.startsWith("`") && s.endsWith("`")) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1);
  s = s.replace(/\$\{[^}]*\}/g, ":param");
  if (s.startsWith("http") || s.startsWith("//")) { // 绝对 URL：取 pathname 部分
    try { s = new URL(s).pathname; } catch { /* 保留 */ }
  }
  if (kind === "api(v1)") s = "/api/v1" + (s.startsWith("/") ? s : "/" + s);
  return s.replace(/\/+$/, "") || "/";
}

const files = collect(root);
const all = [];
for (const f of files) all.push(...extractFromFile(f));

const map = new Map();
for (const h of all) {
  const p = norm(h.path, h.kind);
  const key = `${h.method} ${p}`;
  if (!map.has(key)) map.set(key, { method: h.method, path: p, kind: h.kind, type: h.type, bodyKeys: [], calls: [] });
  const rec = map.get(key);
  rec.calls.push(path.relative(root, h.loc));
  rec.bodyKeys = [...new Set([...rec.bodyKeys, ...h.bodyKeys])];
  if (h.type && !rec.type) rec.type = h.type;
}
const rows = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
// 过滤噪音：纯模板路径（无字面量）/ 静态资源（locales/css 等，非 /api）
function isNoise(r) {
  if (!r.path || r.path === "/") return true;
  if (/^\/api\/v1:param$/.test(r.path) || /^\/api\/v1(\?.*)?$/.test(r.path)) return true;
  if (/\.(json|css|js|png|jpg|jpeg|svg|ico|woff2?|map)(\?|$)/i.test(r.path) && !r.path.includes("/api")) return true;
  if (/^\.\//.test(r.path)) return true;
  return false;
}
const cleanRows = rows.filter(r => !isNoise(r));
if (asJson) {
  console.log(JSON.stringify(cleanRows, null, 2));
} else {
  console.log(`契约端点总数: ${cleanRows.length}（调用点 ${all.length} 处，源文件 ${files.length} 个；模式: fetch/fetch(concat)/api(v1)/client.method）\n`);
  for (const r of cleanRows) {
    const uniq = [...new Set(r.calls)];
    console.log(`${r.method.padEnd(6)} ${r.path.padEnd(46)} ${(r.type || '').slice(0, 18).padEnd(18)} ${(r.bodyKeys.join(',') || '-').padEnd(10)} ${uniq.length}处`);
  }
}
