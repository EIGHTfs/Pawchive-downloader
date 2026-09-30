#!/usr/bin/env node
/**
 * scripts/update-check.js —— 自动更新检查（转写原项目 KToolBox utils.py check_for_updates——零依赖 Node fetch）
 *
 * 逻辑（对齐原版）：先查 GitHub latest release（tag_name 对比）→ 失败 fallback PyPI JSON（info.version）→
 * 5s 超时、异常静默降级；版本不等 → 提示更新（版本 + URL）；相等 → 已最新。
 * 用法：node scripts/update-check.js [--repo owner/repo] [--pkg 包名] [--version 本地版本]
 *   默认：--repo Ljzd-PRO/KToolBox --pkg ktoolbox（版本不传则只报告远端最新）
 */
'use strict';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const REPO = arg('--repo') || 'Ljzd-PRO/KToolBox';
const PKG = arg('--pkg') || 'ktoolbox';
const CURRENT = (arg('--version') || '').replace(/^v/, '');

/** GitHub latest release（5s 超时；非 200/异常 → null 走 PyPI fallback） */
async function githubLatest() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    signal: AbortSignal.timeout(5000),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pawchive-update-check' },
  });
  if (!r.ok) return null;
  const d = await r.json();
  return { version: String(d.tag_name || '').replace(/^v/, ''), url: d.html_url || '' };
}

/** PyPI fallback（包最新版；5s 超时） */
async function pypiLatest() {
  const r = await fetch(`https://pypi.org/pypi/${PKG}/json`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) return null;
  const d = await r.json();
  return { version: String((d.info && d.info.version) || '').replace(/^v/, ''), url: `https://pypi.org/project/${PKG}/` };
}

/** 语义化版本比较（主.次.补丁[.bN]——改进上游只 != 的误报：1.0.0 vs 1.1.0b1 本地更高不报更新） */
function compareVersions(a, b) {
  const num = v => (v.match(/\d+/g) || []).slice(0, 3).map(Number);
  const pre = v => (/[a-z]+\d*$/i.test(v) ? 0 : 1); // 带 pre 后缀（b/rc/alpha）比正式版低
  const A = num(a), B = num(b);
  for (let i = 0; i < 3; i++) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0) ? 1 : -1; }
  return pre(a) - pre(b);
}

(async () => {
  const fromGh = await githubLatest().catch(() => null);
  const src = fromGh || await pypiLatest().catch(() => null);
  if (!src || !src.version) { console.log('更新检查失败（网络或源不可达——静默降级）'); process.exit(2); }
  if (!CURRENT) { console.log(`远端最新：${src.version}\n${src.url}`); return; }
  const cmp = compareVersions(src.version, CURRENT);
  if (cmp > 0) console.log(`有新版本：${src.version}（当前 ${CURRENT}）\n${src.url}`);
  else if (cmp === 0) console.log(`已是最新版本（${CURRENT}）`);
  else console.log(`当前版本高于远端（本地 ${CURRENT} > 远端 ${src.version}）`);
})();
