// 自建后端前端「纯截图验证」：不执行 evaluate（headless shell 渲染 2.7MB SPA 时 evaluate 会崩渲染进程）
// 用 CDP 截图管线看真实渲染：未登录登录页 → 输入密码点击 → 登录后主界面
// 用法：PAWCHIVE_WEB_URL / PAWCHIVE_WEB_USER / PAWCHIVE_WEB_PASS / KT_PLAYWRIGHT / KT_BROWSER / PAWCHIVE_SHOT_DIR
function need(n) { const v = process.env[n]; if (!v) throw new Error('缺少环境变量 ' + n); return v; }
const URL = need('PAWCHIVE_WEB_URL').replace(/\/+$/, '') + '/';
const USER = need('PAWCHIVE_WEB_USER');
const PASS = need('PAWCHIVE_WEB_PASS');
const SHOT_DIR = process.env.PAWHIVE_SHOT_DIR || '/tmp/webui-shots';
const PW = [process.env.KT_PLAYWRIGHT, process.env.PLAYWRIGHT_ROOT].filter(Boolean);
let chromium = null;
for (const cand of PW) { try { const m = await import(cand.startsWith('file://') ? cand : 'file://' + cand); chromium = m.chromium; break; } catch { /* next */ } }
if (!chromium) { console.error('需 KT_PLAYWRIGHT'); process.exit(2); }
const BE = need('KT_BROWSER');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { mkdir } = await import('node:fs/promises');
await mkdir(SHOT_DIR, { recursive: true }).catch(() => {});

const MAX_ROUNDS = 5;
let done = false;
for (let round = 1; round <= MAX_ROUNDS && !done; round++) {
  console.log(`\n=== 第 ${round} 轮 ===`);
  const b = await chromium.launch({ executablePath: BE, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  let crashed = false;
  const logs = [];
  p.on('crash', () => { crashed = true; console.log(`⚠ 崩溃（崩溃前日志 ${logs.length} 条）`); logs.slice(-6).forEach(l => console.log('  ', l)); });
  p.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 120)}`));
  p.on('pageerror', e => logs.push(`[pageerror] ${String(e.message).slice(0, 120)}`));
  try {
    await p.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await sleep(5000);
    if (crashed) continue;
    // 截图 1：未登录登录页
    const s1 = `${SHOT_DIR}/round${round}-login.png`;
    await p.screenshot({ path: s1 }).catch(e => console.log('截图1失败:', String(e.message).slice(0, 60)));
    const st1 = (await import('node:fs')).statSync(s1, { throwIfNoEntry: false });
    console.log('未登录截图:', st1 ? `${st1.size}B` : '无');
    if (crashed) continue;

    // 输入用户名/密码 + 提交（CDP 输入事件，不执行 evaluate）
    await p.fill('input[type=password]', PASS).catch(() => console.log('密码框未找到'));
    const uname = await p.$('input[type=text], input:not([type=password]):not([type=hidden])');
    if (uname) await uname.fill(USER).catch(() => {});
    await p.click('button[type=submit], form button, button:has-text("Login"), button:has-text("登录")').catch(() => console.log('登录按钮未找到'));
    await sleep(6000);
    if (crashed) continue;
    // 截图 2：登录后主界面
    const s2 = `${SHOT_DIR}/round${round}-home.png`;
    await p.screenshot({ path: s2 }).catch(e => console.log('截图2失败:', String(e.message).slice(0, 60)));
    const st2 = (await import('node:fs')).statSync(s2, { throwIfNoEntry: false });
    console.log('登录后截图:', st2 ? `${st2.size}B` : '无');
    done = !crashed && st1 && st2 && st1.size > 2000 && st2.size > 2000;
    console.log(done ? '✅ 本轮截图成功（登录页 + 主界面均有渲染内容）' : '⚠ 截图可能空白');
  } catch (e) {
    console.log(`⚠ 第 ${round} 轮异常:`, String(e.message).slice(0, 80));
  } finally {
    await b.close().catch(() => {});
  }
}
console.log(done ? '\n✅ 截图验证完成' : '\n❌ 未获有效截图');
console.log('DONE');