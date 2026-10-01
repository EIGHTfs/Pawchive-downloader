#!/usr/bin/env node
// 预渲染产物后处理：把页面内联 <style> 提取为独立 CSS 文件（去重复，html 瘦身）+ 页面改外链引用
// 用法：node tools/extract-css.mjs [--dir <prerender 目录>]
// 输出：<dir>/app.css（各页 style 合并去重）+ 各 html 的 <style> 块删除并插入 <link>
"use strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DIR = (() => {
  const i = process.argv.indexOf("--dir");
  return i >= 0 ? process.argv[i + 1] : path.join(import.meta.dirname, "..", "server", "public", "prerender");
})();

function extractStyles(html) {
  const out = [];
  const re = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style\s*>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith(".html"));
let appCss = "", appHash = "";
for (const f of files) {
  const p = path.join(DIR, f);
  let html = fs.readFileSync(p, "utf8");
  const styles = extractStyles(html);
  if (styles.length === 0) { console.log(`  ${f}: 无内联 <style>（跳过）`); continue; }
  // 各页 style 合并（多块拼接）
  const merged = styles.join("\n");
  const hash = crypto.createHash("sha1").update(merged).digest("hex").slice(0, 8);
  if (!appCss) { appCss = merged; appHash = hash; }
  else if (hash !== appHash) { console.log(`  ⚠ ${f}: style 与首页不同（hash ${hash}）——独立存放`); fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, `app-${hash}.css`), merged); }
  // 页面改外链：删 <style> 块 → 插入 <link>
  const stripped = html.replace(/<style(?:\s[^>]*)?>[\s\S]*?<\/style\s*>/gi, "");
  const withLink = stripped.includes("</head>")
    ? stripped.replace("</head>", `<link rel="stylesheet" href="/prerender/app.css">\n</head>`)
    : `<link rel="stylesheet" href="/prerender/app.css">\n` + stripped;
  fs.mkdirSync(path.dirname(p), { recursive: true }); // 目标页面目录防缺失
  fs.writeFileSync(p, withLink);
  console.log(`  ${f}: style ${styles.length} 块 → 外链 app.css（${(html.length - withLink.length) / 1024 | 0}KB 瘦身）`);
}
if (appCss) {
  fs.mkdirSync(DIR, { recursive: true }); // DIR 输出目录防缺失
  fs.writeFileSync(path.join(DIR, "app.css"), appCss);
  console.log(`\n已生成 ${path.join(DIR, "app.css")}（${(appCss.length / 1024) | 0}KB，hash ${appHash}）`);
}
console.log("完成。");