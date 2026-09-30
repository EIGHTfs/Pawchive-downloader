// KToolBox WebUI 标签切换性能实测（可随 PR 提交；禁止硬编码——所有可变值走环境变量）
// 实测结论（2026-09-28，headless + 真实浏览器双重确认）：Tasks/Automatic sync/Creators/Posts/
// Naming format/MCP 标签点击后页面崩溃——真实缺陷，非无头环境特例；Overview/About 等为「无内容变化」。
// 用法：
//   KT_URL=http://<host>:8789/ \
//   KT_USER=admin KT_PASS=<随机密码> \
//   KT_BROWSER=<chromium-headless-shell 可执行路径> \
//   [KT_TABS=Tasks,Creators] [KT_SLOW_MS=500] \
//   LD_LIBRARY_PATH=<playwright 依赖库目录> node test/ktui-perf.mjs
// 无环境变量必填项时输出用法并退出（不写死任何路径/凭据/地址）。
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
  console.error('无法加载 playwright：请设置 KT_PLAYWRIGHT（如 file:///…/node_modules/playwright/index.mjs）');
  process.exit(2);
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}（禁止硬编码：${name} 必须显式传入）`);
  return v;
}
const URL = need('KT_URL');
const USER = need('KT_USER');
const PASS = need('KT_PASS');
const BROWSER_EXE = need('KT_BROWSER');
const SLOW_MS = Number(process.env.KT_SLOW_MS || 500);
const TABS = process.env.KT_TABS ? process.env.KT_TABS.split(',').map(s => s.trim()) : null;

// ── 登录（node 侧，抓 set-cookie 注入浏览器 context，绕过未登录 401 崩溃路径）──
const loginRes = await fetch(URL + 'api/v1/session/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const m = (loginRes.headers.get('set-cookie') || '').match(/(ktoolbox_session=[^;]+)/);
if (!m) { console.log('[登录] 失败（状态', loginRes.status, '），未拿到会话 cookie'); process.exit(1); }
const cookieValue = m[1].split('=').slice(1).join('=');

// ── 一级：探测导航标签列表（独立实例）──
let navTexts = [];
{
  const b = await chromium.launch({ executablePath: BROWSER_EXE, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    const c = await b.newContext({ viewport: { width: 1280, height: 900 } });
    await c.addCookies([{ name: 'ktoolbox_session', value: cookieValue, url: URL }]);
    const p = await c.newPage();
    await p.goto(URL, { waitUntil: 'load', timeout: 60000 });
    for (let i = 0; i < 80; i++) {
      const n = await p.evaluate(() => document.querySelectorAll('[class*="sidebar"] a, [class*="menu"] a, aside a, nav a').length).catch(() => -1);
      if (n > 5) break;
      await p.waitForTimeout(100);
    }
    navTexts = await p.evaluate(() => [...new Set([...document.querySelectorAll('[class*="sidebar"] a, [class*="menu"] a, aside a, nav a, a[href]')].map(a => (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)).filter(t => t && !/^Active tasks/.test(t)))].slice(0, 12)).catch(() => []);
  } catch (e) { console.log('[探测] 异常:', String(e.message).slice(0, 100)); }
  await b.close();
}
console.log('[导航候选]', JSON.stringify(navTexts));
if (TABS) navTexts = navTexts.filter(t => TABS.includes(t));

// ── 二级：逐标签独立浏览器实例（崩溃隔离），测量「导航就绪 + 点击→内容变化」──
const results = [];
for (const label of navTexts) {
  let b;
  try {
    b = await chromium.launch({ executablePath: BROWSER_EXE, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    const c = await b.newContext({ viewport: { width: 1280, height: 900 } });
    await c.addCookies([{ name: 'ktoolbox_session', value: cookieValue, url: URL }]);
    const p = await c.newPage();
    let closed = false;
    p.on('close', () => { closed = true; });
    const tNav = Date.now();
    await p.goto(URL, { waitUntil: 'load', timeout: 60000 });
    // 导航就绪 = 导航链接出现（waitForSelector 比轮询 evaluate 稳——页面主线程忙时 evaluate 会被阻塞）
    try {
      await p.waitForSelector('[class*="sidebar"] a, [class*="menu"] a, aside a, nav a', { timeout: 20000 });
    } catch { /* 超时继续，点击阶段会给出诊断 */ }
    const navReadyMs = Date.now() - tNav;
    const tClick = Date.now();
    const clickInfo = await p.evaluate(lb => {
      const els = [...document.querySelectorAll('[class*="sidebar"] a, [class*="menu"] a, aside a, nav a, a[href]')];
      const el = els.find(a => (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24) === lb);
      if (el) { el.click(); return { ok: true, total: els.length }; }
      return { ok: false, total: els.length, texts: [...new Set(els.map(a => (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24).slice(0, 24)))].slice(0, 15) };
    }, label).catch(e => ({ ok: false, err: String(e.message).slice(0, 60) }));
    if (!clickInfo.ok) {
      console.log(`  [诊断] ${label} 点击失败: total=${clickInfo.total}${clickInfo.texts ? ' 可见=' + JSON.stringify(clickInfo.texts) : ''}${clickInfo.err ? ' err=' + clickInfo.err : ''}`);
      results.push({ label, navReadyMs, delayMs: -3, flag: '点击失败' });
    } else {
      let changed = false, tFirst = 0;
      for (let i = 0; i < 80 && !closed; i++) {
        await p.waitForTimeout(50);
        const cur = await p.evaluate(() => document.body.innerText.length).catch(() => { closed = true; return -1; });
        if (closed) break;
        if (cur > 50 && i > 0) { changed = true; tFirst = Date.now(); break; }
      }
      if (closed) results.push({ label, navReadyMs, delayMs: -2, flag: '⚠崩溃' });
      else {
        const d = changed ? tFirst - tClick : -1;
        results.push({ label, navReadyMs, delayMs: d, flag: d > SLOW_MS && d > 0 ? '⚠卡顿' : d < 0 ? '无变化' : 'ok' });
      }
    }
  } catch (e) {
    results.push({ label, delayMs: -2, flag: '⚠browser失败' });
  } finally {
    try { await b.close(); } catch { /* 已崩则忽略 */ }
  }
}

console.log('\n═══ 结果 ═══');
for (const r of results) console.log(`  ${r.flag.padEnd(8)} ${r.label.padEnd(22)} 导航就绪 ${r.navReadyMs ?? '-'}ms | 切换 ${r.delayMs >= 0 ? r.delayMs + 'ms' : r.delayMs === -2 ? '(崩溃)' : r.delayMs === -3 ? '(点击失败)' : '(无内容变化)'}`);
const bad = results.filter(r => r.flag.startsWith('⚠') || r.delayMs < 0).length;
const total = results.filter(r => r.flag !== '点击失败').length;
console.log(`判定: 共 ${total} 个标签, 异常 ${bad} 个 → ${bad === 0 ? 'PASS' : 'FAIL'}`);
console.log('DONE');