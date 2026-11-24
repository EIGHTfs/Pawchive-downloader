#!/bin/sh
# 作者同步续跑循环：反复执行同一作者的完整同步，直到没有残留的网盘临时文件为止。
#
# 适用场景：网盘（MEGA/Drive 等）大文件下载常因远端连接中断（curl exit 18/28）而中断，
# 单轮重试次数用尽后本轮放弃该文件。本脚本负责"再跑一轮"，靠断点续传逐步推进，
# 无需人工盯着重启。
#
# 用法：
#   ./run-sync-loop.sh <URL> [最大轮数] [数据根]
#   例：./run-sync-loop.sh "https://pawchive.pw/patreon/user/144324955"
#       ./run-sync-loop.sh "https://pawchive.pw/patreon/user/144324955" 20
#       ./run-sync-loop.sh "fanbox/user/107514250" 20 "/volume10/Resource/(Pawchive)/Pawchive"
#
# 参数：
#   URL        必填，作者页/作品页地址（也支持相对路径，由 cli 自行补全）
#   最大轮数   可选，默认 12
#   数据根     可选，默认读项目 .env 的 PAWCHIVE_DATA_ROOT
#
# 退出条件：某轮结束后数据根下已无未完成的网盘临时文件（视为全部完成），或达到最大轮数。
set -u

URL="${1:-}"
MAX_ROUNDS="${2:-12}"
DATA_ROOT="${3:-}"

if [ -z "$URL" ]; then
  echo "用法: $0 <URL> [最大轮数] [数据根]" >&2
  exit 2
fi

# 定位项目根：脚本允许放在项目根或 scripts/ 子目录
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR="$SCRIPT_DIR"
if [ ! -f "$PROJECT_DIR/cli.js" ]; then
  PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
fi
if [ ! -f "$PROJECT_DIR/cli.js" ]; then
  echo "找不到 cli.js：请把脚本放在项目根或项目的 scripts/ 目录下" >&2
  exit 2
fi

# node 未必在非交互 shell 的 PATH 里（部分 NAS 发行版如此），补齐常见路径
case ":$PATH:" in
  *:/usr/local/bin:*) : ;;
  *) PATH="/usr/local/bin:$PATH"; export PATH ;;
esac
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node：请确认已安装 Node.js 并可从 PATH 调用" >&2
  exit 2
fi

# 数据根：参数优先，其次读 .env
if [ -z "$DATA_ROOT" ] && [ -f "$PROJECT_DIR/.env" ]; then
  DATA_ROOT=$(grep -E '^PAWCHIVE_DATA_ROOT=' "$PROJECT_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2-)
fi
if [ -z "$DATA_ROOT" ]; then
  echo "缺少数据根：请传第 3 个参数，或在 .env 里设置 PAWCHIVE_DATA_ROOT" >&2
  exit 2
fi
if [ ! -d "$DATA_ROOT" ]; then
  echo "数据根目录不存在: $DATA_ROOT" >&2
  exit 2
fi

# 临时文件后缀跟随配置（默认 .tmp）
TEMP_SUFFIX=".tmp"
if [ -f "$PROJECT_DIR/.env" ]; then
  CONF_SUFFIX=$(grep -E '^PAWCHIVE_TEMP_SUFFIX=' "$PROJECT_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2-)
  [ -n "$CONF_SUFFIX" ] && TEMP_SUFFIX="$CONF_SUFFIX"
fi

cd "$PROJECT_DIR" || exit 1
echo "目标地址: $URL"
echo "数据根:   $DATA_ROOT"
echo "最大轮数: $MAX_ROUNDS"
echo "临时后缀: $TEMP_SUFFIX"

round=1
while [ "$round" -le "$MAX_ROUNDS" ]; do
  echo "===== 第 ${round}/${MAX_ROUNDS} 轮 $(date '+%F %T') ====="
  node cli.js "$URL"
  # 未完成的网盘下载会留下 netdisk_*<临时后缀>，据此判断是否还要继续
  left=$(find "$DATA_ROOT" -name "netdisk_*${TEMP_SUFFIX}" 2>/dev/null | wc -l | tr -d ' ')
  echo "--- 第 ${round} 轮结束：数据根下未完成的网盘临时文件 ${left} 个"
  if [ "$left" -eq 0 ]; then
    echo "全部网盘文件已完成，停止续跑"
    echo "===== 循环结束 $(date '+%F %T') ====="
    exit 0
  fi
  round=$((round + 1))
  if [ "$round" -le "$MAX_ROUNDS" ]; then
    sleep 15
  fi
done

left=$(find "$DATA_ROOT" -name "netdisk_*${TEMP_SUFFIX}" 2>/dev/null | wc -l | tr -d ' ')
echo "===== 已达最大轮数 ${MAX_ROUNDS}，仍有 ${left} 个未完成网盘临时文件 $(date '+%F %T') ====="
echo "可加大轮数后重跑本脚本，断点会继续沿用"
exit 1
