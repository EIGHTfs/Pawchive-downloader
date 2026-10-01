// 下载进度条模块（TTY 实时渲染）——从 cli.js 抽出独立文件（自包含零依赖，签名与原来一致）
// 样式（--progress / PAWCHIVE_PROGRESS）：single 单行汇总 / multi 多行每任务一行（默认）/ ipull 模仿 ipull fancy（图标+列对齐）
// 用法：const { createProgressTracker, fmtSpeed } = require('./progress.js');

const fmtBytes = n => n == null ? '0B'
  : n < 1024 ? `${n}B`
  : n < 1048576 ? `${(n / 1024).toFixed(1)}KB`
  : n < 1073741824 ? `${(n / 1048576).toFixed(1)}MB`
  : `${(n / 1073741824).toFixed(2)}GB`;
const fmtSpeed = n => (n == null || isNaN(n) ? '?/s' : `${fmtBytes(n)}/s`);

/** 图形进度条（绿=完成 灰=待下载；宽度 barW） */
function barOf(pct, barW) {
  const filled = Math.round((Math.min(100, pct || 0) / 100) * barW);
  return `\x1b[32m${'█'.repeat(filled)}\x1b[90m${'░'.repeat(Math.max(0, barW - filled))}\x1b[0m`;
}

/** 输出多行/单行（ANSI 上移重绘不互相覆盖）；更新 state.prevLen/prevLines */
function emitLines(state, lines, single = false) {
  const out = lines.join('\r\n') + '\r';
  const pad = ' '.repeat(Math.max(0, state.prevLen - out.length));
  if (state.prevLines > 0) process.stdout.write(`\x1b[${state.prevLines}A${single ? '\x1b[K' : ''}`);
  process.stdout.write(out + pad);
  state.prevLen = out.length;
  state.prevLines = lines.length;
}

/** 样式 single：单行汇总（活动文件挤一行——任务少时简洁不占屏；状态对象 state 见 createProgressTracker） */
function renderSingle(state) {
  const { done, pct, totalSpeed } = state.overall();
  const bar = barOf(pct, 18);
  const activeLines = [...state.active.values()].slice(0, 2)
    .map(a => `${String(a.filename || '').slice(0, 26)} ${(a.percent || 0).toFixed(0)}% ${fmtSpeed(a.speed)}`)
    .join(' | ');
  const line = `\r[下载] ${bar} ${done}/${state.totalFiles} ${pct.toFixed(1)}% 新${state.counts.downloaded} 跳${state.counts.existed} 败${state.counts.failed} 总速 ${fmtSpeed(totalSpeed)}  ${activeLines}`;
  emitLines(state, [line], true);
}

/** 样式 multi：多行（每个下载任务一行 + 底部汇总行） */
function renderMulti(state) {
  const { done, pct, totalSpeed } = state.overall();
  const actives = [...state.active.values()];
  const maxRows = 8; // 并发活跃文件最多显示行数（超出省略）
  const barW = 14;
  const lines = [];
  for (const a of actives.slice(0, maxRows)) {
    const p = Math.min(100, a.percent || 0);
    lines.push(` ${String(a.filename || '').slice(0, 34).padEnd(34)} ${barOf(p, barW)} ${String(p.toFixed(0)).padStart(3)}% ${fmtSpeed(a.speed).padStart(10)}`);
  }
  if (actives.length > maxRows) lines.push(` … 另 ${actives.length - maxRows} 个下载中`);
  lines.push(`[下载] ${barOf(pct, 18)} ${done}/${state.totalFiles} ${pct.toFixed(1)}% 新${state.counts.downloaded} 跳${state.counts.existed} 败${state.counts.failed} 总速 ${fmtSpeed(totalSpeed)}`);
  emitLines(state, lines);
}

