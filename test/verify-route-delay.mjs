#!/usr/bin/env node
/**
 * test/verify-route-delay.mjs —— 验证「creators 查询慢 → 切页整页 loading 不消失」机制
 *
 * playwright route 将 /api/v1/creators 延迟 N 秒，切页观察内容区是否卡 loading。
 * 用法：
 *   E2E_CHROME=<chromium> PWVIEWER_PLAYWRIGHT=<playwright> \
 *     node test/verify-route-delay.mjs [baseUrl] [delayMs=8000] [route]
 */
const CHROME = process.env.E2E_CHROME || process.env.MS_CHROME;
const PW_PATH = process.env.PWVIEWER_PLAYWRIGHT || process.env.MS_PLAYWRIGHT;
if (!CHROME || !PW_PATH) {
  console.error('[delay] 需要 env：E2E_CHROME、PWVIEWER_PLAYWRIGHT');
  process.exit(2);
}
const { chromium } = await import('file://' + PW_PATH);
const BASE = (process.argv[2] || 'http://127.0.0.1:8791').replace(/\/$/, '');
const DELAY = Number(process.argv[3] || 8000);
const TARGET = process.argv[4] || '/api/v1/creators';
const NAV_PATH = process.argv[5] || '/blockers'; // 延迟注入后切换到的页面路由
const MODE = process.argv[6] || 'click'; // click=SPA 点击切换 | goto=整页直达（冷查询）
const FONTCONF = process.env.FONTCONFIG_FILE || '/volume1/VirtualDSM/DeepSeekHarness/fonts/fonts.conf';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu', '--disable-crash-reporter'],
  env: { ...process.env, FONTCONFIG_FILE: FONTCONF },
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push('[pageerror] ' + String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text().slice(0, 120)); });

console.log(`[delay] 延迟注入实验：${TARGET} +${DELAY}ms → 切 ${NAV_PATH}\n`);
try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);
  if (await page.locator('input[autocomplete="username"]').count()) {
    await page.fill('input[autocomplete="username"]', 'admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.waitForTimeout(800); // 等表单校验通过/按钮 enabled（防竞态）
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);
  }

  // 注入延迟：目标 API 路径延迟 DELAY ms（注意：登录后首页可能已请求过 creators——先清缓存内存）
  await page.route(`**${TARGET}**`, async (route) => {
    await new Promise((r) => setTimeout(r, DELAY));
    await route.continue();
  });
  // 让首页完成初载，再切到目标路由（goto=直达整页重载触发冷查询；click=SPA 点击）
  if (MODE === 'goto') {
    await page.goto(BASE + NAV_PATH, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } else {
    const diag = await page.evaluate(() => ({
      href: location.href,
      navLinks: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).slice(0, 20),
      body: document.body?.innerText?.slice(0, 100) ?? '',
    }));
    console.log('  点击前诊断:', JSON.stringify(diag));
    await page.click(`a[href="${NAV_PATH}"]`, { timeout: 8000 });
  }
  const snap = async (label) => {
    const s = await page.evaluate(() => {
      const main = document.querySelector('main');
      const text = main?.innerText ?? '';
      return {
        textLen: text.length,
        hasSpinner: [...document.querySelectorAll('[data-slot="spinner"], [class*="spinner"], [class*="Spinner"]')].filter((el) => el.offsetParent !== null).length,
        head: text.slice(0, 60).replace(/\n/g, '│'),
      };
    });
    console.log(`  [${label}] text=${s.textLen} spinner=${s.hasSpinner} | ${s.head}`);
  };
  for (const [label, ms] of [['切后 0.5s', 500], ['切后 3s', 2500], ['切后 6s', 3000], ['切后 9s', 3000], ['切后 12s', 3000]]) {
    await page.waitForTimeout(ms);
    await snap(label);
  }
  if (pageErrors.length) console.log('  页面错误:', pageErrors.slice(-5).join(' | '));
} finally {
  await browser.close();
}
process.exit(0);