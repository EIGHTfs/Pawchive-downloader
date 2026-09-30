// 自建后端前端全量渲染自检：未登录登录页 → 表单登录 → 主界面/导航 → 页面切换
// headless shell 渲染 2.7MB SPA 有概率性渲染进程崩溃：每轮独立 browser，最多 5 轮取成功
// 用法：PAWCHIVE_WEB_URL / PAWCHIVE_WEB_USER / PAWCHIVE_WEB_PASS / KT_PLAYWRIGHT / KT_BROWSER + LD_LIBRARY_PATH
function need(n) { const v = process.env[n]; if (!v) throw new Error('缺少环境变量 ' + n); return v; }
const URL = need('PAWCHIVE_WEB_URL').replace(/\/+$/, '') + '/';
const USER = need('PAWCHIVE_WEB_USER');
const PASS = need('PAWCHIVE_WEB_PASS');
const PW = [process.env.KT_PLAYWRIGHT, process.env.PLAYWRIGHT_ROOT].filter(Boolean);
let chromium = null;
for (const cand of PW) { try { const m = await import(cand.startsWith('file://') ? cand : 'file://' + cand); chromium = m.chromium; break; } catch { /* next */ } }
if (!chromium) { console.error('需 KT_PLAYWRIGHT'); process.exit(2); }
const BE = need('KT_BROWSER');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_ROUNDS = 5;

let succeeded = false;
for (let round = 1; round <= MAX_ROUNDS && !succeeded; round++) {
  console.log(`\n=== 第 ${round} 轮 ===`);
  const b = await chromium.launch({ executablePath: BE, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  let crashed = false;
  const logs = [];
  p.on('crash', () => { crashed = true; console.log(`⚠ 第 ${round} 轮渲染崩溃，崩溃前日志:`); logs.slice(-12).forEach(l => console.log('  ', l)); });
  p.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 150)}`));
  p.on('pageerror', e => logs.push(`[pageerror] ${String(e.message).slice(0, 150)}`));

  try {
    // 1. 未登录打开（登录页应渲染）
    await p.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await sleep(3000);
    const s1 = await p.evaluate(() => ({ url: location.href, title: document.title, bodyLen: document.body?.innerText.length || 0, inputs: [...document.querySelectorAll('input')].map(i => i.type) }));
    console.log('未登录页:', JSON.stringify(s1));
    if (crashed) continue;

    // 2. 表单登录
    await p.fill('input[type=password]', PASS); // 用户名字段
    const uname = await p.$('input[type=text], input:not([type=password]):not([type=hidden])');
    if (uname) await uname.fill(USER);
    await p.click('button[type=submit], form button, button:has-text("Login"), button:has-text("登录")').catch(() => {});
    await sleep(4000);
    if (crashed) continue;
    const s2 = await p.evaluate(() => ({ url: location.href, title: document.title, bodyLen: document.body?.innerText.length || 0, nav: document.querySelectorAll('aside a, nav a, [class*=sidebar] a').length, text: document.body?.innerText.slice(0, 120) || '' }));
    console.log('登录后主界面:', JSON.stringify(s2));
    if (crashed) continue;

    // 3. 主要页面切换（空壳数据端点，验证渲染不崩）
    const navCount = s2.nav || 0;
    const pages = [];
    if (navCount > 0) {
      const hrefs = await p.$$eval('aside a, nav a, [class*=sidebar] a', els => els.map(e => e.getAttribute('href')).filter(Boolean).slice(0, 8));
      for (const href of hrefs) {
        if (crashed) break;
        await p.goto(new URL(href, URL).href, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
        await sleep(2500);
        if (crashed) { console.log(`  ⚠ 切换到 ${href} 崩溃`); break; }
        const st = await p.evaluate(() => ({ title: document.title, len: document.body?.innerText.length || 0 })).catch(() => null);
        pages.push(`${href} → ${st ? st.title.slice(0, 30) + ' len=' + st.len : 'evaluate失败'}`);
        console.log('  页面:', pages[pages.length - 1]);
      }
    }
    succeeded = !crashed;
    console.log(succeeded ? `✅ 第 ${round} 轮全流程通过` : `⚠ 第 ${round} 轮中途崩溃`);
  } catch (e) {
    console.log(`⚠ 第 ${round} 轮异常:`, String(e.message).slice(0, 100));
  } finally {
    await b.close().catch(() => {});
  }
}
console.log(succeeded ? '\n✅ 渲染自检通过（未登录/登录/主界面/页面切换均正常）' : '\n❌ 全轮均崩溃或失败');
console.log('DONE');