#!/usr/bin/env node
/**
 * test/measure-first-load.mjs —— 首屏冷启动加载性能测量
 *
 * 新 browser context（无缓存）打开 baseUrl，记录：
 *   - network 总传输量（按资源类型）
 *   - navigation timing（domInteractive / domContentLoaded / load）
 *   - 资源加载明细（前 15 大）
 * 用法：
 *   E2E_CHROME=<chromium> PWVIEWER_PLAYWRIGHT=<playwright> \
 *     node test/measure-first-load.mjs [baseUrl]
 */
const CHROME = process.env.E2E_CHROME || process.env.MS_CHROME;
const PW_PATH = process.env.PWVIEWER_PLAYWRIGHT || process.env.MS_PLAYWRIGHT;
if (!CHROME || !PW_PATH) {
  console.error('[firstload] 需要 env：E2E_CHROME、PWVIEWER_PLAYWRIGHT');
  process.exit(2);
}
const { chromium } = await import('file://' + PW_PATH);
const BASE = (process.argv[2] || 'http://127.0.0.1:8791').replace(/\/$/, '');
const FONTCONF = process.env.FONTCONFIG_FILE || '/volume1/VirtualDSM/DeepSeekHarness/fonts/fonts.conf';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu', '--disable-crash-reporter'],
  env: { ...process.env, FONTCONFIG_FILE: FONTCONF },
});
// 全新 context = 冷加载
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const resources = [];
page.on('response', (res) => {
  const ct = res.headers()['content-type'] || '';
  const url = res.url();
  if (url.startsWith(BASE)) {
    resources.push({ url: url.replace(BASE, ''), size: res.headers()['content-length'] ? Number(res.headers()['content-length']) : 0, ct });
  }
});

console.log(`[firstload] 首屏冷启动测量（base=${BASE}）\n`);
try {
  const t0 = Date.now();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return {
      domInteractive: Math.round(n.domInteractive),
      domContentLoaded: Math.round(n.domContentLoadedEventEnd),
      load: Math.round(n.loadEventEnd),
      transferSize: n.transferSize,
      decodedBodySize: n.decodedBodySize,
    };
  });
  // 统计资源
  const byType = {};
  let total = 0;
  for (const r of resources) {
    if (!r.size) continue;
    const t = r.ct.includes('javascript') ? 'js' : r.ct.includes('css') ? 'css' : r.ct.includes('html') ? 'html' : r.ct.includes('font') ? 'font' : 'other';
    byType[t] = (byType[t] || 0) + r.size;
    total += r.size;
  }
  console.log(`  总耗时(到 domContentLoaded): ${Date.now() - t0}ms（wall）`);
  console.log(`  navigation timing: domInteractive=${nav.domInteractive}ms dcl=${nav.domContentLoaded}ms load=${nav.load}ms 文档传输=${Math.round(nav.transferSize / 1024)}KB`);
  console.log(`  网络传输（content-length 汇总）: ${(total / 1024).toFixed(0)}KB`);
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${(v / 1024).toFixed(0)}KB`);
  console.log(`  资源数: ${resources.length}（前 12 大）：`);
  resources.filter((r) => r.size).sort((a, b) => b.size - a.size).slice(0, 12)
    .forEach((r) => console.log(`    ${(r.size / 1024).toFixed(0)}KB  ${r.url.slice(0, 60)}`));
} finally {
  await browser.close();
}
process.exit(0);