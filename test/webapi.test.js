#!/usr/bin/env node
/**
 * test/webapi.test.js —— 兼容层 WebAPI 实测脚本（零依赖）
 *
 * 自管服务：spawn server.js（独立端口 + 临时 DB）→ HTTP 断言各端点 → 输出 PASS/FAIL → kill。
 * 覆盖：session 放行 / health / creators(+avatar+PUT) / filesystem / tasks 创建(URL+fields) / 事件 / SSE / 404 边界。
 *
 * 用法：node test/webapi.test.js [--keep]（--keep=跑完保留服务方便人工看）
 */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_WEB_PORT) || 8891;
const KEEP = process.argv.includes('--keep');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

function req(method, p, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => { try { return JSON.parse(data); } catch { return null; } } }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

/** SSE 测试：读响应头 + 前 maxBytes 字节即断开（SSE 流不 end） */
function reqSSE(p, maxBytes = 400, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, res => {
      let data = '';
      res.on('data', c => {
        data += c;
        if (data.length >= maxBytes) { r.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    r.setTimeout(timeoutMs, () => { r.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
    r.end();
  });
}

function waitListen(retries = 30) {
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/v1/health', method: 'GET', timeout: 800 }, res => { res.resume(); resolve(); });
      r.on('error', () => { if (--retries > 0) setTimeout(tryOnce, 300); else reject(new Error('server 未监听')); });
      r.on('timeout', () => r.destroy());
      r.end();
    };
    tryOnce();
  });
}

async function main() {
  console.log(`[test] 启动兼容层测试服务（端口 ${PORT}，DB 内存临时）`);
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PAWCHIVE_WEB_PORT: String(PORT), PAWCHIVE_WEB_DB: `:memory:`, PAWCHIVE_DATA_ROOT: process.env.PAWCHIVE_DATA_ROOT || '/volume1/VirtualDSM/(Pawchive)/Pawchive' },
    stdio: 'ignore',
  });
  try {
    await waitListen();
    console.log('[test] 服务就绪\n');

    // 1. 会话（放行已登录）
    let r = await req('GET', '/api/v1/session');
    check('session GET → 200 authenticated=true', r.status === 200 && r.json()?.authenticated === true, `status=${r.status}`);
    r = await req('POST', '/api/v1/session/login', { body: { username: 't', password: 't' } });
    check('session login → 200 authenticated', r.status === 200 && r.json()?.authenticated === true);
    r = await req('POST', '/api/v1/session/logout');
    check('session logout → 200', r.status === 200);

    // 2. 杂项
    r = await req('GET', '/api/v1/health');
    check('health → 200 ok', r.status === 200 && r.json()?.status === 'ok');
    r = await req('GET', '/api/v1/site-version');
    check('site-version → 200', r.status === 200 && r.json()?.version);
    r = await req('GET', '/api/v1/project');
    check('project → 200（configuration.naming 映射）', r.status === 200 && r.json()?.configuration?.naming?.creator_dirname_format, `status=${r.status}`);

    // 3. creators
    r = await req('GET', '/api/v1/creators');
    const creators = r.json();
    check('creators → 200 array', r.status === 200 && Array.isArray(creators), `status=${r.status}`);
    if (Array.isArray(creators) && creators.length) {
      const c = creators[0];
      check('creators 条目字段（service/creator_id/name）', c.service && c.creator_id && c.name);
      if (c.avatar_url) {
        r = await req('GET', c.avatar_url);
        check(`avatar → 200（${c.service}/${c.creator_id}）`, r.status === 200, `status=${r.status}`);
      }
      r = await req('PUT', `/api/v1/creators/${c.service}/${c.creator_id}`, { body: { alias: 'test-alias', enabled: true } });
      check('creators PUT（编辑别名）→ 200', r.status === 200 && r.json()?.alias === 'test-alias', `status=${r.status}`);
      r = await req('DELETE', `/api/v1/creators/${c.service}/${c.creator_id}`);
      check('creators DELETE → 200', r.status === 200);
    } else {
      check('creators 有数据（DATA_ROOT 配置）', false, '空列表');
    }

    // 4. filesystem
    r = await req('GET', '/api/v1/filesystem?scope=project&mode=directory');
    const fsj = r.json();
    check('filesystem → 200（scope/mode/path/entries）', r.status === 200 && fsj?.scope === 'project' && fsj?.mode === 'directory' && fsj?.path && Array.isArray(fsj?.entries), `status=${r.status}`);
    r = await req('GET', '/api/v1/filesystem?scope=host&mode=directory&path=/');
    check('filesystem host → 200', r.status === 200 && Array.isArray(r.json()?.entries));

    // 5. tasks（fields 模式 + URL 模式）
    r = await req('POST', '/api/v1/tasks', { body: { spec: { kind: 'download', service: 'patreon', creator_id: '96944064', post_id: '168037096', output: '/tmp/pawchive-test-out' } } });
    check('tasks POST（fields 模式）→ 201', r.status === 201 && r.json()?.id, `status=${r.status}`);
    const taskId = r.json()?.id;
    r = await req('POST', '/api/v1/tasks', { body: { spec: { kind: 'download', post: 'https://pawchive.pw/patreon/user/96944064/post/168037096', output: '/tmp/pawchive-test-out' } } });
    check('tasks POST（URL 模式 spec.post）→ 201', r.status === 201 && r.json()?.id, `status=${r.status}`);
    r = await req('GET', '/api/v1/tasks');
    check('tasks GET → 200 array', r.status === 200 && Array.isArray(r.json()));
    if (taskId) {
      r = await req('GET', `/api/v1/tasks/${taskId}/events?limit=20`);
      check('tasks/{id}/events → 200 array', r.status === 200 && Array.isArray(r.json()));
      r = await req('GET', `/api/v1/tasks/${taskId}/attempts`);
      check('tasks/{id}/attempts → 200 array', r.status === 200 && Array.isArray(r.json()));
      r = await req('POST', `/api/v1/tasks/${taskId}/stop`);
      check('tasks/{id}/stop → 200', r.status === 200);
    }

    // 6. SSE（头部协议——读部分字节即断）
    const sse = await reqSSE('/api/v1/events?after=0');
    check('events SSE → 200 text/event-stream（retry 头）', sse.status === 200 && (sse.headers['content-type'] || '').includes('text/event-stream') && sse.body.includes('retry: 3000'), `status=${sse.status}`);

    // 7. 404 边界
    r = await req('GET', '/api/v1/mcp/status');
    check('mcp → 404（设计删除）', r.status === 404);
    r = await req('GET', '/api/v1/nope');
    check('未知端点 → 404', r.status === 404);
  } finally {
    if (!KEEP) server.kill();
  }

  console.log(`\n[test] 结果：${passed} 通过 / ${failed} 失败${KEEP ? '（--keep：服务保留）' : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('[test] 异常:', err.message); process.exit(2); });
