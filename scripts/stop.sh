#!/bin/bash

# 9Router 停止脚本

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 默认端口
PORT=${1:-20128}

# 查找并关闭进程
PIDS=$(lsof -ti :$PORT 2>/dev/null)

if [ -z "$PIDS" ]; then
    log_info "端口 $PORT 没有运行的服务"
    exit 0
fi

log_info "正在关闭端口 $PORT 上的服务..."

for PID in $PIDS; do
    kill $PID 2>/dev/null
    if [ $? -eq 0 ]; then
        log_info "已关闭进程 $PID"
    else
        log_error "无法关闭进程 $PID"
    fi
done

echo ""
log_info "服务已停止"
