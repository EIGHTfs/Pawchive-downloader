// KToolBox /tasks 崩溃深入诊断（直连 + 200ms 内存/请求采样 + crash dump）
// 用法：KT_URL/KT_USER/KT_PASS/KT_BROWSER 环境变量，node test/ktui-crash-diag.mjs
// playwright 模块路径禁止硬编码：env KT_PLAYWRIGHT 指定（file:// 或绝对路径），缺省探测失败则报错退出
const PW_CANDIDATES = [process.env.KT_PLAYWRIGHT, process.env.PLAYWRIGHT_ROOT].filter(Boolean);
let chromium = null;
for (const cand of PW_CANDIDATES) {
  try {
    const mod = await import(cand.startsWith('file://') ? cand : 'file://' + cand);
    chromium = mod.chromium;
    break;
  } catch { /* 尝试下一个 */ }
}
if (!chromium) {
  console.error('无法加载 playwright：请设置 KT_PLAYWRIGHT');
  process.exit(2);
}
function need(n) { const v = process.env[n]; if (!v) throw new Error('缺少 ' + n); return v; }
const URL = need('KT_URL'), USER = need('KT_USER'), PASS = need('KT_PASS'), BE = need('KT_BROWSER');
const CRASH_DIR = process.env.KT_CRASH_DIR || '/tmp/kt-crashes';
const login = await fetch(URL + 'api/v1/session/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
const m = (login.headers.get('set-cookie') || '').match(/(ktoolbox_session=[^;]+)/);
const browser = await chromium.launch({
  executablePath: BE,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--enable-crash-reporter', `--crash-dumps-dir=${CRASH_DIR}`, '--enable-logging=stderr', '--v=1'],
  env: { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '' },
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{ name: 'ktoolbox_session', value: m[1].split('=').slice(1).join('='), url: URL }]);
const page = await context.newPage();
let closed = false, crashAt = 0;
page.on('close', () => { closed = true; crashAt = Date.now(); });
page.on('crash', () => { closed = true; crashAt = Date.now(); });
const logs = [];
page.on('console', c => { if (c.type() === 'error' || c.type() === 'warning') logs.push({ d: Date.now(), t: c.type(), x: c.text().slice(0, 140) }); });
page.on('request', r => { const u = r.url().replace(URL, '').slice(0, 60); if (!u.includes('assets/')) logs.push({ d: Date.now(), t: 'req', x: u }); });
page.on('response', r => { if (r.status() >= 400) logs.push({ d: Date.now(), t: 'resp' + r.status(), x: r.url().replace(URL, '').slice(0, 60) }); });

console.log('goto /tasks');
const t0 = Date.now();
await page.goto(URL + 'tasks', { waitUntil: 'load', timeout: 30000 }).catch(e => console.log('goto err:', String(e.message).slice(0, 80)));
const samples = [];
for (let i = 0; i < 100 && !closed; i++) {
  const mem = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : -1)).catch(() => -1);
  samples.push({ d: Date.now() - t0, mem });
  await page.waitForTimeout(200).catch(() => {});
}
const end = Date.now();
console.log(`状态: ${closed ? '⚠崩溃于 t+' + (crashAt - t0) + 'ms' : '存活(20s)'}`);
let prev = -1;
for (const s of samples) {
  if (s.mem >= 0 && Math.round(s.mem) !== prev) { console.log(`  t+${s.d}ms mem=${s.mem.toFixed(1)}MB`); prev = Math.round(s.mem); }
}
console.log('事件(console/请求/响应) 按时间:');
const evs = logs.filter(l => l.d - t0 > 0).slice(-25);
for (const l of evs) console.log(`  [+${l.d - t0}ms ${l.t}] ${l.x}`);
console.log('== crash dumps ==');
import('node:fs').then(fs => {
  try { for (const f of fs.readdirSync(CRASH_DIR)) console.log(' ', f); } catch { console.log('  无 dump 目录'); }
});
await browser.close().catch(() => {});
console.log('DONE');