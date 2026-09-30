#!/usr/bin/env node
/**
 * KToolBox 旧结构迁移脚本（独立运行，零依赖 Node；复用 cli.js 的 html 生成）
 *
 * 目标：把旧 KToolBox 下载目录整理成新结构——
 *   1. 帖子目录下的 attachments/ 子目录：附件移到父目录平铺（同 hash 同名冲突跳过）
 *   2. 用 post.json **反推生成** pawchive-index.html（id/service/title/content/file/attachments 字段
 *      已实测覆盖索引全部所需，且覆盖老渠道 gumroad 等）——旧帖补上新索引，参与全局 hash 去重
 *   3. 删除 KToolBox 生成的 index.html / post.json（旧正文页 + 旧元数据，移入回收站，
 *      不碰 pawchive-index.html 等配置索引名）
 *
 * 安全原则（file-move-must-dryrun-count / safe-delete-trash）：
 *   - 默认 --dryrun 只列出计划（移动 N 附件 / 生成 N 索引 / 删 N 旧文件 / 清 N 空目录），不落盘
 *   - 删除/移动全部 rename 进回收站 <path>/.trash/migrate-<时间戳>/（可恢复，绝不 rm）
 *   - 同名冲突（目标已有同名文件）→ 跳过不覆盖，统计留档
 *
 * 用法：
 *   node migrate.js <path> [--dryrun] [--trash <回收目录>] [--target <子路径>]
 *   例（先模拟，再执行；--target 只处理指定子目录）：
 *     node migrate.js "/volume1/VirtualDSM/(Pawchive)/Pawchive" --dryrun
 *     node migrate.js "/volume1/VirtualDSM/(Pawchive)/Pawchive" --target "Akt/2021 Eula EX" --dryrun
 *     node migrate.js "/volume1/VirtualDSM/(Pawchive)/Pawchive" --target "Akt/2021 Eula EX"
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cli = require('../cli.js'); // 复用 buildPostIndexHtml / parseIndexObj / fileKind / CONFIG 等（migrate.js 在 scripts/，cli.js 在上级）

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
const flags = { dryrun: false, trash: null, target: null, toKtool: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dryrun') flags.dryrun = true;
  else if (a === '--trash') flags.trash = args[++i];
  else if (a === '--target') flags.target = args[++i];
  else if (a === '--to-ktool') flags.toKtool = true; // 反向：我们的 pawchive 结构 → KToolBox 结构
  else if (a.startsWith('-')) { console.error(`未知参数: ${a}`); process.exit(2); }
  else positional.push(a);
}
if (positional.length < 1) {
  console.error('用法: node migrate.js <path> [--dryrun] [--trash <回收目录>] [--target <子路径>] [--to-ktool]');
  process.exit(2);
}
const root = positional[0];
const mode = flags.dryrun ? 'DRYRUN' : 'MIGRATE';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const trashDir = flags.trash || path.join(root, '.trash', `migrate-${ts}`);
const indexName = cli.CONFIG.indexFilename;
const scope = flags.target ? path.join(root, flags.target) : root; // 迁移范围（单帖/子目录）；root 仍为回收站与相对路径基准
if (flags.target && !fs.existsSync(scope)) { console.error(`目标子路径不存在: ${scope}`); process.exit(2); }

// ---------- 读 ktoolbox.toml（[naming] + [naming.post_structure]：KToolBox 命名可配，旧文件识别/反向结构从 toml 读而非写死） ----------
const KTOOLBOX_TOML = process.env.KTOOLBOX_TOML || path.join(__dirname, '..', 'docs', '.probe-ktoolbox', 'ktoolbox.toml');
const ktoolNaming = {};       // [naming] 表
const ktoolPostStruct = {};   // [naming.post_structure] 表
try {
  let section = '';
  for (const line of fs.readFileSync(KTOOLBOX_TOML, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    const sec = /^\[([^\]]+)\]$/.exec(t);
    if (sec) { section = sec[1]; continue; }
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const m = /^([A-Za-z0-9_]+)\s*=\s*"?([^"#]*[^"#\s])"?\s*$/.exec(t);
    if (!m) continue;
    if (section === 'naming') ktoolNaming[m[1]] = m[2].trim();
    else if (section === 'naming.post_structure') ktoolPostStruct[m[1]] = m[2].trim();
  }
} catch { /* 无 ktoolbox.toml：旧文件识别走默认兼容列表 */ }

// 旧文件识别（KToolBox 命名从 toml 读；无 toml 时默认兼容 content.txt/content.html 两种）：
// post.json 元数据 + 正文文件（content）+ 外链文件（external_links）+ 旧正文页 index.html
const contentNames = ktoolPostStruct.content ? [ktoolPostStruct.content] : ['content.txt', 'content.html'];
const extLinkNames = ktoolPostStruct.external_links ? [ktoolPostStruct.external_links] : ['external_links.txt', 'external_links.html'];
const ktoolOldFileSet = new Set(['post.json', 'index.html', ...contentNames, ...extLinkNames]);
const attSub = ktoolPostStruct.attachments || 'attachments'; // KToolBox 附件子目录名（反向迁移用）

