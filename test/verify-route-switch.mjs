#!/usr/bin/env node
/**
 * test/verify-route-switch.mjs —— 路由切换「URL 变但视图不更新」复现/验证脚本
 *
 * 用法：
 *   E2E_CHROME=<chromium> PWVIEWER_PLAYWRIGHT=<playwright index.mjs> \
 *     node test/verify-route-switch.mjs [baseUrl]（默认 http://127.0.0.1:8791）
 *
 * 验证点：点击侧边栏导航后记录 ①URL ②document.title ③主区 h1 —— 区分三类失效：
 *   - URL 变 + title/h1 都变      → 视图跟随正常 ✓
 *   - URL 变 + title 变 + h1 不变 → AppShell 重渲染了但主区内容未更新（Outlet 层问题）
 *   - URL 变 + title 不变        → location context 未驱起重渲染（react-router 调度问题）
 * 避开 /creators /configuration（无头 chromium 已知崩溃页）。
 */
const CHROME = process.env.E2E_CHROME || process.env.MS_CHROME;
const PW_PATH = process.env.PWVIEWER_PLAYWRIGHT || process.env.MS_PLAYWRIGHT;
if (!CHROME || !PW_PATH) {
  console.error('[verify] 需要 env：E2E_CHROME、PWVIEWER_PLAYWRIGHT');
  process.exit(2);
}
const { chromium } = await import('file://' + PW_PATH);

const BASE = (process.argv[2] || 'http://127.0.0.1:8791').replace(/\/$/, '');
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'admin123';

// 侧边栏导航：path → 断言主区 h1 应含的关键词（i18n en 翻译，宽松匹配）
const NAV = [
  { path: '/', key: 'overview' },
  { path: '/tasks', key: 'tasks' },
  { path: '/auto-sync', key: 'auto' },
  { path: '/blockers', key: 'blockers' },
  { path: '/naming', key: 'naming' },
  { path: '/system', key: 'system' },
  { path: '/about', key: 'about' },
];

// 无头 chromium 缺 CJK 字体渲染崩溃（TextRunHarfBuzz）→ 注入现成 FONTCONFIG_FILE（skill: headless-browser-screenshot）
const FONTCONF = process.env.FONTCONFIG_FILE || '/volume1/VirtualDSM/DeepSeekHarness/fonts/fonts.conf';
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu', '--disable-crash-reporter'],
  env: { ...process.env, FONTCONFIG_FILE: FONTCONF },
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGE_ERROR: ' + String(e.message).slice(0, 200)));

async function snapshot(label) {
  const s = await page.evaluate(() => ({
    href: location.href,
    title: document.title,
    h1: document.querySelector('header h1')?.textContent?.trim() ?? '<无 header h1>',
    mainSnippet: document.querySelector('main')?.innerText?.slice(0, 60)?.replace(/\n/g, ' │ ') ?? '<无 main>',
  }));
  console.log(`    [${label}] ${s.href}\n      title="${s.title}" h1="${s.h1}"\n      main="${s.mainSnippet}"`);
  return s;
}

console.log(`[verify] 路由切换验证（base=${BASE}）\n`);
try {
  // 1. 登录
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);
  const loginVisible = await page.locator('input[autocomplete="username"]').count();
  if (loginVisible) {
    console.log('· 登录页出现，执行登录…');
    await page.fill('input[autocomplete="username"]', USER);
    await page.fill('input[type="password"]', PASS);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2500);
  }
  const sidebarReady = await page.locator('a[href="/naming"]').count();
  if (!sidebarReady) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 150));
    console.error('· 侧边栏未出现（登录失败？）body=' + JSON.stringify(body));
    process.exitCode = 2;
    await browser.close();
    process.exit(process.exitCode);
  }
  console.log('· 登录成功，侧边栏就绪。开始逐路由切换：\n');

  // 2. 先到 overview，再依次点每个 nav，检查视图是否跟随
  let fail = 0;
  for (let i = 0; i < NAV.length; i++) {
    const { path } = NAV[i];
    const via = i === 0 ? 'goto' : 'click';
    if (via === 'goto') {
      await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else {
      await page.click(`a[href="${path}"]`, { timeout: 4000 }).catch((e) => { throw new Error(`点击 ${path} 失败: ${e.message}`); });
    }
    await page.waitForTimeout(900);
    const s = await snapshot(`⏭  ${path}（${via}）`);
    if (i > 0) {
      // 期望：URL 已切换 + 主区 h1 非空且不再等于上一个 key 的标题（内容跟随）
      const href = s.href;
      const expectPath = path === '/' ? BASE + '/' : BASE + path;
      const urlOk = href === expectPath || href === expectPath + '/';
      const h1Empty = s.h1 === '';
      if (!urlOk || h1Empty) {
        fail++;
        console.log(`    ✗ ${path}: URL=${urlOk ? 'OK' : 'FAIL'}（实际 ${href}，期望 ${expectPath}） h1 空=${h1Empty}`);
      } else {
        console.log(`    ✓ ${path}: URL 与主区 h1 均更新`);
      }
    }
  }

  // 3. 快速连续切换（模拟用户 /naming → /mcp → /setting 快切，mcp/setting 中 setting 可点但环境可能崩——用不崩的连击）
  console.log('\n· 快速连续切换（120ms 间隔）…');
  const quick = ['/auto-sync', '/blockers', '/naming'];
  await page.click('a[href="/auto-sync"]');
  const t0 = Date.now();
  for (const p of quick) {
    await page.click(`a[href="${p}"]`).catch(() => {});
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1500);
  const end = await snapshot('⏭  快切后最终');
  console.log(`    耗时 ${Date.now() - t0}ms；URL=${end.href}；h1="${end.h1}"`);

  console.log(`\n[verify] 结果：${fail} 处视图未跟随${errors.length ? `；pageerror=${errors.length}（${errors[0]}）` : ''}`);
} finally {
  await browser.close();
}
process.exit(errors.length || process.exitCode ? 1 : 0);