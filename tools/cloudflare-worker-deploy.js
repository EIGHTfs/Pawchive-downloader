#!/usr/bin/env node
/**
 * Cloudflare Worker 部署助手（零依赖：node:fetch 直调 Cloudflare API v4，不需要 wrangler/npm 包）
 *
 * 用途：把 MEGA 中转 Worker（worker.js）部署到自己的 Cloudflare 账号，并绑定自定义域名。
 *
 * 环境变量：
 *   CF_API_TOKEN   Cloudflare API Token（权限：Workers Scripts:Edit + Zone:Workers Routes:Edit + Zone:Read）
 *   CF_ACCOUNT_ID  可选；不填则自动用 token 查第一个账号
 *   CF_ZONE_NAME   可选；自定义域名所在 zone（如 example.com）
 *
 * 用法：
 *   node cloudflare-worker-deploy.js <worker.js 路径> [worker 名]
 *   node cloudflare-worker-deploy.js <worker.js 路径> [worker 名] --domain mega.example.com
 *   node cloudflare-worker-deploy.js --list-accounts          # 只查账号（验证 token 是否可用）
 *
 * 说明：脚本只做「上传脚本 + 绑定自定义域名」，不做任何删除操作。
 */
const fs = require('node:fs');

const API = 'https://api.cloudflare.com/client/v4';

function need(name) {
  const value = process.env[name];
  if (!value) { console.error(`缺少环境变量 ${name}`); process.exit(2); }
  return value;
}

async function cf(path, { method = 'GET', body = null, contentType = null } = {}) {
  const token = need('CF_API_TOKEN');
  const headers = { Authorization: `Bearer ${token}` };
  if (contentType) headers['Content-Type'] = contentType;
  const res = await fetch(`${API}${path}`, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如脚本内容） */ }
  if (!res.ok || (json && json.success === false)) {
    console.error(`[CF] ${method} ${path} 失败 HTTP ${res.status}`);
    console.error(text.slice(0, 800));
    process.exit(1);
  }
  return json || text;
}

async function resolveAccountId() {
  if (process.env.CF_ACCOUNT_ID) return process.env.CF_ACCOUNT_ID;
  const res = await cf('/accounts?per_page=50');
  const first = (res.result || [])[0];
  if (!first) { console.error('该 token 下没有可用账号（token 权限是否含 Account:Read？）'); process.exit(1); }
  console.log(`[CF] 自动选中账号: ${first.name} (${first.id})`);
  return first.id;
}

/** 上传（或覆盖）Worker 脚本：multipart/form-data，metadata 为 ES module 形式 */
async function uploadWorker(accountId, scriptName, code) {
  const metadata = { main_module: 'worker.js', compatibility_date: '2025-01-01' };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
  const token = need('CF_API_TOKEN');
  const res = await fetch(`${API}/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) { console.error(`[CF] 上传脚本失败 HTTP ${res.status}\n${text.slice(0, 800)}`); process.exit(1); }
  console.log(`[CF] 脚本已上传: ${scriptName}`);
  return JSON.parse(text);
}

/** 给 zone 内的自定义域名绑定 Worker（Cloudflare 的 Workers 自定义域名 API） */
async function bindCustomDomain(accountId, scriptName, hostname, zoneName) {
  const zones = await cf(`/zones?name=${encodeURIComponent(zoneName)}`);
  const zone = (zones.result || [])[0];
  if (!zone) { console.error(`找不到 zone: ${zoneName}（域名 NS 是否已指向 Cloudflare 并激活？）`); process.exit(1); }
  console.log(`[CF] zone: ${zone.name} (${zone.id}) status=${zone.status}`);
  if (zone.status !== 'active') {
    console.error('[CF] zone 尚未激活（NS 还没生效），先等 NS 生效再绑定自定义域名');
    process.exit(1);
  }
  const res = await cf(`/accounts/${accountId}/workers/domains`, {
    method: 'PUT',
    contentType: 'application/json',
    body: JSON.stringify({ zone_id: zone.id, hostname, service: scriptName, environment: 'production' }),
  });
  console.log(`[CF] 自定义域名已绑定: ${hostname} → ${scriptName}`);
  return res;
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--list-accounts') {
    const res = await cf('/accounts?per_page=50');
    for (const a of res.result || []) console.log(`${a.id}  ${a.name}`);
    return;
  }
  const workerPath = args[0];
  if (!workerPath) { console.error('用法: node cloudflare-worker-deploy.js <worker.js 路径> [worker 名] [--domain host]'); process.exit(2); }
  const scriptName = args[1] && !args[1].startsWith('--') ? args[1] : 'mega-index';
  const domainIdx = args.indexOf('--domain');
  const domain = domainIdx >= 0 ? args[domainIdx + 1] : null;

  const code = fs.readFileSync(workerPath, 'utf8');
  const accountId = await resolveAccountId();
  await uploadWorker(accountId, scriptName, code);
  if (domain) {
    const zoneName = process.env.CF_ZONE_NAME || domain.split('.').slice(-2).join('.');
    await bindCustomDomain(accountId, scriptName, domain, zoneName);
  } else {
    console.log('[CF] 未指定 --domain：脚本已部署到 workers.dev（本网络被 SNI 阻断，需绑定自定义域名才能访问）');
  }
  console.log('[CF] 完成');
})().catch(err => { console.error('[CF] 异常:', err && err.message || err); process.exit(1); });
