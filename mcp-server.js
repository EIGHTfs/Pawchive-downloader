#!/usr/bin/env node
/**
 * MCP server（stdio 传输，零依赖手写 MCP JSON-RPC 2.0）——供 AI 使用
 *
 * 职责：复用 core.js 业务能力（任务/创作者/auto-sync/naming/搜索），暴露为 MCP 工具；
 *       DSH 等 MCP 客户端 stdio 拉起本进程 → initialize → tools/list → tools/call。
 *
 * 协议面：MCP server 是继 KToolBox-webui HTTP 适配器之后的第三个协议面（引擎在 cli、业务在 core、协议在 server）。
 * 鉴权：v1 无鉴权（本地 stdio 受控环境）；env PAWCHIVE_MCP_TOKEN 可选——设置后 tools/call 参数须带 token 匹配。
 *
 * 用法：node mcp-server.js（stdio 协议，无参数）
 */
'use strict';

const readline = require('node:readline');

// ---------- core 复用（业务内核——MCP 工具实现全部调 core 现成能力） ----------
let core = null;
try { core = require('./core.js'); } catch (e) { /* 加载失败在 initialize 时报错 */ }

// ---------- 工具注册表：name → { description, paramsSchema, scope, safety, handler } ----------
const TOOLS = [];

function tool(name, description, paramsSchema, scope, safety, handler) {
  TOOLS.push({ name, description, paramsSchema, scope, safety, handler });
}

const str = (desc = '') => ({ type: 'string', description: desc });
const num = (desc = '') => ({ type: 'number', description: desc });
const bool = (desc = '') => ({ type: 'boolean', description: desc });
const anyOf = (desc = '') => ({ description: desc }); // core 常接受 undefined/object

