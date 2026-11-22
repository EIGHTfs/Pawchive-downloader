#!/usr/bin/env node
'use strict';
/**
 * MEGA 下载能力冒烟测试（零依赖）
 *
 * 用途：验证 adapters/mega.js 的「DoH 取 IP → API 换直链 → IP 直连 + Host 头 → AES-CTR 解密」
 * 全链路正确。判定标准不是"没报错"，而是下载出的文件能被真实解包工具识别（证明解密后的字节正确）。
 *
 * 用法：
 *   node test/mega-smoke.js <含 mega 链接的目录> [--pick smallest|largest|first] [--max-mb 200]
 *   node test/mega-smoke.js --url "https://mega.nz/file/<HANDLE>#<KEY>"
 *
 * 退出码：0 全部校验通过；1 失败。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const mega = require('../adapters/mega.js');

const MEGA_LINK_RE = /https:\/\/mega\.nz\/(?:file|folder)\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+/g;

function collectMegaLinks(rootDir) {
  const links = new Set();
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== '.pawchive' && ent.name !== '.trash') walk(full); continue; }
      if (!ent.name.toLowerCase().endsWith('.txt')) continue;
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (text.length > 4096) continue; // .txt 里通常是单行链接，超大文件不是链接清单
      for (const link of text.match(MEGA_LINK_RE) || []) links.add(link);
    }
  };
  walk(rootDir);
  return [...links];
}

/** 用系统工具识别文件类型（能解包/识别则说明解密正确） */
function verifyFileType(filePath) {
  const probes = [
    ['7z', ['l', filePath], /^(7-Zip|Rar|PK)/m],
    ['unrar', ['l', filePath], /RAR|Details: RAR/],
    ['file', [filePath], /archive|Zip|RAR|7-zip|image|video|PDF|ASCII|UTF-8|data/i],
  ];
  for (const [bin, args, okRe] of probes) {
    try {
      const out = execFileSync(bin, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (okRe.test(out)) return { bin, ok: true, sample: out.split('\n').slice(0, 2).join(' | ') };
    } catch { /* 该工具不可用或识别失败，继续下一个 */ }
  }
  // 兜底：看魔数
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  const hex = head.toString('hex');
  const known = {
    '504b0304': 'ZIP', '526172211a0701': 'RAR5', '526172211a0700': 'RAR4',
    '377abcaf271c': '7z', '1f8b08': 'gzip', '424d': 'BMP', 'ffd8ff': 'JPEG',
    '89504e47': 'PNG', '47494638': 'GIF',
  };
  for (const [magic, label] of Object.entries(known)) if (hex.startsWith(magic)) return { bin: 'magic', ok: true, sample: `魔数 ${label}` };
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') return { bin: 'magic', ok: true, sample: '魔数 MP4/MOV' };
  return { bin: 'none', ok: false, sample: `头部 hex=${hex}` };
}

(async () => {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  const maxMbIdx = args.indexOf('--max-mb');
  const maxMb = maxMbIdx >= 0 ? Number(args[maxMbIdx + 1]) : 200;
  const pickIdx = args.indexOf('--pick');
  const pick = pickIdx >= 0 ? args[pickIdx + 1] : 'smallest';

  let links = [];
  if (urlIdx >= 0) links = [args[urlIdx + 1]];
  else {
    const rootDir = args[0];
    if (!rootDir) { console.error('用法: node test/mega-smoke.js <含 mega 链接的目录> [--pick smallest] [--max-mb 200]'); process.exit(2); }
    links = collectMegaLinks(rootDir);
  }
  if (!links.length) { console.error('未找到 MEGA 链接'); process.exit(1); }
  console.log(`[冒烟] 发现 ${links.length} 个 MEGA 链接`);

  // 查每个链接的大小，按 pick 策略挑一个
  const infos = [];
  for (const link of links.slice(0, 20)) {
    try {
      const parsed = mega.parseMegaLink(link);
      const info = await mega.megaFileInfo(parsed.handle);
      infos.push({ link, handle: parsed.handle, size: info.size });
      console.log(`  ${parsed.handle}  ${(info.size / 1048576).toFixed(1)} MB`);
    } catch (err) {
      console.log(`  ${link.slice(0, 60)}...  查询失败: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300)); // 别连着打 API
  }
  if (!infos.length) { console.error('所有链接都查询失败'); process.exit(1); }

  const candidates = infos.filter(i => i.size > 0 && i.size <= maxMb * 1048576);
  const pool = candidates.length ? candidates : infos;
  pool.sort((a, b) => pick === 'largest' ? b.size - a.size : a.size - b.size);
  const target = pool[0];
  console.log(`\n[冒烟] 选中 ${target.handle}（${(target.size / 1048576).toFixed(2)} MB）开始完整下载`);

  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mega-smoke-'));
  const destPath = path.join(outDir, `${target.handle}.bin`);
  const started = Date.now();
  let lastLog = 0;
  const result = await mega.downloadMegaFile(target.link, destPath, {
    onProgress: (done, total) => {
      const now = Date.now();
      if (now - lastLog < 1000) return;
      lastLog = now;
      const pct = total ? ((done / total) * 100).toFixed(1) : '?';
      console.log(`  ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB  ${pct}%`);
    },
  });
  const costSec = ((Date.now() - started) / 1000).toFixed(1);
  const stat = await fsp.stat(destPath);
  console.log(`\n[冒烟] 下载完成: ${(stat.size / 1048576).toFixed(2)} MB / 用时 ${costSec}s / 存储节点 ${result.storageIp}`);

  if (stat.size !== target.size) {
    console.error(`[冒烟] 失败：落盘 ${stat.size} != API 声明 ${target.size}`);
    process.exit(1);
  }
  const verdict = verifyFileType(destPath);
  console.log(`[冒烟] 内容识别: ${verdict.bin} → ${verdict.sample}`);
  if (!verdict.ok) {
    console.error('[冒烟] 失败：解密后的内容无法被识别为有效文件（解密可能不正确）');
    console.error(`[冒烟] 样本保留在 ${destPath} 供排查`);
    process.exit(1);
  }
  await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  console.log('[冒烟] 通过：大小一致 + 内容可识别');
})().catch(err => { console.error('[冒烟] 异常:', err && err.stack || err); process.exit(1); });
