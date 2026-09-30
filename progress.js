// 下载进度条模块（TTY 单行实时渲染）——从 cli.js 抽出独立文件（自包含零依赖，签名与原来一致）
// 风格：学 KToolBox rich 输出（图形 BarColumn 绿/灰 + 百分比 + 速度列 + 活动文件行）
// 用法：const { createProgressTracker, fmtSpeed } = require('./progress.js');

const fmtBytes = n => n == null ? '0B'
  : n < 1024 ? `${n}B`
  : n < 1048576 ? `${(n / 1024).toFixed(1)}KB`
  : n < 1073741824 ? `${(n / 1048576).toFixed(1)}MB`
  : `${(n / 1073741824).toFixed(2)}GB`;
const fmtSpeed = n => (n == null || isNaN(n) ? '?/s' : `${fmtBytes(n)}/s`);

/**
 * 创建下载进度跟踪器：文件级进度/计数 + TTY 单行进度条（\r 刷新，200ms 节流；非 TTY 不渲染）。
 * @param {number} totalFiles 本任务预计总文件数（百分比分母）
 * @param {boolean} tty 是否 TTY（isTTY && !NO_COLOR——同 KToolBox plain 判定）
 * 返回 { counts{downloaded,existed,failed}, failedSet, overall, onProgress, onFinish, maybeRender, render, finishLine }
 */
function createProgressTracker(totalFiles, tty) {
  const counts = { downloaded: 0, existed: 0, failed: 0 };
  const active = new Map();       // savePath -> {filename, doneBytes, total, percent, speed, state}
  const failedSet = new Set();
  let lastRender = 0;
  let prevLen = 0;

  const overall = () => {
    const done = counts.downloaded + counts.existed;
    const pct = totalFiles ? Math.min(100, (done / totalFiles) * 100) : 0;
    const totalSpeed = [...active.values()].reduce((s, a) => s + (a.speed || 0), 0); // 总速度=活动求和（iwara totalSpeed 同款）
    return { done, pct, totalSpeed };
  };

  return {
    counts, failedSet, overall,
    /** 文件级进度事件（downloadFile.onProgress 转发） */
    onProgress(p) {
      const key = p.savePath || p.filename;
      const prev = active.get(key) || {};
      active.set(key, { ...prev, ...p });
      if (tty) this.maybeRender();
    },
    /** 文件结束：status = downloaded | existed | failed */
    onFinish(filename, status) {
      active.delete(filename);
      if (status === 'downloaded') counts.downloaded++;
      else if (status === 'existed') counts.existed++;
      else { counts.failed++; failedSet.add(filename); }
      if (tty) this.render();
    },
    maybeRender() {
      const now = Date.now();
      if (now - lastRender >= 200) { lastRender = now; this.render(); } // 200ms 节流刷新（同 KToolBox refresh_per_second=10）
    },
    /** TTY 单行实时进度条（\r 刷新，非 TTY 不调用）。图形 BarColumn + 颜色 + 速度列 */
    render() {
      const { done, pct, totalSpeed } = overall();
      const barW = 18;
      const filled = Math.round((pct / 100) * barW);
      const bar = `\x1b[32m${'█'.repeat(filled)}\x1b[90m${'░'.repeat(barW - filled)}\x1b[0m`; // 绿=完成 灰=待下载（rich BarColumn 同款）
      const activeLines = [...active.values()].slice(0, 2)
        .map(a => `${String(a.filename || '').slice(0, 26)} ${(a.percent || 0).toFixed(0)}% ${fmtSpeed(a.speed)}`)
        .join(' | ');
      const line = `\r[下载] ${bar} ${done}/${totalFiles} ${pct.toFixed(1)}% 新${counts.downloaded} 跳${counts.existed} 败${counts.failed} 总速 ${fmtSpeed(totalSpeed)}  ${activeLines}`;
      const pad = ' '.repeat(Math.max(0, prevLen - line.length));
      process.stdout.write(line + pad + '\r');
      prevLen = line.length;
    },
    finishLine() { process.stdout.write('\n'); }, // 结束进度条行
  };
}

module.exports = { createProgressTracker, fmtBytes, fmtSpeed };
