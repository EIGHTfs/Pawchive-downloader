#!/usr/bin/env node
/**
 * test/e2e-webui.mjs —— WebUI 兼容层前端自动点击/渲染测试（防前端崩：trim/join 类 pageerror）
 *
 * 模式：playwright + chromium headless（复用本机已有环境——路径一律 env 化，禁止硬编码）
 * 用法：
 *   E2E_CHROME=<chromium 可执行文件> PWVIEWER_PLAYWRIGHT=<playwright index.mjs> \
 *     node test/e2e-webui.mjs [baseUrl]（默认 http://127.0.0.1:8790/）
 */
const CHROME = process.env.E2E_CHROME || process.env.MS_CHROME;
const PW_PATH = process.env.PWVIEWER_PLAYWRIGHT || process.env.MS_PLAYWRIGHT;
if (!CHROME || !PW_PATH) {
  console.error('[e2e] 需要 env：E2E_CHROME（chromium 可执行文件）、PWVIEWER_PLAYWRIGHT（playwright index.mjs 路径）——禁止硬编码路径');
  process.exit(2);
}
const { chromium } = await import('file://' + PW_PATH);

const BASE = process.argv[2] || 'http://127.0.0.1:8790/';
const PAGES = ['', 'creators', 'naming', 'configuration', 'blockers', 'about', 'tasks']; // tasks 后置（该页 chromium 环境崩会断后续——先测渲染页捕获 pageerror）

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

let failures = 0;
async function visit(route, label, interact) {
  const errors = [];
  const onErr = e => errors.push('PAGE_ERROR: ' + String(e.message).slice(0, 220));
  const onCon = m => { if (m.type() === 'error') errors.push('CONSOLE[' + m.type() + ']: ' + m.text().slice(0, 220)); };
  const onReqFail = r => errors.push('REQUEST_FAILED: ' + r.url().slice(0, 160) + (r.failure()?.errorText ? ' (' + r.failure().errorText + ')' : ''));
  page.on('pageerror', onErr);
  page.on('console', onCon);
  page.on('requestfailed', onReqFail);
  try {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3500);
    if (interact) await interact();
  } catch (e) {
    errors.push('NAV: ' + String(e.message).slice(0, 160));
  }
  page.off('pageerror', onErr);
  page.off('console', onCon);
  page.off('requestfailed', onReqFail);
  const ok = errors.length === 0;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${errors.length ? ` → ${errors[0]}` : ''}`);
  if (errors.length > 1) errors.slice(1).forEach(e => console.log(`      ↳ ${e}`));
}

console.log(`[e2e] WebUI 自动点击测试（base=${BASE}）\n`);

// 1. 各路由渲染（捕获 pageerror——trim/join 类崩）
for (const r of PAGES) {
  await visit(r, `路由 /${r || ''}（${r || 'home'}）渲染`, r === 'tasks' ? async () => {
    // 添加任务交互：点「新任务/添加任务」按钮 → 对话框打开 → 选路径对话框 → 关闭
    const btn = page.getByRole('button').filter({ hasText: /新任务|添加任务|New Task|Add/i }).first();
    await btn.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const picker = page.getByRole('button').filter({ hasText: /浏览|Browse|选择/i }).first();
    await picker.click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
  } : null);
}

// 2. 创作者编辑交互（CreatorsPage 开关/别名——PUT 链路）
await visit('creators', '创作者交互（开关）', async () => {
  const toggle = page.locator('button[role="switch"]').first();
  await toggle.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1000);
});

await browser.close();
console.log(`\n[e2e] 结果：${failures === 0 ? '全部页面无前端错误 ✓' : `${failures} 页有前端错误 ✗`}`);
process.exit(failures ? 1 : 0);
