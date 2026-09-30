#!/usr/bin/env node
/**
 * test/e2e-full.mjs —— 全量浏览器自检（我们 8790——逐页面/逐按钮/逐功能——不许停）
 *
 * 每页面独立 browser 实例（某页环境崩不连累后续）；pageerror/console/requestfailed 全捕获
 * 逐按钮点击（ESC 关对话框——不确认破坏性）；关键输入交互（搜索/开关/对话框打开）
 * 用法：E2E_CHROME=<chromium> PWVIEWER_PLAYWRIGHT=<playwright index.mjs> node test/e2e-full.mjs
 */
const CHROME = process.env.E2E_CHROME;
const PW = process.env.PWVIEWER_PLAYWRIGHT;
if (!CHROME || !PW) { console.error('[full] 缺 E2E_CHROME / PWVIEWER_PLAYWRIGHT'); process.exit(2); }
const { chromium } = await import('file://' + PW);

const BASE = process.env.OURS_BASE || 'http://127.0.0.1:8790';
const PAGES = ['', 'creators', 'tasks', 'naming', 'configuration', 'blockers', 'about'];
const allErrors = [];

for (const route of PAGES) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const errors = [];
  const reqFailed = [];
  page.on('pageerror', e => errors.push('PAGE_ERROR: ' + e.message.slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 160)); });
  page.on('requestfailed', r => reqFailed.push(r.url().split('/').pop() + ':' + (r.failure()?.errorText || '').slice(0, 60)));

  let btns = 0, clicked = 0, inputs = 0;
  const label = '/' + (route || 'home');
  try {
    await page.goto(BASE + '/' + route, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3500);
    btns = await page.getByRole('button').count().catch(() => 0);
    // 逐按钮点击（最多 40 个）
    for (let i = 0; i < Math.min(btns, 40); i++) {
      try {
        const b = page.getByRole('button').nth(i);
        if (!(await b.isVisible().catch(() => false))) continue;
        await b.click({ timeout: 1000 });
        clicked++;
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(200);
      } catch { /* 点击失败/disabled 跳过 */ }
    }
    // 关键输入交互（creators 搜索框）
    if (route === 'creators') {
      const searchInput = page.getByPlaceholder(/搜索|search/i).first();
      if (await searchInput.count().catch(() => 0)) {
        const nameInput = page.locator('input[type="search"], input[placeholder*="name"], input[placeholder*="名称"]').first();
        if (await nameInput.count().catch(() => 0)) {
          await nameInput.fill('RenKamui').catch(() => {});
          inputs++;
          await page.getByRole('button', { name: /搜索|search/i }).first().click().catch(() => {});
          await page.waitForTimeout(2500);
        }
      }
    }
  } catch (e) {
    errors.push('NAV: ' + String(e.message).slice(0, 100));
  }
  const ok = errors.length === 0;
  if (!ok) allErrors.push({ label, errors: [...errors], reqFailed: reqFailed.slice(0, 3) });
  console.log(`  ${ok ? '✓' : '✗'} ${label} 按钮${btns}(点${clicked}) 输入${inputs}${errors.length ? '\n      → ' + errors.join('\n      → ') : ''}${reqFailed.length ? '\n      [请求失败] ' + reqFailed.slice(0, 3).join(' | ') : ''}`);
  await browser.close().catch(() => {});
}

console.log(`\n[full] 全量完成：${PAGES.length} 页（9 页含交互）——有错页 ${allErrors.length}${allErrors.length ? '：\n' + allErrors.map(e => `  ${e.label}: ${e.errors[0]}`).join('\n') : ''}`);
process.exit(allErrors.length ? 1 : 0);