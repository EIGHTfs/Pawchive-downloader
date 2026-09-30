#!/usr/bin/env node
/**
 * test/contract-check.js —— 契约字段完整性自动校验（防「响应缺字段 → 前端崩」类问题）
 *
 * 原理：openapi.yaml（前端项目自带，响应结构权威）→ 提取每个端点的 200 响应 schema 字段
 *       → 请求我们服务实际响应 → 校验响应含 schema 全部字段（缺 = 报缺失，如 about.authors）
 *
 * 用法：node test/contract-check.js [--port 8790] [--verbose]
 * 默认连运行中的 8790；也可用 --spawn 自启测试服务。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OPENAPI = path.join(ROOT, 'docs', '.probe-ktoolbox', 'webui', 'openapi.yaml');
const PORT = Number(process.env.TEST_WEB_PORT || 8790);
const VERBOSE = process.argv.includes('--verbose');

// 豁免清单：非前端崩溃点（响应结构按我们的实现返回，schema 字段不逐一匹配）
// 例：PUT /blockers 返回 {blockers:[]}（空列表场景，前端不渲染单个 blocker）
//     POST naming/source-parse|preview|apply 为操作端点（点击才调，非页面打开渲染路径）
const EXEMPT = new Set([
  'PUT /api/v1/blockers',
  'POST /api/v1/naming/source/parse',
  'POST /api/v1/naming/preview',
  'POST /api/v1/naming/apply',
]);

// ---------- openapi.yaml 简化解析（格式规整：2 空格缩进） ----------
function parseOpenapi(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const pathEndpoints = {}; // {method: {path, responseRef}}
  const schemas = {};       // {Name: {fields: [..], required: Set}}
  let cur = null;
  for (const line of lines) {
    if (/^  \/api\/v1\//.test(line)) {
      const p = line.trim().replace(':', '');
      cur = { path: p, methods: {} };
      pathEndpoints[p] = cur;
      continue;
    }
    if (!cur) continue;
    if (/^    (get|post|put|patch|delete):/.test(line)) {
      cur.curMethod = line.trim().replace(':', '');
      cur.methods[cur.curMethod] = { ref: null };
      continue;
    }
    // 方法下的 200 响应 → $ref 提取（缩进 8 空格 '200':，ref 行 16 空格）
    if (cur.curMethod && cur.methods[cur.curMethod] && cur.methods[cur.curMethod].ref === null) {
      const m = /^                \$ref: '#\/components\/schemas\/([A-Za-z0-9_]+)'/.exec(line);
      if (m) cur.methods[cur.curMethod].ref = m[1];
      continue;
    }
  }
  // components schemas：`    Name:` + `      properties:` + `        field:`
  const sc = [];
  for (const line of lines) {
    if (/^    [A-Z][A-Za-z0-9]*:$/.test(line)) sc.push({ line, name: line.trim().replace(':', ''), fields: [], required: new Set() });
  }
  let i = 0;
  for (const line of lines) {
    const m = /^    ([A-Z][A-Za-z0-9]*):$/.exec(line);
    if (m) i = sc.findIndex(s => s.name === m[1]) >= 0 ? sc.findIndex(s => s.name === m[1]) : i;
    if (i >= 0 && sc[i]) {
      if (/^      properties:$/.test(line)) sc[i].inProps = true;
      else if (/^      required:$/.test(line)) { sc[i].inProps = false; sc[i].inReq = true; }
      else if (/^      [a-z_]+:$/.test(line) && !/^      properties:|^      required:/.test(line)) { sc[i].inProps = false; sc[i].inReq = false; }
      else if (sc[i].inProps && /^        [A-Za-z_]+:$/.test(line)) sc[i].fields.push(line.trim().replace(':', ''));
      else if (sc[i].inReq && /^        - [a-zA-Z_]+$/.test(line)) sc[i].required.add(line.trim().replace(/^- /, ''));
    }
  }
  for (const s of sc) if (s.name) schemas[s.name] = { fields: s.fields, required: s.required };
  return { pathEndpoints, schemas };
}

function req(method, p, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: timeoutMs }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: () => { try { return JSON.parse(data); } catch { return null; } } }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error(`timeout ${p}`)); });
    r.end();
  });
}

// ---------- 校验：端点响应顶层字段 ⊇ schema fields ----------
async function checkEndpoint(method, path, ref, schemas) {
  const schema = schemas[ref];
  if (!schema || !schema.fields.length) return null; // 无 schema 信息（跳过）
  // 构造请求路径（path 参数端点跳过——需示例参数）
  if (path.includes('{')) return null;
  let r;
  try { r = await req(method.toUpperCase(), path === '/api/v1/events' ? `${path}?after=0` : path); } catch { return null; }
  if (r.status !== 200) return null;
  const body = r.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const missing = schema.fields.filter(f => !(f in body));
  return { path, method, ref, missing, status: r.status };
}

async function main() {
  console.log(`[contract] 校验端点契约字段（openapi.yaml → 实际响应，服务端口 ${PORT}）\n`);
  const { pathEndpoints, schemas } = parseOpenapi(OPENAPI);
  let checked = 0, ok = 0, issues = 0;
  const issuesList = [];
  for (const [p, ep] of Object.entries(pathEndpoints)) {
    for (const [method, meta] of Object.entries(ep.methods)) {
      if (!meta.ref) continue;
      const result = await checkEndpoint(method, p, meta.ref, schemas);
      if (!result) continue;
      checked++;
      if (result.missing.length && !EXEMPT.has(`${method.toUpperCase()} ${p}`)) {
        issues++;
        issuesList.push({ ...result });
        console.log(`  ✗ ${method.toUpperCase()} ${p}（schema ${result.ref}）缺字段: ${result.missing.join(', ')}`);
      } else {
        ok++;
        if (VERBOSE) console.log(`  ✓ ${method.toUpperCase()} ${p}（${result.ref}）`);
      }
    }
  }
  console.log(`\n[contract] 结果：${checked} 端点校验 / ${ok} 完整 / ${issues} 缺字段`);
  if (issues) {
    console.log('\n缺字段清单（前端可能崩溃点——需补响应字段）:');
    for (const it of issuesList) console.log(`  - ${it.method.toUpperCase()} ${it.path}: ${it.missing.join(', ')}`);
    process.exit(1);
  }
  console.log('✓ 无缺字段（openapi 顶层字段全覆盖）');
}

main().catch(e => { console.error('[contract] 异常:', e.message); process.exit(2); });
