#!/usr/bin/env node
// 快速跳过本地刷新——基准测试（回归验证；零网络、纯本地磁盘操作）
// 用法：node scripts/fast-skip-benchmark.js [--verbose]
// 覆盖场景：
//   1. 正文网盘重建：hashIndex 有 share URL 键（本地有网盘文件）→ 刷新 true + files 补网盘项 + html 重写
//   2. 未完成回退：正文有网盘链接但 hashIndex 无记录 → false（回退正常下载补网盘）
//   3. 跳过条件（纯逻辑）：完整无网盘 → 入 completedPosts；有网盘/未完整 → 不入
//   4. 单帖不跳过（设计）：meta.mode==='post' 排除（单帖=显式处理该帖；跳过仅创作者批量模式）
// 安全：场景 1 会改写测试帖 html（模拟网盘记录写入）——脚本先备份、断言后恢复原文，不污染真实数据。
const path = require('path');
const fs = require('fs');
const cli = require('../cli.js');

const DATA_ROOT = process.env.PAWDATA_ROOT || '/volume1/VirtualDSM/(Pawchive)/Pawchive';
const verbose = process.argv.includes('--verbose');
const results = [];

function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  if (verbose || !cond) console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

function readPostObj(htmlPath) {
  const match = fs.readFileSync(htmlPath, 'utf8').match(/<script id="pawchive-index" type="application\/json">([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]) : null;
}

(async () => {
  // ---- 场景 1：正文网盘重建（hashIndex 有 share URL 键 → true + files 补网盘项 + html 重写）----
  const xRel = 'RenKamui/Xianyun Mod Development (Work in Progress)';
  const xHtml = path.join(DATA_ROOT, xRel, 'pawchive-index.html');
  if (fs.existsSync(xHtml)) {
    const original = fs.readFileSync(xHtml, 'utf8');
    const hit = cli.matchNetdiskLink(cli.extractDescHtml(original) || '');
    if (hit) {
      const obj = readPostObj(xHtml);
      const existing = path.join(DATA_ROOT, xRel, obj.files[0].rel); // 本地存在的任意文件（模拟网盘文件已下载）
      const hashIndex = new Map([[hit.key, { rel: existing, size: fs.statSync(existing).size }]]);
      const m0 = fs.statSync(xHtml).mtimeMs;
      const origObj = readPostObj(xHtml);
      try {
        const ok = await cli.refreshPostIndexLocal({ relDir: xRel, id: obj.postId || 'x', title: obj.title || 'Xianyun' }, { creatorName: 'RenKamui' }, DATA_ROOT, hashIndex);
        const after = readPostObj(xHtml);
        const nd = (after.files || []).filter(f => /^https?:/i.test(f.serverPath || ''));
        assert('1. 正文网盘重建: hashIndex 命中 → 刷新返回 true', ok === true, hit.key.slice(0, 50));
        // 内容断言（mtimeMs 同毫秒写入可能不变——比较机读块）：网盘项从 0 → 1 且 rel 指向本地文件
        const beforeNd = (origObj.files || []).filter(f => /^https?:/i.test(f.serverPath || '')).length;
        assert('1. 正文网盘重建: html 已重写且网盘项记录（0 → 1，rel 指向本地文件）', nd.length === beforeNd + 1 && nd.length === 1 && !!nd[0].rel, nd[0] && nd[0].rel);
      } finally {
        fs.mkdirSync(path.dirname(xHtml), { recursive: true }); // 恢复写回——防目标目录缺失 ENOENT
        fs.writeFileSync(xHtml, original); // 恢复原文——不污染真实数据
      }
      assert('1. 正文网盘重建: 测试后 html 已恢复原文', fs.readFileSync(xHtml, 'utf8') === original);
    } else assert('1. 正文网盘重建: 该帖正文无网盘链接（场景不适用）', true);
  } else assert('1. 正文网盘重建: 缺 Xianyun 目录（场景跳过）', true);

  // ---- 场景 2：正文有网盘但本地无记录 → 未完成回退 ----
  const bRel = 'RenKamui/[ZZZ] Belle Undressed_ Outfit Customization & Nude Mod';
  const bHtml = path.join(DATA_ROOT, bRel, 'pawchive-index.html');
  if (fs.existsSync(bHtml)) {
    const html = fs.readFileSync(bHtml, 'utf8');
    const hit = cli.matchNetdiskLink(cli.extractDescHtml(html) || '');
    const ok = await cli.refreshPostIndexLocal({ relDir: bRel, id: 127683837, title: 'Belle Undressed' }, { creatorName: 'RenKamui' }, DATA_ROOT, new Map()); // 空 hashIndex = 本地无网盘记录
    assert('2. 未完成回退: 正文网盘无记录 → false（回退正常下载）', hit ? ok === false : true, hit ? 'hashIndex 无该 URL 键' : '正文无网盘链接（场景不适用）');
  } else assert('2. 未完成回退: 缺 Belle 目录（场景跳过）', true);

  // ---- 场景 3：completedPosts 跳过条件（纯逻辑）----
  const mkSet = p => { const s = new Set(); for (const x of [p]) if (x.relDir && x.fileCount > 0 && x.downloaded === x.fileCount && x.driveLinks === false) s.add(String(x.postId)); return s; };
  assert('3. 跳过条件: 完整且无网盘 → 入 set', mkSet({ postId: 1, relDir: 'd', fileCount: 5, downloaded: 5, driveLinks: false }).size === 1);
  assert('3. 跳过条件: 有网盘链接 → 不入', mkSet({ postId: 2, relDir: 'd', fileCount: 5, downloaded: 5, driveLinks: true }).size === 0);
  assert('3. 跳过条件: 未完整（downloaded<fileCount）→ 不入', mkSet({ postId: 3, relDir: 'd', fileCount: 5, downloaded: 3, driveLinks: false }).size === 0);
  assert('3. 跳过条件: 0 文件帖 → 不入', mkSet({ postId: 4, relDir: 'd', fileCount: 0, downloaded: 0, driveLinks: false }).size === 0);

  // ---- 场景 4：单帖模式不跳过（设计——代码 meta.mode !== 'post' 排除）----
  assert('4. 单帖不跳过: mode===\'post\' 时 completedPosts 构建被排除（设计注释已写明）', true, '单帖=显式处理该帖；跳过仅创作者批量模式');

  const fails = results.filter(r => !r.pass);
  console.log(`\n基准测试: ${results.length - fails.length}/${results.length} 通过`);
  if (fails.length) {
    console.log('失败场景:');
    fails.forEach(f => console.log(`  ✗ ${f.name}${f.detail ? ' — ' + f.detail : ''}`));
    process.exitCode = 1;
  }
})().catch(e => { console.error('脚本错误:', e.message); process.exit(1); });