/** HTML 剥标签 → 纯文本（反向迁移写 KToolBox content 文件用） */
function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// ---------- 递归收集（跳过 .pawchive/.trash/.git 内部目录） ----------
/** @returns {{attDirs: [{dir, parent}], oldFiles: [string]}} oldFiles=index.html + post.json */
function collect(rootDir) {
  const attDirs = [];
  const oldFiles = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = entries.map(e => e.name);
    // 帖根判定：目录直接含 KToolBox 旧文件（post.json 等）→ 只收集「根目录下」的直接子文件，不下钻子目录
    const isPostRoot = names.some(n => ktoolOldFileSet.has(n));
    for (const ent of entries) {
      if (ent.name === '.pawchive' || ent.name === '.trash' || ent.name === '.git' || ent.name === indexName) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (isPostRoot) { // 帖根内的子目录（attachments/revisions 等）：只登记附件子目录，不下钻
          if (ent.name === attSub) attDirs.push({ dir: full, parent: dir });
        } else if (ent.name === 'attachments') attDirs.push({ dir: full, parent: dir });
        else walk(full);
      } else {
        // KToolBox 旧文件只在帖根目录下：post.json 元数据 + 正文/外链（命名从 ktoolbox.toml 读）+ 旧正文页 index.html
        if (isPostRoot && ktoolOldFileSet.has(ent.name)) oldFiles.push(full);
      }
    }
  }
  walk(rootDir);
  return { attDirs, oldFiles };
}

/** 文件名消毒（与 cli sanitizeName 近似，内联避免依赖） */
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 200) || 'file';
}

/**
 * 从 KToolBox post.json 反推生成 pawchive-index.html（写入帖子目录，平铺后）。
 * 实测 post.json 含 id/user/service/title/content/published + file/attachments(name/path=hash)，
 * 字段完整覆盖索引所需（含老渠道 gumroad 等）。
 * @returns 生成的文件数；post.json 缺失/无文件返回 null
 */
