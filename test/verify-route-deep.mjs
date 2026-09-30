#!/usr/bin/env node
/**
 * test/verify-route-deep.mjs —— 切页后「深层内容完整度」深测
 *
 * 对比同一路由两种到达方式的最终内容完整度：
 *   A（刷新态）：page1 goto 路由（整页重载 + 冷 API）等 4s 采样
 *   B（切页态）：page2 从 home 点击侧边栏切到路由（SPA + 冷 API）——切后 0.6s/2.5s/5s 采样
 * 缺口 = B 最终指标显著低于 A（表格行/列表项/文本长度等）或 loading 残留。
 *
 * 用法：
 *   E2E_CHROME=<chromium> PWVIEWER_PLAYWRIGHT=<playwright index.mjs> \
 *     node test/verify-route-deep.mjs [baseUrl]（默认 http://127.0.0.1:8791）
 */
const CHROME = process.env.E2E_CHROME || process.env.MS_CHROME;
const PW_PATH = process.env.PWVIEWER_PLAYWRIGHT || process.env.MS_PLAYWRIGHT;
if (!CHROME || !PW_PATH) {
  console.error('[deep] 需要 env：E2E_CHROME、PWVIEWER_PLAYWRIGHT');
  process.exit(2);
}
const { chromium } = await import('file://' + PW_PATH);

const BASE = (process.argv[2] || 'http://127.0.0.1:8791').replace(/\/$/, '');
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'admin123';
const FONTCONF = process.env.FONTCONFIG_FILE || '/volume1/VirtualDSM/DeepSeekHarness/fonts/fonts.conf';

// 七路由（避开无头崩溃页 creators/configuration）
// 路由集（argv[5] 逗号分隔可覆盖；默认避开 creators——无头已知崩溃页）
const ROUTES = (process.argv[5] || '/, /tasks, /auto-sync, /blockers, /naming, /system, /about, /mcp, /setting')
  .split(',').map((s) => s.trim()).filter(Boolean);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu', '--disable-crash-reporter'],
  env: { ...process.env, FONTCONFIG_FILE: FONTCONF },
});

async function metrics(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const text = main?.innerText ?? '';
    const spin = [...document.querySelectorAll('[data-slot="spinner"], [class*="spinner"], [class*="Spinner"]')].filter(el => el.offsetParent !== null).length;
    return {
      textLen: text.length,
      textHead: text.slice(0, 50).replace(/\n/g, '│'),
      tables: document.querySelectorAll('table').length,
      rows: document.querySelectorAll('table tr').length,
      listItems: document.querySelectorAll('main li').length,
      buttons: document.querySelectorAll('main button').length,
      inputs: document.querySelectorAll('main input, main select, main textarea').length,
      undefinedCount: (text.match(/undefined/gi) || []).length,
      spinnerVisible: spin,
      hasLoadingText: /loading|加载|wait/i.test(text.slice(0, 500)),
    };
  });
}

async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);
  if (await page.locator('input[autocomplete="username"]').count()) {
    await page.fill('input[autocomplete="username"]', USER);
    await page.fill('input[type="password"]', PASS);
    await page.waitForTimeout(800); // 等表单校验通过/按钮 enabled（防竞态）
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);
  }
  if (!(await page.locator('a[href="/naming"]').count())) {
    const diag = await page.evaluate(() => ({
      url: location.href,
      body: document.body?.innerText?.slice(0, 150) ?? '',
      loginInputs: document.querySelectorAll('input').length,
    })).catch(() => null);
    console.error('  登录失败诊断:', JSON.stringify(diag));
    throw new Error('登录失败：侧边栏未出现');
  }
}

console.log(`[deep] 深层内容完整度深测（base=${BASE}）\n`);

try {
  // ---------- 单 page：登录一次（A 刷新态 + B 切页态共用会话） ----------
  const p1 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(p1);
  const A = {};
  for (const r of ROUTES) {
    await p1.goto(BASE + r, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await p1.waitForTimeout(4000);
    A[r] = await metrics(p1);
  }
  console.log('【刷新态 A 基准】');
  for (const r of ROUTES) {
    const m = A[r];
    console.log(`  ${r}: text=${m.textLen} rows=${m.rows} li=${m.listItems} btn=${m.buttons} in=${m.inputs} spin=${m.spinnerVisible} undef=${m.undefinedCount} | ${m.textHead}`);
  }

  // ---------- B：切页态（从首页点击切换，冷 API） ----------
  const B = {};
  console.log('\n【切页态 B 采样（0.6s → 2.5s → 5s）】');
  await p1.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p1.waitForTimeout(1500);
  for (const r of ROUTES) {
    if (r !== '/') await p1.click(`a[href="${r}"]`, { timeout: 4000 }).catch((e) => { throw new Error(`点击 ${r} 失败: ${e.message}`); });
    const samples = [];
    const delays = [600, 1900, 2500]; // 切后累计 0.6s / 2.5s / 5s
    for (const d of delays) {
      await p1.waitForTimeout(d);
      samples.push(await metrics(p1));
    }
    B[r] = samples;
    const last = samples[samples.length - 1];
    const missing = [];
    if (last.rows < A[r].rows * 0.8 && A[r].rows > 0) missing.push(`rows ${last.rows}/${A[r].rows}`);
    if (last.textLen < A[r].textLen * 0.7 && A[r].textLen > 200) missing.push(`text ${last.textLen}/${A[r].textLen}`);
    if (last.spinnerVisible > 0) missing.push(`spinner×${last.spinnerVisible}`);
    if (last.undefinedCount > 0) missing.push(`undefined×${last.undefinedCount}`);
    console.log(`  ${r}: 0.6s(text=${samples[0].textLen},rows=${samples[0].rows},spin=${samples[0].spinnerVisible}) → 2.5s(text=${samples[1].textLen},rows=${samples[1].rows}) → 5s(text=${last.textLen},rows=${last.rows},li=${last.listItems},spin=${last.spinnerVisible})${missing.length ? ` ⚠️ 缺口: ${missing.join(' ')}` : ' ✓ 完整'}`);
    // 切换到该页后停在原地，下一个路由从当前页点击切换
  }
  await p1.close();

  console.log('\n[deep] 结果汇总（B 最终 vs A）：');
  let issues = 0;
  for (const r of ROUTES) {
    const last = B[r][B[r].length - 1];
    const diff = [];
    if (A[r].rows > 0 && last.rows < A[r].rows * 0.8) diff.push(`行数 ${last.rows}/${A[r].rows}`);
    if (A[r].textLen > 200 && last.textLen < A[r].textLen * 0.7) diff.push(`文本 ${last.textLen}/${A[r].textLen}`);
    if (last.spinnerVisible > 0) diff.push('loading 残留');
    if (diff.length) { issues++; console.log(`  ✗ ${r}: ${diff.join('，')}`); }
  }
  if (!issues) console.log('  ✓ 全部路由切页 5s 后内容完整（与刷新一致）');
  console.log(issues ? `\n[deep] 发现 ${issues} 个路由有缺口` : '');
} finally {
  await browser.close();
}
process.exit(process.exitCode || 0);