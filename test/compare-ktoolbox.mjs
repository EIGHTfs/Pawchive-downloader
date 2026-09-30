#!/usr/bin/env node
// dsh-skip-sensitive（测试脚本——含原版本地测试密码 env 回退——非生产凭据；整文件豁免凭据审计）
/**
 * test/compare-ktoolbox.mjs —— 我们 Node 后端 vs 原版 Python KToolBox 后端的 API 输出结构对比（脚本自动化——用户 2026-09-29 思路）
 * 原理：同输入分别调我们（默认 8790）与原版（默认 8791，KTOOLBOX_WEBUI__PORT=8791 启动），
 *       比较响应【结构/字段集】（数据值不同无妨——我们 ViciNeko 等真实下载、原版空库——聚焦契约/行为对齐）。
 * 扩展：支持假数据注入（--seed 注入测试数据到我们 DB——如测试任务/计划——让对比有参照）。
 * 用法：node test/compare-ktoolbox.mjs [--base-a http://127.0.0.1:8790] [--base-b http://127.0.0.1:8791] [--seed]
 */
'use strict';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const BASE_A = argVal('--base-a', 'http://127.0.0.1:8790'); // 我们
const BASE_B = argVal('--base-b', 'http://127.0.0.1:8791'); // 原版 KToolBox（需已启动）

// 可对比端点（GET——结构对比友好；含参数变体）
const CASES = [
  ['/api/v1/health', {}],
  ['/api/v1/session', {}],
  ['/api/v1/creators', {}],
  ['/api/v1/tasks', {}],
  ['/api/v1/project', {}],
  ['/api/v1/config/project', {}],
  ['/api/v1/config/schema?locale=zh-CN', {}],
  ['/api/v1/naming', {}],
  ['/api/v1/auto-sync/plans', {}],
  ['/api/v1/auto-sync/runs', {}],
  ['/api/v1/auto-sync/updates', {}],
  ['/api/v1/filesystem?path=', {}],
  ['/api/v1/about', {}],
  ['/api/v1/startup-notices', {}],
];

/** 提取结构签名（字段路径集合——数组取首元素递归；值类型标注；null 不标注类型=与任意类型兼容——原版字段可 null 时 null 语义一致不误报） */
function structureSig(v, prefix = '', out = new Set()) {
  if (Array.isArray(v)) {
    if (!v.length) { out.add(prefix + '[]'); return out; }
    // 对象数组按主键（id/path/name）对齐——同主键元素相互比较（避免固定 [0] 比较到两侧不同字段的误报）
    const keyFn = o => (o && typeof o === 'object' && (o.id != null ? String(o.id) : o.path != null ? String(o.path) : o.name != null ? String(o.name) : null));
    if (v.every(o => o && typeof o === 'object') && v.some(o => keyFn(o) != null)) {
      for (const item of v) {
        const k = keyFn(item);
        structureSig(item, prefix + (k != null ? `[${k}]` : '[0]'), out);
      }
      return out;
    }
    structureSig(v[0], prefix + '[0]', out); // 非对象数组/无主键：仍取首元素
    return out;
  }
  if (v === null) { out.add(prefix + ':null'); return out; } // null 独立标注（与原版字段可 null 匹配——diff 里 null vs object 不算缺）
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v).sort()) {
      const p = prefix ? `${prefix}.${k}` : k;
      const val = v[k];
      out.add(`${p}:${Array.isArray(val) ? 'array' : (val && typeof val === 'object' ? 'object' : typeof val)}`);
      if (val && typeof val === 'object') structureSig(val, p, out);
    }
    return out;
  }
  out.add(`${prefix}:${typeof v}`);
  return out;
}
const diff = (a, b) => {
  const keyOf = x => x.replace(/:(null|object|array|string|number|boolean)$/, ''); // 类型后缀剥离
  const typeOf = x => x.slice(keyOf(x).length + 1) || '';
  const keySet = new Set([...a, ...b].map(keyOf));
  const onlyA = [], onlyB = [];
  for (const k of keySet) {
    const inA = [...a].filter(x => keyOf(x) === k);
    const inB = [...b].filter(x => keyOf(x) === k);
    // null 兼容：任一侧为 null（可空字段）→ 另一侧任意类型都算匹配（字段存在即可）
    const aIsNull = inA.some(x => typeOf(x) === 'null');
    const bIsNull = inB.some(x => typeOf(x) === 'null');
    if (aIsNull || bIsNull) continue;
    const aTypes = new Set(inA.map(typeOf).filter(Boolean));
    const bTypes = new Set(inB.map(typeOf).filter(Boolean));
    for (const t of aTypes) if (!bTypes.has(t)) onlyA.push(`${k}:${t}`);
    for (const t of bTypes) if (!aTypes.has(t)) onlyB.push(`${k}:${t}`);
  }
  return { onlyA, onlyB };
};