/** 样式 ipull：模仿 ipull fancy——状态图标（↓下载/→复用）+ 名称/大小/百分比/bar/速度 列对齐 */
function renderIpull(state) {
  const { done, pct, totalSpeed } = state.overall();
  const actives = [...state.active.values()];
  const maxRows = 8;
  const barW = 12;
  const iconOf = a => (a.state === 'copy' || a.state === 'linked') ? '→' : '↓';
  const lines = [];
  for (const a of actives.slice(0, maxRows)) {
    const p = Math.min(100, a.percent || 0);
    const size = a.total ? fmtBytes(a.total) : (a.doneBytes ? fmtBytes(a.doneBytes) : '');
    lines.push(` ${iconOf(a)} ${String(a.filename || '').slice(0, 30).padEnd(30)} ${size.padStart(10)} ${String(p.toFixed(0)).padStart(4)}% ${barOf(p, barW)} ${fmtSpeed(a.speed).padStart(10)}`);
  }
  if (actives.length > maxRows) lines.push(` … 另 ${actives.length - maxRows} 个下载中`);
  lines.push(`[下载] ${barOf(pct, 18)} ${done}/${state.totalFiles} ${pct.toFixed(1)}% 新${state.counts.downloaded} 跳${state.counts.existed} 败${state.counts.failed} 总速 ${fmtSpeed(totalSpeed)}`);
  emitLines(state, lines);
}

/**
 * 创建下载进度跟踪器：文件级进度/计数 + TTY 进度条（200ms 节流；非 TTY 不渲染）。
 * @param {number} totalFiles 本任务预计总文件数（百分比分母）
 * @param {boolean} tty 是否 TTY（isTTY && !NO_COLOR——同 KToolBox plain 判定）
 * 返回 { counts{downloaded,existed,failed}, failedSet, overall, onProgress, onFinish, maybeRender, render, finishLine }
 */
function createProgressTracker(totalFiles, tty) {
  const style = (process.env.PAWCHIVE_PROGRESS || 'multi').toLowerCase(); // --progress / PAWCHIVE_PROGRESS：single/multi/ipull
  const state = {
    style, totalFiles,
    counts: { downloaded: 0, existed: 0, failed: 0 },
    active: new Map(), // savePath -> {filename, doneBytes, total, percent, speed, state}
    failedSet: new Set(),
    lastRender: 0, prevLen: 0, prevLines: 0,
  };
  state.overall = () => {
    const done = state.counts.downloaded + state.counts.existed;
    const pct = totalFiles ? Math.min(100, (done / totalFiles) * 100) : 0;
    const totalSpeed = [...state.active.values()].reduce((s, a) => s + (a.speed || 0), 0); // 总速度=活动求和
    return { done, pct, totalSpeed };
  };

  return {
    counts: state.counts, failedSet: state.failedSet, overall: state.overall,
    /** 文件级进度事件（downloadFile.onProgress 转发） */
    onProgress(p) {
      const key = p.savePath || p.filename;
      state.active.set(key, { ...(state.active.get(key) || {}), ...p });
      if (tty) this.maybeRender();
    },
    /** 文件结束：status = downloaded | existed | failed */
    onFinish(filename, status) {
      state.active.delete(filename);
      if (status === 'downloaded') state.counts.downloaded++;
      else if (status === 'existed') state.counts.existed++;
      else { state.counts.failed++; state.failedSet.add(filename); }
      if (tty) this.render();
    },
    maybeRender() {
      const now = Date.now();
      if (now - state.lastRender >= 200) { state.lastRender = now; this.render(); } // 200ms 节流（同 KToolBox refresh_per_second=10）
    },
    /** TTY 进度条渲染（按样式派发；非 TTY 不调用） */
    render() {
      if (style === 'single') renderSingle(state);
      else if (style === 'ipull') renderIpull(state);
      else renderMulti(state);
    },
    finishLine() {
      if (state.prevLines > 0) process.stdout.write(`\x1b[${state.prevLines}A\x1b[J`); // 清掉整个进度条区域
      state.prevLines = 0;
      process.stdout.write('\n');
    },
  };
}

module.exports = { createProgressTracker, fmtBytes, fmtSpeed };