// ---- 任务 ----
tool('list_tasks', '列出任务（可按状态过滤）', { status: str('按状态过滤（queued/running/completed/failed/stopped/paused/interrupted）'), limit: num('条数上限，默认 200'), token: str('鉴权 token（PAWCHIVE_MCP_TOKEN 已设时必填）') }, 'mcp:read', 'read', async (p) => core.listTasks({ status: p.status || null, limit: p.limit || 200 }));
tool('get_task', '查询单个任务详情', { id: str('任务 id', true), token: str() }, 'mcp:read', 'read', async (p) => core.getTask(p.id));
tool('task_attempts', '查询任务的所有执行尝试记录', { id: str('任务 id', true), token: str() }, 'mcp:read', 'read', async (p) => core.listAttempts(p.id));
tool('task_events', '查询任务事件流（job.*/download.*/task.*）', { id: str('任务 id', true), after: anyOf('事件序号起点（增量）'), token: str() }, 'mcp:read', 'read', async (p) => {
  const evts = core.eventStore.events ? core.eventStore.events(p.id) : [];
  return (p.after != null ? evts.filter(e => (e.id || 0) > Number(p.after)) : evts).slice(-200);
});
tool('create_task', '创建下载任务（作者 URL 或单帖 URL；立即调度执行）', { id: str('任务 id（可选，缺省自动生成）'), url: str('作者/帖子 URL，如 https://pawchive.pw/patreon/user/xxx 或 /post/xxx', true), concurrency: num('下载并发，默认 5'), token: str() }, 'mcp:write', 'write', async (p) => {
  const id = p.id || `task-mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  core.createTask({ id, kind: 'download', spec: { url: p.url, concurrency: p.concurrency || 5 } });
  return { id, status: 'queued' };
});
tool('update_task', '更新任务（spec 或备注；ACTIVE 任务改 spec 会拒绝）', { id: str('任务 id', true), spec: anyOf('新 spec 对象'), token: str() }, 'mcp:write', 'write', async (p) => {
  const t = core.getTask(p.id);
  if (!t) return { error: '任务不存在' };
  if (p.spec != null) {
    const ACTIVE = ['queued', 'blocked', 'running', 'pause_requested', 'stop_requested'];
    if (ACTIVE.includes(t.status)) return { error: '任务运行中不可编辑（ACTIVE 状态）' };
    core.db.prepare('UPDATE tasks SET spec_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p.spec), core.nowIso(), p.id);
  }
  return core.getTask(p.id);
});
tool('delete_task', '删除任务（可带 delete_outputs 安全清理本任务产物）', { id: str('任务 id', true), delete_outputs: bool('是否清理任务产物（需 preview 确认）'), token: str() }, 'mcp:write', 'destructive', async (p) => {
  core.abortTask(p.id); // 真中断下载
  if (p.delete_outputs) core.cleanupTaskArtifacts ? core.cleanupTaskArtifacts(p.id) : null;
  core.db.prepare('DELETE FROM tasks WHERE id = ?').run(p.id);
  return { id: p.id, deleted: true };
});
tool('pause_task', '暂停任务（真中断下载，保留 .tmp 续传）', { id: str('任务 id', true), token: str() }, 'mcp:write', 'write', async (p) => {
  core.abortTask(p.id);
  core.updateTaskStatus(p.id, 'paused');
  return { id: p.id, status: 'paused' };
});
tool('stop_task', '停止任务（真中断，终态 stopped）', { id: str('任务 id', true), token: str() }, 'mcp:write', 'write', async (p) => {
  core.abortTask(p.id);
  core.updateTaskStatus(p.id, 'stopped');
  return { id: p.id, status: 'stopped' };
});
tool('resume_task', '恢复任务（写回 queued 重新调度）', { id: str('任务 id', true), token: str() }, 'mcp:write', 'write', async (p) => {
  core.updateTaskStatus(p.id, 'queued');
  core.scheduleTick && core.scheduleTick();
  return { id: p.id, status: 'queued' };
});
tool('rerun_task', '重跑任务（清进度/错误，attempt+1，重新调度）', { id: str('任务 id', true), token: str() }, 'mcp:write', 'write', async (p) => {
  core.db.prepare('DELETE FROM task_attempts WHERE task_id = ?').run(p.id); // 防 sequence=1 唯一冲突（对齐 rerun 修复）
  core.db.prepare('UPDATE tasks SET progress_json = ?, error = NULL, failure_json = NULL, revision = revision + 1, updated_at = ? WHERE id = ?').run('{}', core.nowIso(), p.id);
  core.updateTaskStatus(p.id, 'queued');
  core.scheduleTick && core.scheduleTick();
  return { id: p.id, status: 'queued', note: 'attempt 记录已清，revision+1，重新调度' };
});
tool('cleanup_preview', '预览任务产物清理清单（delete outputs 安全清理的 dry-run）', { id: str('任务 id', true), token: str() }, 'mcp:read', 'read', async (p) => core.previewTaskArtifacts ? core.previewTaskArtifacts(p.id) : { files: [] });

// ---- 创作者 ----
const DATA_ROOT = () => (core.CONFIG && core.CONFIG.dataRoot) || process.env.PAWCHIVE_DATA_ROOT || ''; // 作者数据根（listCreators/searchCreators 需 targetPath）
tool('list_creators', '列出已收录创作者', { token: str() }, 'mcp:read', 'read', async () => core.listCreators(DATA_ROOT()));
tool('search_creators', '搜索创作者（按 id/name/service）', { id: str('创作者 id'), name: str('名字关键词'), service: str('平台 service'), token: str() }, 'mcp:read', 'read', async (p) => core.searchCreators({ id: p.id || null, name: p.name || null, service: p.service || null }, DATA_ROOT()));
tool('add_creator', '收录创作者（写 profile；enabled 默认开）', { service: str('平台 service（patreon/fantia 等）', true), creator_id: str('创作者 id', true), alias: str('显示别名'), enabled: bool('是否启用下载（默认 1）'), token: str() }, 'mcp:write', 'write', async (p) => core.updateCreatorProfile(p.service, p.creator_id, { alias: p.alias || null, enabled: p.enabled === false ? 0 : 1 }));
tool('update_creator', '更新创作者（别名/启用状态）', { service: str('平台 service', true), creator_id: str('创作者 id', true), alias: str('新别名'), enabled: bool('启用/停用'), token: str() }, 'mcp:write', 'write', async (p) => core.updateCreatorProfile(p.service, p.creator_id, { alias: p.alias !== undefined ? p.alias : null, enabled: p.enabled !== undefined ? (p.enabled ? 1 : 0) : 1 }));
tool('delete_creator', '从列表移除创作者（软删 removed 标记——下载目录保留）', { service: str('平台 service', true), creator_id: str('创作者 id', true), token: str() }, 'mcp:write', 'destructive', async (p) => core.deleteCreatorProfile(p.service, p.creator_id));

// ---- auto-sync ----
tool('list_automatic_sync_plans', '列出自动同步计划', { token: str() }, 'mcp:read', 'read', async () => core.listAutoSyncPlans());
tool('get_automatic_sync_plan', '查询单个自动同步计划', { id: str('计划 id', true), token: str() }, 'mcp:read', 'read', async (p) => core.getAutoSyncPlan(p.id));
tool('create_automatic_sync_plan', '创建自动同步计划（按创作者定时下载）', { id: str('计划 id（可选）'), name: str('计划名', true), creators: anyOf('创作者数组 [{service,creator_id}]', true), schedule: anyOf('调度配置 {kind, every, unit}（默认 interval 每小时）'), enabled: bool('默认启用'), token: str() }, 'mcp:write', 'write', async (p) => {
  const id = p.id || `plan-mcp-${Date.now().toString(36)}`;
  core.createAutoSyncPlan({ id, name: p.name, enabled: p.enabled !== false, creators: p.creators || [], schedule: p.schedule || { kind: 'interval', every: 1, unit: 'hour' } });
  return core.getAutoSyncPlan(id);
});
tool('update_automatic_sync_plan', '更新自动同步计划', { id: str('计划 id', true), name: str(), enabled: bool(), creators: anyOf(), schedule: anyOf(), token: str() }, 'mcp:write', 'write', async (p) => {
  core.updateAutoSyncPlan(p.id, { enabled: p.enabled, creators: p.creators, schedule: p.schedule, name: p.name });
  return core.getAutoSyncPlan(p.id);
});
tool('pause_automatic_sync_plan', '暂停自动同步计划', { id: str('计划 id', true), token: str() }, 'mcp:write', 'write', async (p) => { core.updateAutoSyncPlan(p.id, { enabled: false }); return core.getAutoSyncPlan(p.id); });
tool('resume_automatic_sync_plan', '恢复自动同步计划', { id: str('计划 id', true), token: str() }, 'mcp:write', 'write', async (p) => { core.updateAutoSyncPlan(p.id, { enabled: true }); return core.getAutoSyncPlan(p.id); });
tool('run_automatic_sync_plan', '立即触发自动同步计划（按计划创作者各建 sync 任务）', { id: str('计划 id', true), concurrency: num('并发，默认 5'), token: str() }, 'mcp:write', 'write', async (p) => {
  const plan = core.getAutoSyncPlan(p.id);
  if (!plan) return { error: '计划不存在' };
  // triggerAutoSyncPlan 期望 creators 为 'service:creator_id' 字符串数组（split(':') 解析）——getAutoSyncPlan 返回对象数组，此处转换
  const strCreators = (plan.creators || []).map(c => (typeof c === 'string' ? c : `${c.service}:${c.creator_id}`));
  await core.triggerAutoSyncPlan({ ...plan, creators: strCreators }, core.CONFIG.dataRoot || process.env.PAWCHIVE_DATA_ROOT || '', { concurrency: p.concurrency || 5 });
  return { id: p.id, triggered: true, note: `已为 ${strCreators.length} 个创作者创建 sync 任务` };
});
tool('delete_automatic_sync_plan', '删除自动同步计划', { id: str('计划 id', true), token: str() }, 'mcp:write', 'destructive', async (p) => { core.deleteAutoSyncPlan(p.id); return { id: p.id, deleted: true }; });
tool('list_automatic_sync_runs', '列出自动同步计划执行记录（应用层简化：返回计划状态快照）', { token: str() }, 'mcp:read', 'read', async () => core.listAutoSyncPlans());

// ---- 查询/配置 ----
tool('get_naming', '查询命名模板配置（创作者/帖子/文件名格式）', { token: str() }, 'mcp:read', 'read', async () => core.getNaming());
tool('config_schema', '查询配置 schema（env 字段与默认值）', { token: str() }, 'mcp:read', 'read', async () => {
  const c = core.CONFIG || {};
  return { locale: 'zh-CN', sections: { naming: { creator_dirname_format: c.creatorDirFormat, post_dirname_format: c.postDirFormat, filename_format: c.fileFormat }, job: { concurrency: c.concurrency, write_creator_index: true, download_file: true, include_revisions: c.includeRevisions } } };
});
tool('search_works', '拉取创作者作品列表（走 cli.fetchPostsByUrl）', { url: str('作者页 URL', true), token: str() }, 'mcp:read', 'read', async (p) => {
  const fetched = await core.cli.fetchPostsByUrl(p.url, core.CONFIG.dataRoot || '.');
  return { meta: fetched.meta || null, count: (fetched.posts || []).length, posts: (fetched.posts || []).map(x => ({ id: x.id, title: x.title, published: x.published })) };
});
tool('post_details', '查询单帖详情（走 cli 的帖解析）', { url: str('单帖 URL（含 /post/）', true), token: str() }, 'mcp:read', 'read', async (p) => {
  const { getPost } = core.cli;
  const detail = getPost ? await getPost(p.url) : null;
  return detail || { error: 'getPost 不可用或详情获取失败' };
});
tool('get_pawchive_version', '查询本系统版本信息', { token: str() }, 'mcp:read', 'read', async () => ({ name: 'Pawchive-downloader', protocol: 'KToolBox-webui', db: 'webui.db' }));

// ---- blockers（空对齐——我们无屏蔽词业务） ----
tool('list_blockers', '列出屏蔽规则（空——本项目未实现屏蔽功能）', { token: str() }, 'mcp:read', 'read', async () => []);
tool('replace_blockers', '替换屏蔽规则（空实现——不接受修改）', { token: str() }, 'mcp:write', 'destructive', async () => ({ error: '屏蔽规则未实现（空对齐）' }));

// ---------- MCP JSON-RPC 协议（stdio） ----------
const TOKEN = process.env.PAWCHIVE_MCP_TOKEN || null;

function jsonRpc(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function jsonError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }
function notify(method, params) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }

const toolsList = TOOLS.map(t => ({
  name: t.name,
  description: t.description,
  inputSchema: { type: 'object', properties: t.paramsSchema, required: Object.keys(t.paramsSchema).filter(k => t.paramsSchema[k].required) },
  annotations: { readOnlyHint: t.scope === 'mcp:read', destructiveHint: t.safety === 'destructive', idempotentHint: t.safety !== 'destructive', openWorldHint: false },
}));

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { jsonError(null, -32700, 'Parse error'); return; }
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize': {
        jsonRpc(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pawchive-mcp', version: '1.0.0' },
        });
        notify('notifications/initialized', {});
        break;
      }
      case 'tools/list':
        jsonRpc(id, { tools: toolsList });
        break;
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const t = TOOLS.find(x => x.name === name);
        if (!t) { jsonError(id, -32602, `Unknown tool: ${name}`); break; }
        // 可选鉴权：PAWCHIVE_MCP_TOKEN 已设时，调用参数须带匹配 token
        if (TOKEN && (args || {}).token !== TOKEN) { jsonError(id, -32001, 'Invalid MCP token'); break; }
        const out = await t.handler(args || {});
        jsonRpc(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        break;
      }
      case 'ping':
        jsonRpc(id, {});
        break;
      case 'notifications/initialized':
        break; // 客户端通知——无响应（JSON-RPC notification）
      default:
        jsonError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    jsonError(id, -32603, `Internal error: ${String(e && e.message || e)}`);
  }
});
rl.on('close', () => process.exit(0));

// ---------- 启动日志（stdio 协议下日志必须走 stderr——stdout 是协议通道） ----------
process.stderr.write(`[pawchive-mcp] 就绪：${TOOLS.length} 个工具（stdio ${TOKEN ? 'token 鉴权开' : '无鉴权'}）\n`);