#!/usr/bin/env node
/**
 * test/e2e-diff.mjs —— 原版 vs 我们 浏览器逐功能/逐按钮对比自检（同 bundle——差异即契约不符/崩点）
 *
 * 模式：playwright + chromium（env 化——禁止硬编码路径）
 * 原版（登录 cookie）vs 我们（无登录）——每页面枚举全部按钮逐个点击 → pageerror 捕获 → 输出差异
 * 用法：
 *   E2E_CHROME=<chromium> PWVIEWER_PLAYWRIGHT=<playwright index.mjs> \
 *     ORIGIN_BASE=http://127.0.0.1:8791 OURS_BASE=http://127.0.0.1:8790 \
 *     node test/e2e-diff.mjs
 */
const CHROME = process.env.E2E_CHROME || process.env.MS_CHROME;
const PW_PATH = process.env.PWVIEWER_PLAYWRIGHT || process.env.MS_PLAYWRIGHT;
if (!CHROME || !PW_PATH) { console.error('[diff] 需要 E2E_CHROME / PWVIEWER_PLAYWRIGHT env'); process.exit(2); }
const { chromium } = await import('file://' + PW_PATH);

const ORIGIN = process.env.ORIGIN_BASE || 'http://127.0.0.1:8791';
const OURS = process.env.OURS_BASE || 'http://127.0.0.1:8790';
const PAGES = ['', 'creators', 'tasks', 'naming', 'configuration', 'blockers', 'about'];

// （browser/ctx/page 在 audit 内按 base 独立创建——防一侧点击崩连累另一侧；原版登录也在此处理）

let failures = 0;
/** 每页独立 browser（点击崩只影响当前页——后续页继续；两侧都全点击，崩点保留提 issue 依据）；安全点击（跳过破坏性按钮） */
async function audit(base, label) {
  for (const route of PAGES) {
    const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    // 原版登录（admin/admin123——本地测试口令）：context.request 登录（cookie 自动共享到页面）
    if (label === '原版') {
      try { await ctx.request.post(base + '/api/v1/session/login', { data: { username: process.env.ORIGIN_USER || 'admin', password: process.env.ORIGIN_PASS || 'admin123' } }); } catch { /* 登录失败继续 */ }
    }
    const errors = [];
    const onErr = e => errors.push('ERR: ' + String(e.message).slice(0, 160));
    page.on('pageerror', onErr);
    let buttons = 0, clicked = 0;
    try {
      await page.goto(base + '/' + route, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => { errors.push('NAV: ' + String(e.message).slice(0, 80)); return; });
      await page.waitForTimeout(2500);
      if (page.isClosed()) { errors.push('BROWSER_CLOSED'); }
      else {
        buttons = await page.getByRole('button').count().catch(() => 0);
        // 双侧全点击（原版崩点=提 issue 依据；我们崩点=契约/前端问题）：跳过 disabled/隐藏/破坏性按钮；每页最多 5 个
        const DANGEROUS = /删除|移除|停止|新建|应用|保存|delete|remove|stop|create|apply|save|rerun|cleanup/i;
        let clickedOnPage = 0;
        for (let i = 0; i < buttons && clickedOnPage < 5; i++) {
          if (page.isClosed()) { errors.push('BROWSER_CLOSED_ON_CLICK'); break; }
          try {
            const b = page.getByRole('button').nth(i);
            const labelTxt = (await b.textContent().catch(() => '') || '').trim();
            if (!labelTxt || DANGEROUS.test(labelTxt)) continue;
            if (!(await b.isVisible().catch(() => false)) || !(await b.isEnabled().catch(() => false))) continue;
            await b.click({ timeout: 800 });
            clickedOnPage++; clicked++;
            await page.waitForTimeout(350);
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(150);
            // 只验证「点击不崩」——不恢复导航（避免 goto 卡死；下一按钮点击前若页面已导航会自然失败容错）
          } catch { /* 点击失败/崩——跳过 */ }
        }
      }
      await browser.close().catch(() => {});
    } catch (e) { errors.push('NAV: ' + String(e.message).slice(0, 100)); try { await browser.close(); } catch { /* 已崩退出 */ } }
    page.off('pageerror', onErr);
    const ok = errors.length === 0;
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} [${label}] /${route || 'home'} 按钮${buttons}(安全点${clicked})${errors.length ? ' → ' + errors[0] : ''}`);
  }
}

console.log(`[diff] 原版 ${ORIGIN} vs 我们 ${OURS}——逐页逐按钮对比（pageerror 捕获）\n`);
await audit(ORIGIN, '原版');
console.log(`\n--- 我们 ---\n`);
await audit(OURS, '我们');
console.log(`\n[diff] 完成：原版/我们逐按钮对比（我们页的 ✗ = 契约差异/崩点，原版同位置 ✓ 即我们后端响应问题）`);
process.exit(failures ? 1 : 0);