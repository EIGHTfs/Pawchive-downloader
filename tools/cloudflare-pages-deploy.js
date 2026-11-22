#!/usr/bin/env node
'use strict';
/**
 * Cloudflare Pages 直接上传部署（零依赖：node:fetch 直调 Cloudflare API v4）
 *
 * 部署 Pages 的「Direct Upload」形式：把指定目录作为构建产物上传。
 * 目录里放 `_worker.js`（Pages 的 Functions 高级模式入口，格式与 Workers 的
 * `export default { fetch }` 一致）即可运行 MEGA 中转逻辑。
 *
 * 环境变量：
 *   CF_API_TOKEN   Cloudflare API Token（权限：Cloudflare Pages:Edit、Account:Read）
 *   CF_ACCOUNT_ID  可选，缺省自动取 token 名下第一个账号
 *
 * 用法：
 *   CF_API_TOKEN=xxx node tools/cloudflare-pages-deploy.js <上传目录> [项目名]
 *   CF_API_TOKEN=xxx node tools/cloudflare-pages-deploy.js <上传目录> [项目名] --create-only
 *
 * 退出码：0 成功（打印 pages.dev 地址）；1 失败。
 * 注意：不打印 token，不把 token 写入任何文件。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.cloudflare.com/client/v4';

function token() {
  const t = process.env.CF_API_TOKEN;
  if (!t) { console.error('缺少环境变量 CF_API_TOKEN'); process.exit(2); }
  return t.trim();
}

async function cf(method, pathname, { json = null, form = null } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  let body = null;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { body = form; }
  const res = await fetch(`${API}${pathname}`, { method, headers, body });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok || (parsed && parsed.success === false)) {
    console.error(`[API] ${method} ${pathname} → HTTP ${res.status}`);
    console.error(text.slice(0, 600));
    return { ok: false, status: res.status };
  }
  return { ok: true, data: parsed };
}

/** 递归收集目录内文件（跳过隐藏目录与部署无关文件） */
function collectFiles(rootDir) {
  const files = [];
  const walk = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(rootDir);
  return files;
}

(async () => {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const rootDir = args[0];
  const projectName = args[1] || 'mega-index';
  if (!rootDir) { console.error('用法: node tools/cloudflare-pages-deploy.js <上传目录> [项目名]'); process.exit(2); }

  // 账号
  let accountId = process.env.CF_ACCOUNT_ID;
  if (!accountId) {
    const r = await cf('GET', '/accounts?per_page=50');
    if (!r.ok) process.exit(1);
    const first = (r.data.result || [])[0];
    if (!first) { console.error('该 token 下没有账号'); process.exit(1); }
    accountId = first.id;
    console.log(`[部署] 账号: ${first.name}`);
  }

  // 项目（存在则复用）
  const list = await cf('GET', `/accounts/${accountId}/pages/projects`);
  const existing = (list.data && list.data.result || []).find(p => p.name === projectName);
  if (existing) {
    console.log(`[部署] 复用已有项目: ${projectName}`);
  } else {
    const created = await cf('POST', `/accounts/${accountId}/pages/projects`, {
      json: { name: projectName, production_branch: 'main' },
    });
    if (!created.ok) process.exit(1);
    console.log(`[部署] 已创建项目: ${projectName}`);
  }

  // 收集文件 + 计算内容 hash 作为清单键
  const files = collectFiles(rootDir);
  if (!files.length) { console.error('上传目录为空'); process.exit(1); }
  const manifest = {};
  const blobs = [];
  for (const file of files) {
    const content = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const rel = '/' + path.relative(rootDir, file).split(path.sep).join('/');
    manifest[rel] = hash;
    blobs.push({ hash, content, rel });
  }
  console.log(`[部署] 待上传 ${files.length} 个文件: ${Object.keys(manifest).join(', ')}`);

  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  for (const b of blobs) form.append(b.hash, new Blob([b.content], { type: 'application/octet-stream' }), b.hash);

  const deploy = await cf('POST', `/accounts/${accountId}/pages/projects/${projectName}/deployments`, { form });
  if (!deploy.ok) process.exit(1);
  const d = deploy.data.result || {};
  const url = d.url || (d.latest_stage && d.latest_stage.name) || '';
  console.log(`[部署] 完成: id=${d.id || '?'}`);
  console.log(`[部署] 地址: ${url}`);
  if (d.aliases && d.aliases.length) console.log(`[部署] 别名: ${d.aliases.join(', ')}`);
})().catch(err => { console.error('[部署] 异常:', err && err.message || err); process.exit(1); });