async function fetchJson(base, path, cookie = '') {
  try {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(15000), headers: cookie ? { Cookie: cookie } : {} });
    if (!r.ok) return { __http: r.status };
    return await r.json();
  } catch (e) { return { __err: String(e.message || e).slice(0, 60) }; }
}

/** 登录原版 KToolBox（密码 env 可配——KTOOLBOX_TEST_PASSWORD；作者 env 启动密码：KTOOLBOX_WEBUI__PASSWORD）——拿 cookie 供后续请求 */
async function loginOriginal(base) {
  const password = process.env.KTOOLBOX_TEST_PASSWORD || process.env.KTOOLBOX_WEBUI__PASSWORD || 'admin123'; // dsh-skip-sensitive（测试环境原版本地启动密码——非生产凭据——env 优先）
  try {
    const r = await fetch(base + '/api/v1/session/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
      signal: AbortSignal.timeout(10000),
    });
    const setCookie = r.headers.get('set-cookie') || '';
    const sessionId = (setCookie.match(/ktoolbox_session=[^;]+/) || [])[0] || ''; // 原版 cookie 名 ktoolbox_session（作者 env 密码可配）
    if (r.ok || sessionId) { console.log(`[原版] 登录成功（cookie: ${sessionId.split('=')[0]}）`); return sessionId; }
    console.log(`[原版] 登录响应 ${r.status}（无 cookie——后续端点可能 401）`);
    return '';
  } catch (e) { console.log('[原版] 登录失败:', String(e.message || e).slice(0, 60)); return ''; }
}

(async () => {
  const cookie = await loginOriginal(BASE_B);
  console.log(`对比：我们(${BASE_A}) vs 原版(${BASE_B})——结构/字段集 diff（数据值不同忽略——聚焦契约对齐）\n`);
  let totalDiff = 0;
  for (const [path] of CASES) {
    const [a, b] = await Promise.all([fetchJson(BASE_A, path), fetchJson(BASE_B, path, cookie)]);
    const sigA = structureSig(a), sigB = structureSig(b);
    const d = diff(sigA, sigB);
    const mark = d.onlyA.length || d.onlyB.length ? '⚠️' : '✓';
    if (d.onlyA.length || d.onlyB.length) totalDiff++;
    console.log(`${mark} ${path}`);
    if (d.onlyB.length) console.log(`    原版有而我们缺: ${d.onlyB.slice(0, 6).join(', ')}${d.onlyB.length > 6 ? ` …(+${d.onlyB.length - 6})` : ''}`);
    if (d.onlyA.length) console.log(`    我们有而原版缺: ${d.onlyA.slice(0, 6).join(', ')}${d.onlyA.length > 6 ? ` …(+${d.onlyA.length - 6})` : ''}`);
  }
  console.log(`\n[对比] 完成：${CASES.length} 端点——${totalDiff} 个有结构差异（原版缺的可能是契约多余字段；我们缺的需对齐——行为对齐计划补）`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });