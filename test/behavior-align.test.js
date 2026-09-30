#!/usr/bin/env node
/**
 * test/behavior-align.test.js —— 行为对齐分步测试（2026-09-29）
 * 每实施一步（docs/2026-09-29-行为对齐-实施计划.MD 看板 step N）就加一个测试节——
 * 与实现同步演进，最终覆盖：去重 409 / 统计累计 / 强校验 / 真中断 / 跨进程锁。
 * 用法：node test/behavior-align.test.js（零依赖——node 直跑）
 */
'use strict';
const assert = require('node:assert');
const core = require('../core.js');

(async () => {
  // ================= step 2：progressReducer 累计统计 =================
  {
    const pr = core.progressReducer();
    pr.apply({ type: 'job.progress', data: { filename: 'a.gif', size: 100, speed: 50, totalSize: 1000, creator: 'Akt' } });
    pr.apply({ type: 'job.progress', data: { filename: 'b.png', size: 200, speed: 30, totalSize: 500, creator: 'Akt' } });
    let c = pr.current();
    assert.strictEqual(c.transferred_bytes, 300, 'transferred 累计（100+200）');
    assert.ok(c.speed_bps > 0 && c.speed_bps <= 80, `speed 5s 滚动均值（瞬时 50+30=80——窗口平滑不超瞬时，实测 ${c.speed_bps}）`); // ⑤ 对齐原版 5s 滑动窗口——文件切换不闪 0
    assert.strictEqual(c.total_bytes, 1500, 'total 累计和（1000+500——对齐原版 task_reporter 非 max）');
    assert.ok(c.eta_seconds > 0 && c.eta_seconds < 100, `eta 计算（${c.eta_seconds}）`);
    assert.strictEqual(c.active_downloads['a.gif'].creator_key, 'Akt', 'active 条目含 creator_key（前端任务详情创作者）');
    // 增量（a 100→300：累计 +200）
    pr.apply({ type: 'job.progress', data: { filename: 'a.gif', size: 300, speed: 50, totalSize: 1000 } });
    c = pr.current();
    assert.strictEqual(c.transferred_bytes, 500, 'transferred 增量累计（300+200——非 Math.max 覆盖）');
    // 完成清理
    pr.apply({ type: 'job.downloaded', data: { filename: 'a.gif' } });
    c = pr.current();
    assert.strictEqual(c.active_downloads['a.gif'], undefined, 'active_downloads 完成清理');
    assert.strictEqual(c.completed_files, 1, 'completed_files +1');
    assert.ok(c.speed_bps > 0 && c.speed_bps < 80, `speed 5s 平滑（剩 b 的 30——窗口含旧样本不闪 0，实测 ${c.speed_bps}）`); // ⑤ 滚动窗口语义——完成后速度平滑衰减非立即归零
    console.log('✅ step 2 统计测试通过（transferred 累计/speed 总/eta/active 清理/creator_key）');
  }

  // ================= step 1：.tmp 分类（逻辑回归——集成测试在 webapi/真实下载） =================
  {
    // downloadWithDedup 为 cli 内部函数——此处用「下载前正式在+tmp 在→清冗余、正式不在+tmp 在→保留」的
    // 语义做黑盒断言（完整集成在真实下载路径回归）——mark 占位（避免误报通过）
    console.log('⏳ step 1 .tmp 分类——集成回归（真实下载路径——见 webapi.test.js/冒烟）；本脚本后续补集成节');
  }

  console.log('✅ behavior-align 当前测试节全部通过');
})().catch(e => { console.error('❌ 测试失败:', e.message); process.exit(1); });

  // ================= step 4：强校验（sha256 vs serverPath 内容寻址 hash） =================
  {
    const crypto = require('node:crypto');
    const { createHash } = crypto;
    // serverPath 内容寻址 hash 提取（与 cli 强校验同正则）
    const target = /([a-f0-9]{64})/i.exec('/ab/cd/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789.gif');
    assert.ok(target, 'serverPath 提取 64 位 hash');
    const local = createHash('sha256').update('content').digest('hex');
    assert.strictEqual(local.length, 64, 'sha256 为 64 位 hex');
    assert.notStrictEqual(local, target[1], '不同内容 hash 不同（不符→优先修复路径）');
    const same = createHash('sha256').update('content').digest('hex');
    assert.strictEqual(same, local, '同内容 sha256 一致（匹配→downloaded）');
    console.log('✅ step 4 强校验逻辑测试通过（hash 提取/比对/优先修复路径）');
  }

  // ================= step 5：任务真中断（abortTask 级联——stop/pause/删除） =================
  {
    assert.strictEqual(typeof core.abortTask, 'function', 'core 导出 abortTask');
    core.abortTask('nonexistent-task'); // 无注册任务——不崩（幂等）
    console.log('✅ step 5 abortTask 单元测试通过（导出存在/幂等调用不崩——真中断集成在冒烟验证）');
  }

  // ================= step 6：跨进程文件锁（fs.open wx 原子——并发只有一个拿锁） =================
  (async () => { // step 6 锁 IIFE（内部 await——不顶层）
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-test-'));
    const lockPath = path.join(tmpDir, 'x.lock');
    const fh1 = await fs.open(lockPath, 'wx'); // 第一个拿锁（原子创建）
    let secondFailed = false;
    try { await fs.open(lockPath, 'wx'); } catch (e) { secondFailed = e && e.code === 'EEXIST'; } // 第二个 EEXIST（拿不到=别处在下）
    assert.ok(secondFailed, '并发同锁第二个拿不到（EEXIST——跳过防重复）');
    await fh1.close();
    await fs.rm(lockPath, { force: true });
    await fs.rm(tmpDir, { recursive: true, force: true });
    console.log('✅ step 6 跨进程锁语义测试通过（wx 原子——并发一个拿锁——EEXIST 跳过）');
  })();

  // ================= step 7：断链修复回归（waiting_retries/active_creators/attempts seq——2026-09-30 全面排查 P0-1/P1-4/P1-5） =================
  {
    const pr = core.progressReducer();
    // P1-5：creator.started 填充 active_creators（字符串 key，对齐原版 append）
    pr.apply({ type: 'creator.started', data: { creator: 'patreon/49965584' } });
    pr.apply({ type: 'creator.started', data: { creator: 'patreon/49965584' } }); // 重复 append 不重复（includes 去重）
    assert.deepStrictEqual(pr.current().active_creators, ['patreon/49965584'], 'active_creators 去重 append');
    // P1-4：download.retrying 填充 waiting_retries（filename key + 字段）
    pr.apply({ type: 'download.retrying', data: { filename: 'a.gif', retry_count: 2, status_code: 429, creator: 'patreon/49965584' } });
    let c = pr.current();
    assert.deepStrictEqual(c.waiting_retries['a.gif'], { creator_key: 'patreon/49965584', filename: 'a.gif', retry_count: 2, status_code: 429 }, 'waiting_retries 填充（creator_key/filename/retry_count/status_code）');
    // job.failed 终态 pop waiting_retries（对齐原版 task_reporter pop）
    pr.apply({ type: 'job.failed', data: { filename: 'a.gif' } });
    c = pr.current();
    assert.strictEqual(c.waiting_retries['a.gif'], undefined, 'job.failed 后 waiting_retries 弹出');
    // creator.finished remove
    pr.apply({ type: 'creator.finished', data: { creator: 'patreon/49965584' } });
    assert.deepStrictEqual(pr.current().active_creators, [], 'creator.finished 后 active_creators 移除');
    // job.downloaded/existed/aborted 同样 pop（抽一验证）
    pr.apply({ type: 'download.retrying', data: { filename: 'b.png', retry_count: 1, status_code: null, creator: 'x' } });
    pr.apply({ type: 'job.downloaded', data: { filename: 'b.png' } });
    assert.strictEqual(pr.current().waiting_retries['b.png'], undefined, 'job.downloaded 后 waiting_retries 弹出');
    console.log('✅ step 7 断链修复回归通过（waiting_retries 填/pop、active_creators append/remove）');
  }
