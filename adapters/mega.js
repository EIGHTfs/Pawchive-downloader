'use strict';
/**
 * MEGA 公开分享链接下载能力（零依赖：node:https / node:crypto）
 *
 * 背景：部分网络对 `mega.nz` 只做 TLS SNI 阻断（带该关键词的 ClientHello 被 RST），
 * IP 层与 TCP 均可达，且 MEGA 服务器不校验 SNI。因此本模块统一采用
 * 「连接真实 IP + Host 头写真实域名 + SNI 用 IP」的方式通信，不依赖任何代理或中转。
 *
 * MEGA 协议要点（公开分享链接）：
 *  1. 链接形如 https://mega.nz/file/<HANDLE>#<KEY_B64>，KEY_B64 解出 32 字节
 *  2. 文件密钥 = 前 16 字节与后 16 字节逐字节异或：k[i] = b[i] ^ b[i+16]
 *  3. CTR 初始值（IV）= b[16..24] 共 8 字节 + 8 字节零；每 16 字节密文对应一个 counter++
 *  4. 下载：POST /cs 到 g.api.mega.co.nz 取 {s 大小, g 加密下载地址, ip 下载服务器 IP}
 *     下载地址是 http，但明文 HTTP 的 Host 头含 mega.co.nz 会被关键词阻断 → 改用 https + IP
 *  5. 加密数据支持 Range，可按 16 字节对齐做断点续传与分块解密
 */

const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MEGA_API_HOST = 'g.api.mega.co.nz';
const MEGA_DOH_URL = process.env.PAWCHIVE_MEGA_DOH || 'https://doh.pub/dns-query'; // 系统 DNS 对 mega.nz 被污染，走 DoH 取真实 IP
const MEGA_CHUNK_BYTES = 32 * 1024 * 1024; // 单次 Range 请求的密文块大小（与 MEGA 官方客户端一致量级）
const HTTP_TIMEOUT_MS = Number(process.env.PAWCHIVE_MEGA_TIMEOUT_MS) || 60000;

/** 带 IP 直连 + Host 头的 https 请求（SNI 用 IP，规避对 mega.nz 的 SNI 阻断） */
function requestViaIp({ ip, host, method = 'GET', pathname = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip,
      port: 443,
      method,
      path: pathname,
      servername: ip, // 关键：SNI 必须是 IP；写域名会被阻断
      rejectUnauthorized: false, // 证书 CN 为真实域名，与 IP 不匹配，跳过校验（IP 由 DoH 取得）
      headers: { Host: host, ...headers },
      timeout: HTTP_TIMEOUT_MS,
    }, res => resolve(res));
    req.on('timeout', () => { req.destroy(new Error(`请求超时 ${ip}${pathname}`)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 读取整个响应体（小响应：DoH / API / 错误页） */
async function readAll(res) {
  const parts = [];
  for await (const chunk of res) parts.push(chunk);
  return Buffer.concat(parts);
}

/** DoH 查 A 记录（返回 IP 数组，按返回顺序） */
async function dohResolveA(hostname) {
  const url = `${MEGA_DOH_URL}?name=${encodeURIComponent(hostname)}&type=A`;
  const res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`DoH 查询失败 HTTP ${res.status}（${hostname}）`);
  const json = await res.json();
  const answers = (json && json.Answer) || [];
  const ips = answers.filter(a => a.type === 1).map(a => a.data);
  // CNAME 链：DoH 可能先给 CNAME，再给最终 A —— 若没 A 记录，按 CNAME 目标再查一次
  if (!ips.length) {
    const cname = answers.find(a => a.type === 5);
    if (cname) return dohResolveA(String(cname.data).replace(/\.$/, ''));
  }
  return ips;
}

let apiIpCache = null;
/** 取 MEGA API 可用 IP（缓存；多 IP 轮换） */
async function megaApiIps() {
  if (apiIpCache && apiIpCache.length) return apiIpCache;
  const ips = await dohResolveA(MEGA_API_HOST);
  if (!ips.length) throw new Error(`无法解析 ${MEGA_API_HOST}（DoH 未返回 A 记录）`);
  apiIpCache = ips;
  return ips;
}

/** 解析 MEGA 分享链接 → {handle, keyB64}；非 MEGA 链接返回 null */
function parseMegaLink(url) {
  const m = /mega\.(?:nz|io)\/(?:file|embed)\/([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)/.exec(String(url || ''));
  if (!m) return null;
  return { handle: m[1], keyB64: m[2] };
}

/** keyB64 → {key: 16 字节 AES key, iv: 16 字节 CTR 初始值} */
function deriveMegaKey(keyB64) {
  const bytes = Buffer.from(String(keyB64).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length !== 32) throw new Error(`MEGA 链接密钥长度异常（${bytes.length} 字节，应为 32）`);
  const key = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) key[i] = bytes[i] ^ bytes[i + 16];
  const iv = Buffer.alloc(16);
  bytes.copy(iv, 0, 16, 24); // 前 8 字节 nonce，后 8 字节为 0（counter 起始）
  return { key, iv };
}

/** 调 MEGA API 取文件信息：{size, downloadUrl, storageIp, attrB64} */
async function megaFileInfo(handle, { apiIps = null } = {}) {
  const ips = apiIps || await megaApiIps();
  const seq = crypto.randomInt(1, 2147483647);
  const bodyText = JSON.stringify([{ a: 'g', g: 1, p: handle }]);
  let lastErr = null;
  for (const ip of ips) {
    try {
      const res = await requestViaIp({
        ip, host: MEGA_API_HOST, method: 'POST', pathname: `/cs?id=${seq}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText) },
        body: bodyText,
      });
      const text = (await readAll(res)).toString('utf8');
      if (res.statusCode !== 200) throw new Error(`MEGA API HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
      const data = JSON.parse(text);
      const item = Array.isArray(data) ? data[0] : data;
      if (typeof item === 'number') throw new Error(`MEGA API 错误码 ${item}（链接可能已失效/被删除/被下架）`);
      if (!item || !item.g) throw new Error('MEGA API 未返回下载地址');
      return { size: Number(item.s) || 0, downloadUrl: item.g, storageIp: (item.ip && item.ip[0]) || null, attrB64: item.at || null };
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('MEGA API 全部 IP 均失败');
}

/** 由下载地址解析出 {hostname, pathname}（MEGA 返回的是 http，这里统一升级为 https 走 IP） */
function parseDownloadUrl(downloadUrl) {
  const u = new URL(downloadUrl);
  return { hostname: u.hostname, pathname: u.pathname + (u.search || '') };
}

/** 按偏移构造 CTR IV：nonce(8B) + counter(pos/16, 大端 8B) */
function ctrIvAt(baseIv, pos) {
  const iv = Buffer.alloc(16);
  baseIv.copy(iv, 0, 0, 8);
  iv.writeBigUInt64BE(BigInt(Math.floor(pos / 16)), 8);
  return iv;
}

/**
 * 下载 MEGA 文件（分块 Range + 流式 AES-CTR 解密 + 断点续传）。
 * @param {string} shareUrl  MEGA 分享链接
 * @param {string} destPath  最终落盘路径
 * @param {{ tmpPath?: string, onProgress?: Function, expectedName?: string }} opts
 * @returns {Promise<{size:number, name:string, storageIp:string}>}
 */
async function downloadMegaFile(shareUrl, destPath, opts = {}) {
  const parsed = parseMegaLink(shareUrl);
  if (!parsed) throw new Error(`不是有效的 MEGA 分享链接: ${shareUrl}`);
  const { key, iv } = deriveMegaKey(parsed.keyB64);
  const info = await megaFileInfo(parsed.handle);
  const { hostname, pathname } = parseDownloadUrl(info.downloadUrl);
  const storageIp = info.storageIp || (await dohResolveA(hostname))[0];
  if (!storageIp) throw new Error(`无法确定 MEGA 下载服务器 IP（${hostname}）`);

  const tmpPath = opts.tmpPath || `${destPath}.part`;
  await fsp.mkdir(path.dirname(tmpPath), { recursive: true });

  // 断点续传：tmp 里是已解密字节数；起点必须 16 字节对齐（CTR 只能按块边界续解）
  let already = 0;
  try { already = (await fsp.stat(tmpPath)).size; } catch { already = 0; }
  if (already > info.size) { await fsp.rm(tmpPath, { force: true }).catch(() => {}); already = 0; }
  const alignedStart = Math.floor(already / 16) * 16; // 回退到块边界，多出的尾部字节丢弃后重写
  if (alignedStart !== already) await fsp.truncate(tmpPath, alignedStart).catch(() => { already = 0; });

  const fd = await fsp.open(tmpPath, already > 0 ? 'r+' : 'w');
  let written = alignedStart;
  try {
    while (written < info.size) {
      const rangeStart = written;
      const rangeEnd = Math.min(written + MEGA_CHUNK_BYTES - 1, info.size - 1);
      const res = await requestViaIp({
        ip: storageIp, host: hostname, method: 'GET', pathname,
        headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
      });
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        throw new Error(`MEGA 存储节点 HTTP ${res.statusCode}（${hostname} @ ${storageIp}）`);
      }
      const decipher = crypto.createDecipheriv('aes-128-ctr', key, ctrIvAt(iv, rangeStart));
      let chunkBytes = 0;
      for await (const encrypted of res) {
        const plain = decipher.update(encrypted);
        if (!plain.length) continue;
        await fd.write(plain, 0, plain.length, written);
        written += plain.length;
        chunkBytes += plain.length;
        if (opts.onProgress) opts.onProgress(written, info.size);
      }
      if (chunkBytes === 0) throw new Error('MEGA 存储节点返回空数据（连接被中断）');
    }
  } finally {
    await fd.close().catch(() => {});
  }

  if (written !== info.size) throw new Error(`MEGA 下载大小不符：落盘 ${written} / 期望 ${info.size}`);
  await fsp.rename(tmpPath, destPath);
  return { size: info.size, name: opts.expectedName || path.basename(destPath), storageIp };
}

/** 供调用方判断某 URL 是否 MEGA 分享链接 */
const isMegaLink = url => Boolean(parseMegaLink(url));

module.exports = {
  MEGA_API_HOST,
  parseMegaLink,
  deriveMegaKey,
  megaFileInfo,
  downloadMegaFile,
  dohResolveA,
  isMegaLink,
  ctrIvAt,
};
