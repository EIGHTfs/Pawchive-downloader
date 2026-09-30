#!/usr/bin/env node
// playwright 预渲染（react-snap 等价实现）：把前端 SPA 每路由渲染成静态 HTML，去掉 React script（去 React 化）
// 用法：node tools/prerender.mjs [--routes "a b c"] [--out <目录>] [--login]
// 环境：KT_PLAYWRIGHT（playwright index.mjs 路径）/ KT_BROWSER（chromium 路径）/ LD_LIBRARY_PATH
// 后端需在跑（登录 + 数据 API）；默认路由 = 前端导航全量
"use strict";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.PRERENDER_BASE || "http://10.10.10.193:18400";
const USER = process.env.PRERENDER_USER || "admin";
const PASS = process.env.PRERENDER_PASS || "demo-admin-2026";
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : path.join(__dirname, "..", "server", "public", "prerender");
const argIdx = process.argv.indexOf("--routes");
const ROUTES = argIdx >= 0 ? process.argv[argIdx + 1].split(/\s+/) : ["", "tasks", "creators", "posts", "setting", "auto-sync", "naming", "mcp", "system", "about", "blockers"];
const WAIT_SEL = process.env.PRERENDER_SELECTOR || "main, .app-main, [class*=shell]"; // 渲染完成的标志元素

(async () => {
  const { chromium } = await import(process.env.KT_PLAYWRIGHT);
  // 登录（后端 API 拿 cookie）
  const login = await fetch(`${BASE}/api/v1/session/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }), redirect: "manual",
  });
  const sc = login.headers.get("set-cookie") || "";
  const m = sc.match(/(ktoolbox_session=[^;]+)/);
  if (!m) { console.error("✗ 登录失败（HTTP " + login.status + "）——检查后端/凭据"); process.exit(1); }
  const cookie = { name: "ktoolbox_session", value: m[1].split("=").slice(1).join("="), url: BASE + "/" };
  mkdir(OUT);
  const results = [];
  for (const route of ROUTES) {
    const name = route === "" ? "index" : route.replace(/\//g, "-");
    const file = name + ".html";
    // 每路由独立 browser 进程（本环境渲染进程整体崩溃频繁——独立进程崩了只重试当前路由）+ 最多 3 次重试
    let done = false, crashed = false, bytes = 0;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      let browser;
      try {
        browser = await chromium.launch({
          executablePath: process.env.KT_BROWSER,
          args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-software-rasterizer"],
        });
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await ctx.addCookies([cookie]);
        const page = await ctx.newPage();
        let crash = false;
        page.on("crash", () => { crash = true; });
        await page.goto(`${BASE}/${route}`, { waitUntil: "load", timeout: 45000 });
        // 确认「加载成功」再抓取：waitForSelector（CDP 层 DOM 查询——不执行页面 JS，避免 evaluate 触发渲染进程崩溃）
        // 侧边栏 + 主内容都出现 = 渲染完成（KToolBox AppShell 布局就绪）
        let loaded = false;
        try {
          await page.waitForSelector(".sidebar, aside", { timeout: 30000 });
          await page.waitForSelector("main", { timeout: 30000 });
          loaded = true;
        } catch { /* 渲染未就绪/超时 */ }
        if (!loaded && !crash) console.log(`  ⚠ /${route} 渲染未确认完成（sidebar/main 未就绪）`);
        if (loaded && !crash) {
          const html = await page.content();
          fs.writeFileSync(path.join(OUT, file), stripScripts(html));
          bytes = fs.statSync(path.join(OUT, file)).size;
          done = true; crashed = false;
        } else { crashed = crashed || !loaded; }
        await ctx.close();
      } catch (e) {
        if (attempt === 3) console.log(`  ⚠ /${route} 第${attempt}次异常: ${String(e.message).slice(0, 60)}`);
      } finally {
        if (browser) { try { await browser.close(); } catch { /* 已死 */ } }
      }
    }
    results.push({ route: "/" + route, file, ok: done, crashed, bytes });
    console.log(`  /${route || ""} → ${done ? "✓" : "✗"} ${crashed ? "(渲染进程崩溃)" : ""} ${done ? bytes + "B" : ""}`);
  }
  const good = results.filter(r => r.ok).length;
  console.log(`\n预渲染完成: ${good}/${results.length} 成功 → ${OUT}`);
})().catch(e => { console.error("预渲染失败:", String(e.message).slice(0, 200)); process.exit(1); });

// 去 React：移除全部 <script>（静态 HTML 无需运行时）+ 保留内联 <style>（单文件 CSS）
function stripScripts(html) {
  return html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
}
function mkdir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch { /* 已存在 */ } }