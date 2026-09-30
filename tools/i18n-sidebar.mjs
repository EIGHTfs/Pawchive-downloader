#!/usr/bin/env node
// 侧边栏多语言化（参考 gallery）：① sidebar.html 导航文案替换为 data-i18n + 中文默认
// ② 各页 sidebar 注入脚本升级：注入后执行 i18n（fetch JSON → data-i18n 应用 + 中/EN 切换按钮）
// 注意：sidebar.html 内不能放 <script>（页面用 innerHTML 注入——innerHTML 的 script 不执行）
// 用法：node tools/i18n-sidebar.mjs [--dir <prerender 目录>]
"use strict";
import fs from "node:fs";
import path from "node:path";

const DIR = (() => {
  const i = process.argv.indexOf("--dir");
  return i >= 0 ? process.argv[i + 1] : path.join(import.meta.dirname, "..", "server", "public", "prerender");
})();
const I18N_DIR = path.join(DIR, "i18n");

// 导航文案映射（KToolBox 英文 → zh-CN；仅保留 zh/en 两种语言）
const NAV = {
  "Overview": { key: "nav.overview", zh: "概览" },
  "Tasks": { key: "nav.tasks", zh: "任务" },
  "Automatic sync": { key: "nav.autoSync", zh: "自动同步" },
  "Creators": { key: "nav.creators", zh: "创作者" },
  "Posts": { key: "nav.posts", zh: "帖子" },
  "Blockers": { key: "nav.blockers", zh: "拦截器" },
  "Naming format": { key: "nav.naming", zh: "命名格式" },
  "MCP": { key: "nav.mcp", zh: "MCP" },
  "Global configuration": { key: "nav.setting", zh: "全局配置" },
  "System": { key: "nav.system", zh: "系统" },
  "About": { key: "nav.about", zh: "关于" },
};
const OTHER = { "Sign out": { key: "signOut", zh: "退出登录" } };

function buildDicts() {
  const zh = {}, en = {};
  for (const [text, v] of Object.entries(NAV)) { zh[v.key] = v.zh; en[v.key] = text; }
  for (const [text, v] of Object.entries(OTHER)) { zh[v.key] = v.zh; en[v.key] = text; }
  return { zh, en };
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ① sidebar.html：文案替换（data-i18n + 中文默认；不放脚本）
const sbFile = path.join(DIR, "sidebar.html");
let sb = fs.readFileSync(sbFile, "utf8");
let replaced = 0;
for (const [text, v] of Object.entries({ ...NAV, ...OTHER })) {
  const re = new RegExp(`(<span class="truncate">)${escapeRe(text)}(</span>)`, "g");
  sb = sb.replace(re, (m, p1, p2) => { replaced++; return `${p1}<span data-i18n="${v.key}">${v.zh}</span>${p2}`; });
}
// 若已处理过（data-i18n 已存在）则不再替换
if (replaced === 0 && sb.includes('data-i18n="nav.overview"')) console.log("sidebar.html 已多语言化（跳过文案替换）");
else fs.writeFileSync(sbFile, sb);
console.log(`sidebar.html 文案替换: ${replaced} 处`);

// ② 各页注入脚本升级（注入 sidebar + i18n 应用 + 中/EN 切换按钮）
const UPGRADED = `<script>(function(){var m=document.getElementById("sidebar-mount");if(!m)return;
function applyI18n(){var lang=localStorage.getItem("pawchiveLang")||"zh-CN";fetch("/prerender/i18n/"+lang+".json?t="+Date.now()).then(function(r){return r.json();}).then(function(j){
m.querySelectorAll("[data-i18n]").forEach(function(el){var k=el.getAttribute("data-i18n");if(j[k]!=null)el.textContent=j[k];});
var f=m.querySelector(".sidebar .border-t")||m.querySelector(".sidebar");if(f&&!m.querySelector("#langBtn")){var b=document.createElement("button");b.id="langBtn";b.textContent=lang==="en"?"EN":"中";b.style.cssText="margin:4px 8px;padding:6px 12px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:transparent;color:var(--foreground,#111);cursor:pointer;font-size:13px;";b.addEventListener("click",function(){localStorage.setItem("pawchiveLang",lang==="en"?"zh-CN":"en");applyI18n();});f.appendChild(b);}
}).catch(function(){});}
fetch("/prerender/sidebar.html").then(function(r){return r.text();}).then(function(h){m.innerHTML=h;applyI18n();}).catch(function(){});})();</script>`;

const files = fs.readdirSync(DIR).filter(f => f.endsWith(".html") && f !== "sidebar.html");
for (const f of files) {
  const p = path.join(DIR, f);
  let html = fs.readFileSync(p, "utf8");
  if (html.includes('id="sidebar-mount"')) {
    // 替换旧的注入脚本（含 i18n 应用）
    html = html.replace(/<script>\(function\(\)\{var m=document\.getElementById\("sidebar-mount"\)[\s\S]*?<\/script>/g, UPGRADED);
    fs.writeFileSync(p, html);
    console.log(`  ${f}: 注入脚本已升级（含 i18n）`);
  }
}

// ③ 生成 JSON 语言文件（仅 zh-CN/en）
const { zh, en } = buildDicts();
fs.mkdirSync(I18N_DIR, { recursive: true });
fs.writeFileSync(path.join(I18N_DIR, "zh-CN.json"), JSON.stringify(zh, null, 2) + "\n");
fs.writeFileSync(path.join(I18N_DIR, "en.json"), JSON.stringify(en, null, 2) + "\n");
console.log(`已生成 ${I18N_DIR}/zh-CN.json + en.json（${Object.keys(zh).length} key）`);
console.log("完成。");