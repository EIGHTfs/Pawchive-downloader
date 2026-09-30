#!/usr/bin/env node
// 侧边栏独立化：从预渲染页提取 <aside class="sidebar"> → server/public/prerender/sidebar.html（独立文件）
// 各页删除内嵌 aside → 原位 mount div + 注入脚本（fetch sidebar.html 注入，保 grid 布局）
// 用法：node tools/sidebar-extract.mjs [--dir <prerender 目录>]
"use strict";
import fs from "node:fs";
import path from "node:path";

const DIR = (() => {
  const i = process.argv.indexOf("--dir");
  return i >= 0 ? process.argv[i + 1] : path.join(import.meta.dirname, "..", "server", "public", "prerender");
})();

// 提取 <aside class="sidebar"...>...</aside>（匹配到对应 </aside>）
function extractSidebar(html) {
  const start = html.indexOf('<aside class="sidebar');
  if (start < 0) return null;
  const endTag = html.indexOf("</aside>", start);
  if (endTag < 0) return null;
  return { block: html.slice(start, endTag + "</aside>".length), start, end: endTag + "</aside>".length };
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith(".html"));
let sidebarBlock = null;

for (const f of files) {
  if (f === "sidebar.html") continue; // 独立侧边栏文件本身不处理
  const p = path.join(DIR, f);
  let html = fs.readFileSync(p, "utf8");
  if (html.includes('id="sidebar-mount"')) { console.log(`  ${f}: 已处理过（幂等跳过）`); continue; }
  const sb = extractSidebar(html);
  if (!sb) {
    // 残缺页（预渲染失败——无内嵌侧边栏）：body 级注入（统一从 sidebar.html 拉侧边栏）+ flex 布局
    console.log(`  ${f}: 无内嵌侧边栏 → body 级注入`);
    const mount = `<div id="sidebar-mount"></div>`;
    if (html.includes("<body")) html = html.replace(/<body[^>]*>/, m => m + mount);
    else html = mount + html;
    if (!html.includes("sidebar-mount-style")) {
      const style = `<style id="sidebar-mount-style">#sidebar-mount{position:sticky;top:0;height:100dvh;overflow-y:auto;flex-shrink:0;}body{display:flex;}main,body>main{flex:1;min-width:0;}</style>`;
      html = html.replace("</head>", style + "\n</head>");
    }
    const inject = `<script>(function(){var m=document.getElementById("sidebar-mount");if(!m)return;fetch("/prerender/sidebar.html").then(function(r){return r.text();}).then(function(h){m.innerHTML=h;}).catch(function(){});})();<\/script>`;
    if (html.includes("</body>")) html = html.replace("</body>", inject + "\n</body>");
    else html += inject;
    fs.writeFileSync(p, html);
    continue;
  }
  if (!sidebarBlock) sidebarBlock = sb.block; // 取第一份完整侧边栏为独立文件
  // 删除 aside → 原位插 mount div（grid 占列）+ 注入脚本
  let next = html.slice(0, sb.start) + '<div id="sidebar-mount"></div>' + html.slice(sb.end);
  const inject = `<script>(function(){var m=document.getElementById("sidebar-mount");if(!m)return;fetch("/prerender/sidebar.html").then(function(r){return r.text();}).then(function(h){m.innerHTML=h;}).catch(function(){});})();<\/script>`;
  if (next.includes("</body>")) next = next.replace("</body>", inject + "\n</body>");
  else next += inject;
  fs.writeFileSync(p, next);
  console.log(`  ${f}: 侧边栏已提取（${(sb.block.length / 1024) | 0}KB）→ mount div + 注入脚本`);
}

if (sidebarBlock) {
  // 独立 sidebar.html（自身引 app.css，可独立访问）
  const sidebarHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/prerender/app.css"><style>html,body{margin:0;height:100%}body{display:flex}</style></head><body>${sidebarBlock}</body></html>`;
  fs.writeFileSync(path.join(DIR, "sidebar.html"), sidebarHtml);
  console.log(`\n已生成 ${path.join(DIR, "sidebar.html")}（${(sidebarBlock.length / 1024) | 0}KB 独立侧边栏）`);
}
console.log("完成。");