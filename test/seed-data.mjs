#!/usr/bin/env node
/**
 * test/seed-data.mjs —— 假数据注入脚本（用户 2026-09-29：先脚本注入假数据，再模拟 API/按钮点击）
 * 注入测试数据到我们 DB（webui.db）——供 API 模拟/页面验证/与原版对比有参照：
 *   - 假任务（sync ViciNeko=stopped、download fanbox=completed——不触发真实下载）
 *   - 假 auto-sync 计划（interval）
 *   - 假 creator profile（alias/enabled/removed 样例）
 * 用法：PAWCHIVE_WEB_DB=webui.db node test/seed-data.mjs [--clean]（--clean 先清 seed- 前缀测试数据）
 */
'use strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const db = new DatabaseSync(process.env.PAWCHIVE_WEB_DB || path.join(__dirname, '..', 'webui.db'));
const now = () => new Date().toISOString();

const clean = process.argv.includes('--clean');
if (clean) {
  db.prepare(`DELETE FROM tasks WHERE id LIKE 'seed-%'`).run();
  db.prepare(`DELETE FROM auto_sync_plans WHERE id LIKE 'seed-%'`).run();
  db.prepare(`DELETE FROM creators_profile WHERE alias LIKE '%(seed)'`).run();
  console.log('✅ 已清理 seed- 前缀测试数据');
}

// 假任务（不执行——直接落 DB，状态 stopped/completed 供页面/API 展示）
const mkTask = (id, spec, status) => db.prepare(`INSERT OR REPLACE INTO tasks (id, kind, status, spec_json, presentation_json, position, revision, progress_json, error, failure_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(id, spec.kind || 'sync', status, JSON.stringify(spec), '{}', 0, 1, '{}', null, null, now(), now());
mkTask('seed-task-vicineko', { kind: 'sync', service: 'patreon', creator_id: '49965584', creators: [{ service: 'patreon', creator_id: '49965584' }], output: 'Pawchive', save_creator_indices: false, offset: 0, keywords: [], keywords_exclude: [] }, 'stopped');
mkTask('seed-task-fanbox', { kind: 'download', service: 'fanbox', creator_id: '24961447', post_id: '123456', post: 'https://pawchive.pw/fanbox/user/24961447/post/123456', output: 'Pawchive' }, 'completed');

// 假 auto-sync 计划
db.prepare(`INSERT OR REPLACE INTO auto_sync_plans (id, name, enabled, creators, schedule, next_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
  .run('seed-plan-1', '测试计划', 1, JSON.stringify(['patreon:49965584']), JSON.stringify({ kind: 'interval', every: 1, unit: 'days' }), now(), now(), now());

// 假 creator profile（alias/enabled/removed 样例——软删/恢复验证）
db.prepare(`INSERT OR REPLACE INTO creators_profile (service, creator_id, alias, enabled, removed) VALUES (?,?,?,?,?)`).run('patreon', '49965584', 'ViciNeko(seed)', 1, 0);

console.log('✅ 假数据已注入：seed-task-vicineko（sync/stopped）、seed-task-fanbox（download/completed）、seed-plan-1（interval 计划）、ViciNeko(seed) profile——供 API 模拟/页面验证/对比参照');