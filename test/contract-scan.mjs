#!/usr/bin/env node
/**
 * test/contract-scan.mjs —— 前端契约读取扫描（一键辅助：改完后端响应后跑一遍——自动发现「前端读取但后端缺」的字段）
 *
 * 原理：扫描前端源码中响应数据字段访问链（.map/.length/.values/.trim 操作——字段 undefined 会崩），
 *       对照后端端点实际响应（fetch）——列出「前端读但后端缺」的高风险字段。
 * 用法：FRONT=docs/.probe-ktoolbox/webui/src BASE=http://127.0.0.1:8790 node test/contract-scan.mjs
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const FRONT = process.env.FRONT || path.join(HERE, '..', 'docs', '.probe-ktoolbox', 'webui', 'src');
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

// 1. 扫描前端：提取响应数据字段访问链（x.y.z.method——.map/.length/.values/.trim——method 后可能再跟）
function scanFrontend() {
  const chains = new Map(); // 链 -> {file:line}
  const rx = /\b([a-z_$][\w$]*)((?:\.[a-zA-Z_$][\w$]*)+)(\.map|\.length|\.values|\.trim)\b/g;
  const rxRoot = /(task|creator|project|data|spec|migration|field|location|notice|version|conversion|plan|run|result|source|preview)/;
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(e.name) && !e.name.includes('.test')) {
        const text = fs.readFileSync(full, 'utf8');
        let m;
        while ((m = rx.exec(text))) {
          const varRoot = m[1];
          const access = m[2]; // .a.b.c...
          const method = m[3];
          // 只关心响应数据根的链（task/spec/project/creator/data 等）——过滤局部变量（如 values/result.map 在函数内）
          if (rxRoot.test(varRoot) && !access.includes('children') && !access.includes('props')) {
            const fullChain = varRoot + access + method;
            if (!chains.has(fullChain)) chains.set(fullChain, { varRoot, access, method, at: path.relative(FRONT, full) + ':' + (text.slice(0, m.index).split('\n').length) });
          }
        }
      }
    }
  }
  walk(FRONT);
  return chains;
}

// 2. 对照后端响应（fetch 端点——按链的 varRoot 映射端点）
async function fetchEndpoint(ep) {
  try {
    const r = await fetch(BASE + '/api/v1' + ep, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
const ENDPOINTS = {
  task: '/tasks', project: '/project', creator: '/creators',
  data: '/tasks', spec: '/tasks', migration: '/naming/legacy-migration',
  field: '/config/schema?locale=zh-CN', conversion: '/naming/conversions',
  location: '/filesystem?path=', plan: '/auto-sync/plans', run: '/auto-sync/runs',
  result: '/tasks', source: '/naming/legacy-migration', preview: '/naming/preview',
};

async function main() {
  const chains = scanFrontend();
  console.log(`[scan] 前端读取链：${chains.size} 条（varRoot 映射端点对照）\n`);
  const missing = [];
  const checked = new Set();
  for (const [chain, info] of chains) {
    const ep = ENDPOINTS[info.varRoot];
    if (!ep || checked.has(ep)) continue;
    checked.add(ep);
    const resp = await fetchEndpoint(ep);
    if (resp == null) { console.log(`  [端点 ${ep} 无响应——跳过]`); continue; }
    // 取第一个样本（数组取 [0]；对象本身）
    const sample = Array.isArray(resp) ? (resp[0] || {}) : resp;
    // 链的 access 段（去掉 method）：从 sample 逐段深入——找缺
    const segs = info.access.split('.').filter(Boolean);
    let cur = sample;
    const missingSegs = [];
    for (const s of segs) {
      if (cur == null || cur[s] === undefined) { missingSegs.push(s); break; }
      cur = cur[s];
    }
    if (missingSegs.length) missing.push({ chain, at: info.at, missingSegs, method: info.method, ep });
  }
  // 输出缺字段
  if (missing.length) {
    console.log(`⚠️ 高风险：前端读取但后端响应缺失（${missing.length} 条）——补这些字段防前端崩：\n`);
    for (const m of missing) console.log(`  ${m.chain}（${m.at}）→ 后端缺「${m.missingSegs.join('.')}」（${m.method} 操作）[端点 ${m.ep}]`);
  } else {
    console.log('✓ 未发现「前端读取但后端缺」的字段（对照样本端点）');
  }
  console.log(`\n[scan] 完成（对照端点 ${checked.size} 个——数组/对象取首样本——嵌套缺段已列出）`);
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
