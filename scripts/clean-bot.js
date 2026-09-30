#!/usr/bin/env node
/**
 * 反爬错误文件清理脚本（独立运行，零依赖 Node；复用 cli.js 的日志）
 *
 * 背景：全量高频下载会触发 File host 反爬，返回 376B 文本占位
 *   （"Are you a bot or using download tools? Please show respect..."），
 *   HTTP 200 + curl exit 0 → 曾被当作成功文件落盘。
 *
 * 判定：文件大小 < 4096 字节，且头部内容含 bot 特征文本 → 反爬垃圾
 * 处理：rename 进回收站（可恢复，绝不 rm）；--dryrun 只列计划
 *
 * 用法：
 *   node clean-bot.js <path> [--dryrun] [--trash <回收目录>]
 *   例：
 *     node clean-bot.js "/volume1/VirtualDSM/(Pawchive)/Pawchive" --dryrun
 *     node clean-bot.js "/volume1/VirtualDSM/(Pawchive)/Pawchive"
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cli = require('./cli.js');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const flags = { dryrun: false, trash: null };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dryrun') flags.dryrun = true;
  else if (a === '--trash') flags.trash = args[++i];
  else if (a.startsWith('-')) { console.error(`未知参数: ${a}`); process.exit(2); }
  else positional.push(a);
}
if (positional.length < 1) {
  console.error('用法: node clean-bot.js <path> [--dryrun] [--trash <回收目录>]');
  process.exit(2);
}
const root = positional[0];
const mode = flags.dryrun ? 'DRYRUN' : 'CLEAN';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const trashDir = flags.trash || path.join(root, '.trash', `clean-bot-${ts}`);
if (!fs.existsSync(root)) { console.error(`路径不存在: ${root}`); process.exit(2); }

// bot 占位特征（实测内容："Are you a bot or using download tools? Please show respect and u..."）
const BOT_MARKS = ['Are you a bot', 'using download tools', 'show respect', 'download tools?'];
const MAX_BOT_SIZE = 4096; // 低于此大小的才检查内容（真文件几乎都更大）

/** 判断文件是否为反爬占位垃圾 */
function isBotFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile() || st.size >= MAX_BOT_SIZE || st.size === 0) return false;
  let head;
  try { head = fs.readFileSync(file, 'utf8').slice(0, 256); } catch { return false; }
  return BOT_MARKS.some(m => head.includes(m));
}

// ---------- 扫描 ----------
function collect(rootDir) {
  const botFiles = [];
  function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === '.pawchive' || e.name === '.trash' || e.name === '.git') continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (isBotFile(f)) botFiles.push(f);
    }
  }
  walk(rootDir);
  return botFiles;
}

// ---------- 执行 ----------
const botFiles = collect(root);
console.log(`[${mode}] 根目录: ${root}`);
console.log(`[${mode}] 发现反爬垃圾文件: ${botFiles.length}`);
cli.log(`[清理] ${flags.dryrun ? '模拟' : '执行'} 开始：发现反爬垃圾 ${botFiles.length} 个（范围 ${root}）`);
for (const f of botFiles.slice(0, 100)) console.log(`  ${path.relative(root, f)}（${fs.statSync(f).size}B）`);
if (botFiles.length > 100) console.log(`  ... 共 ${botFiles.length} 个，已显示前 100`);

if (!flags.dryrun && botFiles.length) {
  let moved = 0;
  for (const f of botFiles) {
    const t = path.join(trashDir, f.replace(root + '/', '').replace(/\//g, '__'));
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.renameSync(f, t);
    moved++;
    cli.log(`[清理] 回收反爬垃圾 ${path.relative(root, f)}`);
  }
  console.log(`\n[CLEAN] 完成：已回收 ${moved} 个反爬垃圾文件 → ${trashDir}`);
  cli.log(`[清理] 完成：回收 ${moved} 个反爬垃圾文件（回收站 ${trashDir}）`);
} else if (botFiles.length) {
  console.log(`\n[DRYRUN] 仅模拟：未执行。确认后运行: node clean-bot.js "${root}"`);
} else {
  console.log(`\n[${mode}] 无需清理：未发现反爬垃圾文件（会顺带扫出其它 <4KB 含 bot 特征的文件）`);
}