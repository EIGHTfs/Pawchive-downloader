// KToolBox /tasks 崩溃 CPU 热点定位（CDP Profiler）
// 用法：KT_URL/KT_USER/KT_PASS/KT_BROWSER 环境变量 + LD_LIBRARY_PATH，node test/ktui-profiler.mjs
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

const login = await fetch(URL + 'api/v1/session/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
const m = (login.headers.get('set-cookie') || '').match(/(ktoolbox_session=[^;]+)/);

// 多轮重试：每轮独立 browser，profiler 前置到 goto 前（全程采样），CPU 持续 >50% 即 stop
const sleep = ms => new Promise(r => setTimeout(r, ms));
let profile = null;
for (let round = 1; round <= 4 && !profile; round++) {
  console.log(`\n=== 第 ${round} 轮 ===`);
  let b = null;
  try {
    b = await chromium.launch({ executablePath: BE, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    const c = await b.newContext({ viewport: { width: 1280, height: 900 } });
    await c.addCookies([{ name: 'ktoolbox_session', value: m[1].split('=').slice(1).join('='), url: URL }]);
    const p = await c.newPage();
    let closed = false;
    p.on('close', () => { closed = true; });
    const cdp = await c.newCDPSession(p);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start').catch(() => {});
    await p.goto(URL + 'tasks', { waitUntil: 'load', timeout: 30000 }).catch(e => console.log('  goto err:', String(e.message).slice(0, 80)));
    const t0 = Date.now();
    let cpuHigh = 0;
    for (let i = 0; i < 72 && !closed; i++) {
      await sleep(250);
      let cpu = 0;
      try {
        const out = require('node:child_process').execSync(`ps aux | grep '[c]hrome-headless-shell' | awk '{s+=$3} END {print s+0}'`, { encoding: 'utf8' }).trim();
        cpu = parseFloat(out) || 0;
      } catch { cpu = -1; }
      if (cpu > 50) {
        cpuHigh++;
        if (i % 2 === 0) console.log(`  t+${Date.now() - t0}ms CPU=${cpu}%`);
        if (cpuHigh >= 2) {
          try { profile = await cdp.send('Profiler.stop'); console.log('  ✓ profiler stopped, 样本:', profile.profile.samples.length); } catch (e) { console.log('  stop 失败(可能已崩):', String(e.message).slice(0, 60)); }
          break;
        }
      } else cpuHigh = 0;
    }
    if (!profile) { if (!closed) console.log('  本轮未触发'); try { await cdp.send('Profiler.stop'); } catch {} }
  } catch (e) {
    console.log('  轮异常:', String(e.message).slice(0, 80));
  } finally {
    try { await b.close(); } catch { /* 已崩 */ }
  }
  if (profile) break;
}
if (profile) {
  // 聚合热点：按 node 的 functionName/url 统计样本
  const { nodes, samples } = profile.profile;
  const byNode = new Map();
  for (const n of nodes) byNode.set(n.id, n);
  const counts = new Map(); // key: url::funcName -> count
  for (const sid of samples) {
    const n = byNode.get(sid);
    if (!n) continue;
    const url = (n.url || 'anon').split('/').slice(-2).join('/');
    const fn = n.functionName || (n.callFrame ? n.callFrame.functionName : '') || '(anonymous)';
    const key = `${url} :: ${fn}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = samples.length;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`\n═══ CPU 热点 TOP15（样本 ${total}）═══`);
  for (const [key, c] of top) console.log(`  ${(100 * c / total).toFixed(1)}%  (${c})  ${key}`);
  // 按 URL 聚合
  const byUrl = new Map();
  for (const [key, c] of counts) { const url = key.split(' :: ')[0]; byUrl.set(url, (byUrl.get(url) || 0) + c); }
  console.log('\n按文件聚合:');
  for (const [url, c] of [...byUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${(100 * c / total).toFixed(1)}%  ${url}`);
} else {
  console.log('未抓到 profile（4 轮内未在崩溃前截获，或未复现）');
}
console.log('DONE');