function genPostIndexFromPostJson(postDir, rootDir) {
  const pj = path.join(postDir, 'post.json');
  if (!fs.existsSync(pj)) return null;
  let post;
  try { post = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { return null; }
  if (!post || (!post.file && !post.attachments)) return null;
  const seen = new Set(); // file 与附件同名同 hash 去重
  const files = [];
  // KToolBox 会把主文件重命名为 {post_id}_{原名}（如 TQsVO_7jz5...jpg）→ 索引 rel 指向实际磁盘名，图片墙才能显示
  const diskName = n => {
    if (fs.existsSync(path.join(postDir, n))) return n;
    const alt = `${post.id}_${n}`;
    return fs.existsSync(path.join(postDir, alt)) ? alt : n;
  };
  const add = ref => {
    if (!ref || !ref.path) return;
    const base = sanitizeName(ref.name || path.basename(ref.path.split('?')[0]));
    const name = diskName(base); // 优先原名，其次 {post_id}_ 重命名
    if (seen.has(name)) return;
    seen.add(name);
    let size = 0;
    try { size = fs.statSync(path.join(postDir, name)).size; } catch { /* 缺失 */ }
    files.push({ filename: name, size, exists: size > 0, serverPath: ref.path, rel: name });
  };
  add(post.file);
  for (const a of post.attachments || []) add(a);
  const creatorName = path.basename(path.dirname(postDir)); // 父目录 = 创作者目录名（纯名）
  const html = cli.buildPostIndexHtml(post, creatorName, path.relative(rootDir, postDir), files);
  fs.writeFileSync(path.join(postDir, indexName), html, 'utf8');
  return files.length;
}

// ---------- 迁移（平铺附件 → 反推索引 → 回收旧文件） ----------
function runMigration() {
  const { attDirs, oldFiles } = collect(scope);
  const stats = { moved: 0, skippedConflict: 0, genIndex: 0, oldRemoved: 0, dirRemoved: 0 };
  const planLines = [];
  cli.log(`[迁移] ${flags.dryrun ? '模拟' : '执行'} 开始：范围 ${flags.target || root}（attachments ${attDirs.length}，旧文件 ${oldFiles.length}）`);

  // 1) 附件平铺：attachments/<f> → 父目录/<f>
  for (const { dir, parent } of attDirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const name of files) {
      const src = path.join(dir, name);
      const dest = path.join(parent, name);
      const exists = fs.existsSync(dest);
      planLines.push(`  [附件] ${path.relative(root, src)} -> ${path.relative(root, dest)}${exists ? '  ⚠同名冲突跳过' : ''}`);
      if (flags.dryrun) { exists ? stats.skippedConflict++ : stats.moved++; continue; }
      if (exists) { stats.skippedConflict++; continue; } // 同名（通常同 hash 同内容）不覆盖
      fs.renameSync(src, dest);
      stats.moved++;
      cli.log(`[迁移] 附件平铺 ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
    }
    const remain = fs.readdirSync(dir);
    if (remain.length === 0) {
      planLines.push(`  [清目录] ${path.relative(root, dir)}`);
      if (!flags.dryrun) {
        const t = path.join(trashDir, `attachments-${path.basename(parent)}-${ts}`);
        fs.mkdirSync(path.dirname(t), { recursive: true });
        fs.renameSync(dir, t);
        stats.dirRemoved++;
        cli.log(`[迁移] 清空附件目录 ${path.relative(root, dir)}`);
      } else stats.dirRemoved++;
    } else {
      planLines.push(`  [保留] ${path.relative(root, dir)}（${remain.length} 个冲突文件未移）`);
    }
  }

  // 2) post.json 反推生成 pawchive-index.html（先生成，后删 post.json；dryrun 只统计）
  const postDirs = new Set(oldFiles.filter(f => path.basename(f) === 'post.json').map(f => path.dirname(f)));
  for (const postDir of postDirs) {
    planLines.push(`  [生成索引] ${path.relative(root, path.join(postDir, indexName))}`);
    if (!flags.dryrun) {
      const n = genPostIndexFromPostJson(postDir, root);
      if (n !== null) { stats.genIndex++; cli.log(`[迁移] 反推索引 ${path.relative(root, postDir)}（${n} 文件）`); }
      else planLines.push(`  [跳过] ${path.relative(root, postDir)}（post.json 无文件信息）`);
    } else stats.genIndex++;
  }

  // 3) 删除 KToolBox 旧 index.html / post.json（回收站）
  for (const old of oldFiles) {
    planLines.push(`  [删旧] ${path.relative(root, old)}`);
    if (!flags.dryrun) {
      const t = path.join(trashDir, `${path.basename(old)}-${ts}-${path.basename(path.dirname(old))}`);
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.renameSync(old, t);
      stats.oldRemoved++;
      cli.log(`[迁移] 回收旧文件 ${path.relative(root, old)}`);
    } else stats.oldRemoved++;
  }

  // ---------- 输出 ----------
  console.log(`[${mode}] 根目录: ${root}`);
  console.log(`[${mode}] 回收站: ${trashDir}`);
  console.log(`[${mode}] 计划/执行：移动附件 ${stats.moved}（冲突 ${stats.skippedConflict}）/ 生成索引 ${stats.genIndex} / 删旧 index.html+post.json ${stats.oldRemoved} / 清空目录 ${stats.dirRemoved}`);
  for (const line of planLines.slice(0, 500)) console.log(line);
  if (planLines.length > 500) console.log(`  ... 共 ${planLines.length} 条，已显示前 500`);
  if (flags.dryrun) {
    console.log(`\n[DRYRUN] 仅模拟：未落盘。确认后执行: node migrate.js "${root}"`);
  } else {
    console.log(`\n[MIGRATE] 完成：附件 ${stats.moved} / 生成索引 ${stats.genIndex} / 删旧 ${stats.oldRemoved} / 清目录 ${stats.dirRemoved}（回收站: ${trashDir}）`);
    cli.log(`[迁移] 完成：附件平铺 ${stats.moved}（冲突 ${stats.skippedConflict}）/ 生成索引 ${stats.genIndex} / 回收旧文件 ${stats.oldRemoved} / 清目录 ${stats.dirRemoved}（回收站 ${trashDir}）`);
  }
}

// ---------- 反向迁移：我们的 pawchive 结构 → KToolBox 结构（--to-ktool） ----------
// 每个含 pawchive-index.html 的帖目录：生成 KToolBox 的 post.json + 正文/外链文件（命名从 ktoolbox.toml 读）+
// 平铺附件收进附件子目录 + 我们的索引移入回收站
function runReverse() {
  const postDirs = [];
  (function walk(dir) {
    if (fs.existsSync(path.join(dir, indexName))) { postDirs.push(dir); return; } // 帖根（含我们索引）收集后不下钻
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === '.pawchive' || ent.name === '.trash' || ent.name === '.git') continue;
      if (ent.isDirectory()) walk(path.join(dir, ent.name));
    }
  })(scope);
  const contentName = ktoolPostStruct.content || 'content.txt';
  const extLinkName = ktoolPostStruct.external_links || 'external_links.txt';
  const stats = { gen: 0, moved: 0, indexRemoved: 0 };
  const planLines = [];
  cli.log(`[迁移] ${flags.dryrun ? '模拟' : '执行'} 反向(--to-ktool) 开始：范围 ${flags.target || root}（帖目录 ${postDirs.length}）`);
  for (const postDir of postDirs) {
    const indexPath = path.join(postDir, indexName);
    const obj = cli.parseIndexObj(fs.readFileSync(indexPath, 'utf8'));
    if (!obj || obj.type !== 'post' || !obj.postId) continue;
    // 正文/外链：从我们的 html 人读区提取
    const htmlText = fs.readFileSync(indexPath, 'utf8');
    const descM = /<div class="desc">([\s\S]*?)<\/div>/.exec(htmlText);
    const contentText = descM ? stripHtml(descM[1]) : '';
    const links = [...htmlText.matchAll(/<a href="(https?:\/\/[^"]+)" target="_blank" rel="noopener">/g)].map(m => m[1]);
    // 1) post.json（KToolBox 元数据）
    const postJson = {
      id: obj.postId, user: obj.userId || '', service: obj.service || '',
      title: obj.title || '', content: contentText, published: obj.published || null,
    };
    planLines.push(`  [生成] ${path.relative(root, path.join(postDir, 'post.json'))}`);
    if (!flags.dryrun) fs.writeFileSync(path.join(postDir, 'post.json'), JSON.stringify(postJson, null, 2) + '\n', 'utf8');
    // 2) 正文文件（KToolBox 命名从 toml）
    if (contentText && !fs.existsSync(path.join(postDir, contentName))) {
      planLines.push(`  [生成] ${path.relative(root, path.join(postDir, contentName))}`);
      if (!flags.dryrun) fs.writeFileSync(path.join(postDir, contentName), contentText + '\n', 'utf8');
    }
    // 3) 外链文件（URL 列表）
    if (links.length && !fs.existsSync(path.join(postDir, extLinkName))) {
      planLines.push(`  [生成] ${path.relative(root, path.join(postDir, extLinkName))}`);
      if (!flags.dryrun) fs.writeFileSync(path.join(postDir, extLinkName), [...new Set(links)].join('\n') + '\n', 'utf8');
    }
    // 4) 平铺附件收进附件子目录（KToolBox attachments/；只移帖根直接子文件，不碰已分层文件）
    const attDir = path.join(postDir, attSub);
    for (const f of (obj.files || [])) {
      if (!f.rel || path.isAbsolute(f.rel)) continue;
      const src = path.join(postDir, f.rel);
      if (!fs.existsSync(src) || path.dirname(src) !== postDir) continue; // 只移帖根直接子文件
      const dest = path.join(attDir, path.basename(f.rel));
      if (fs.existsSync(dest)) continue;
      planLines.push(`  [附件] ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
      if (!flags.dryrun) {
        fs.mkdirSync(attDir, { recursive: true });
        fs.renameSync(src, dest);
        stats.moved++;
        cli.log(`[迁移] 附件收子目录 ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
      } else stats.moved++;
    }
    // 5) 我们的索引移入回收站（ktool 结构不再用）
    planLines.push(`  [删索引] ${path.relative(root, indexPath)}`);
    if (!flags.dryrun) {
      const t = path.join(trashDir, `${indexName}-${ts}-${path.basename(postDir)}`);
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.renameSync(indexPath, t);
      stats.indexRemoved++;
      cli.log(`[迁移] 回收索引 ${path.relative(root, indexPath)}`);
    } else stats.indexRemoved++;
    stats.gen++;
  }
  console.log(`[${mode}] 反向(--to-ktool) 根目录: ${root}`);
  console.log(`[${mode}] 回收站: ${trashDir}`);
  console.log(`[${mode}] 计划/执行：生成 post.json+正文+外链 ${stats.gen} 帖 / 附件收子目录 ${stats.moved} / 回收索引 ${stats.indexRemoved}`);
  for (const line of planLines.slice(0, 500)) console.log(line);
  if (planLines.length > 500) console.log(`  ... 共 ${planLines.length} 条，已显示前 500`);
  if (flags.dryrun) console.log(`\n[DRYRUN] 仅模拟：未落盘。确认后执行: node migrate.js "${root}" --to-ktool`);
  else { console.log(`\n[MIGRATE] 完成：${stats.gen} 帖 / 附件 ${stats.moved} / 回收索引 ${stats.indexRemoved}（回收站: ${trashDir}）`); cli.log(`[迁移] 反向完成：${stats.gen} 帖 / 附件 ${stats.moved} / 回收索引 ${stats.indexRemoved}`); }
}

// 根目录校验
if (!fs.existsSync(root)) { console.error(`路径不存在: ${root}`); process.exit(2); }
if (flags.toKtool) runReverse(); else runMigration();