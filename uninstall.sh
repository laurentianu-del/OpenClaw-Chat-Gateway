#!/bin/bash
set -e

# Configuration
INSTALL_DIR="$HOME/OpenClaw-Chat-Gateway"
SERVICE_NAME="clawui.service"
SERVICE_PATH="$HOME/.config/systemd/user/$SERVICE_NAME"

# Terminal Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 探测安装目录和数据目录
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICES=$(ls $SERVICE_DIR/clawui-*.service 2>/dev/null || true)
if [ -f "$SERVICE_DIR/clawui.service" ]; then
    SERVICES="$SERVICES $SERVICE_DIR/clawui.service"
fi

DETECTED_DIRS=""
for S_PATH in $SERVICES; do
    W_DIR=$(grep "^WorkingDirectory=" "$S_PATH" | cut -d'=' -f2 | sed 's/ /\\ /g')
    # 处理后端目录，通常安装在父目录
    P_DIR=$(dirname "$W_DIR")
    if [ -d "$P_DIR" ]; then
        DETECTED_DIRS="$DETECTED_DIRS $P_DIR"
    fi
done

# 如果通过当前目录运行，也加入探测
if [ -f "./uninstall.sh" ]; then
    DETECTED_DIRS="$DETECTED_DIRS $(pwd)"
fi

# 去重并格式化
CLEAN_DIRS=$(echo "$DETECTED_DIRS $INSTALL_DIR" | tr ' ' '\n' | sort -u | grep -v "^$" || true)

# 确认卸载
echo -e "${RED}警告: 这将停止所有相关服务并删除以下目录中的所有内容:${NC}"
for d in $CLEAN_DIRS; do
    echo -e " - $d (项目文件)"
done
echo -e " - $HOME/.openclaw (工作区及配置)"
echo -e " - $HOME/.clawui (数据库及运行时数据)"
[ -d "$HOME/.clawui_release" ] && echo -e " - ~/.clawui_release (旧版数据)"
echo ""

# 使用 /dev/tty 确保在管道模式下也能输入
read -p "您确定要彻底卸载并删除所有数据吗? (y/N) " confirm < /dev/tty

if [[ ! $confirm =~ ^[Yy]$ ]]; then
    echo "卸载已取消。"
    exit 0
fi

# 停止并移除服务
echo -e "\n${BLUE}步骤 1: 正在停止并移除系统服务...${NC}"
for S_PATH in $SERVICES; do
    S_FILE=$(basename "$S_PATH")
    echo "正在停止服务: $S_FILE"
    systemctl --user stop "$S_FILE" 2>/dev/null || true
    systemctl --user disable "$S_FILE" 2>/dev/null || true
    rm "$S_PATH"
done
systemctl --user daemon-reload

# 移除数据和日志
echo -e "\n${BLUE}步骤 2: 正在清理所有数据和设置...${NC}"
rm -rf "$HOME/.openclaw"
rm -rf "$HOME/.clawui"
rm -rf "$HOME/.clawui_release"
[ -d "$HOME/.clawui_dev" ] && rm -rf "$HOME/.clawui_dev"
echo "已删除数据目录: ~/.openclaw, ~/.clawui"

# 移除项目文件
echo -e "\n${BLUE}步骤 3: 正在移除项目文件...${NC}"
for d in $CLEAN_DIRS; do
    if [ -d "$d" ]; then
        rm -rf "$d"
        echo "已删除项目目录: $d"
    fi
done

echo -e "\n${GREEN}================================================${NC}"
echo -e "${GREEN}   卸载完成！                                   ${NC}"
echo -e "${GREEN}================================================${NC}"
