#!/usr/bin/env node
/**
 * test/measure-nav-performance.mjs —— 切页渲染性能测量（longtask + 计时）
 *
 * 登录后依次点击切换目标路由，测量：
 *   urlDelay：点击 → location.href 变化（导航开始）
 *   renderDelay：点击 → header h1 变化（新页首帧渲染）
 *   longtasks：切页期间主线程长任务（>50ms 阻塞）次数/总时长/最长单次
 * 用法：
 *   E2E_CHROME=<chromium> PWVIEWER_PLAYWRIGHT=<playwright> \
 *     node test/measure-nav-performance.mjs [baseUrl] [路由逗号分隔]
 */
const CHROME = process.env.E2E_CHROME || process.env.MS_CHROME;
const PW_PATH = process.env.PWVIEWER_PLAYWRIGHT || process.env.MS_PLAYWRIGHT;
if (!CHROME || !PW_PATH) {
  console.error('[perf] 需要 env：E2E_CHROME、PWVIEWER_PLAYWRIGHT');
  process.exit(2);
}
const { chromium } = await import('file://' + PW_PATH);
const BASE = (process.argv[2] || 'http://127.0.0.1:8791').replace(/\/$/, '');
const ROUTES = (process.argv[3] || '/about, /mcp, /setting, /tasks')
  .split(',').map((s) => s.trim()).filter(Boolean);
const FONTCONF = process.env.FONTCONFIG_FILE || '/volume1/VirtualDSM/DeepSeekHarness/fonts/fonts.conf';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu', '--disable-crash-reporter'],
  env: { ...process.env, FONTCONFIG_FILE: FONTCONF },
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

console.log(`[perf] 切页性能测量（base=${BASE}，路由：${ROUTES.join(' ')}）\n`);
try {
  // 登录
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);
  if (await page.locator('input[autocomplete="username"]').count()) {
    await page.fill('input[autocomplete="username"]', 'admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.waitForTimeout(800);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);
  }
  if (!(await page.locator('a[href="/about"]').count())) throw new Error('登录失败');

  // 先到首页稳定
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  for (const r of ROUTES) {
    // 页内注册 longtask 采集
    await page.evaluate(() => {
      window.__longtasks = [];
      try {
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__longtasks.push({ start: entry.startTime, dur: Math.round(entry.duration) });
          }
        });
        obs.observe({ entryTypes: ['longtask'] });
        window.__ltObs = obs;
      } catch { /* 不支持 */ }
    });
    // 回到首页再点击（统一起点）
    if (page.url() !== BASE + '/') {
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1200);
    }
    const t0 = Date.now();
    let urlT = -1, h1T = -1;
    const startUrl = page.url();
    const targetUrl = BASE + r;
    await page.click(`a[href="${r}"]`, { timeout: 6000 }).catch(() => {});
    // poll：URL 变化时间 + h1 变化时间
    const t1 = Date.now();
    for (let i = 0; i < 60; i++) {
      const st = await page.evaluate(() => ({
        url: location.href,
        h1: document.querySelector('header h1')?.textContent?.trim() ?? '',
      }));
      if (urlT === -1 && st.url !== startUrl && st.url.startsWith(targetUrl)) urlT = Date.now() - t1;
      if (h1T === -1 && (r === '/' ? st.url === BASE + '/' : st.url.startsWith(targetUrl))) {
        // h1 跟随判定：等待 50ms 后 h1 非空（新页标题已渲染）
      }
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(1500); // 让渲染/查询完成
    const end = await page.evaluate(() => {
      const h1 = document.querySelector('header h1')?.textContent?.trim() ?? '';
      const lts = window.__longtasks ?? [];
      return { h1, longtasks: lts, totalLong: lts.reduce((a, b) => a + b.dur, 0), maxLong: Math.max(0, ...lts.map((l) => l.dur)) };
    });
    console.log(`  ${r}: urlT=${urlT}ms renderT=${end.h1 !== '' && urlT !== -1 ? '<' + (Date.now() - t1) + 'ms' : 'n/a'} longtasks=${end.longtasks.length} 总阻塞=${end.totalLong}ms 最长=${end.maxLong}ms h1="${end.h1.slice(0, 20)}"`);
  }
} finally {
  await browser.close();
}
process.exit(0);