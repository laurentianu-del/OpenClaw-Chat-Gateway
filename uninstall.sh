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

echo -e "${RED}================================================${NC}"
echo -e "${RED}   OpenClaw Chat Gateway - 卸载脚本            ${NC}"
echo -e "${RED}================================================${NC}"

# 检测运行环境（是从安装目录运行还是通过 curl 运行）
if [ -f "./uninstall.sh" ]; then
    PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
else
    PROJECT_ROOT="$INSTALL_DIR"
fi

# 确认卸载
echo -e "${RED}警告: 这将停止服务并删除以下目录中的所有数据:${NC}"
echo -e " - $PROJECT_ROOT"
[ -d "$HOME/.clawui_release" ] && echo -e " - ~/.clawui_release"
echo ""

# 使用 /dev/tty 确保在管道模式下也能输入
read -p "您确定要继续吗? (y/N) " confirm < /dev/tty

if [[ ! $confirm =~ ^[Yy]$ ]]; then
    echo "卸载已取消。"
    exit 0
fi

# 停止并移除服务
echo -e "\n${BLUE}步骤 1: 正在停止并移除系统服务...${NC}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICES=$(ls $SERVICE_DIR/clawui-*.service 2>/dev/null || true)

# 处理旧版服务名
if [ -f "$SERVICE_DIR/clawui.service" ]; then
    SERVICES="$SERVICES $SERVICE_DIR/clawui.service"
fi

for SERVICE_PATH in $SERVICES; do
    SERVICE_FILE=$(basename "$SERVICE_PATH")
    echo "正在移除服务: $SERVICE_FILE"
    systemctl --user stop "$SERVICE_FILE" 2>/dev/null || true
    systemctl --user disable "$SERVICE_FILE" 2>/dev/null || true
    rm "$SERVICE_PATH"
done

systemctl --user daemon-reload

# 移除数据和日志
echo -e "\n${BLUE}步骤 2: 正在清理所有数据和设置...${NC}"
rm -rf "$HOME/.clawui_release"
# 仅当开发数据目录存在时才删除
[ -d "$HOME/.clawui_dev" ] && rm -rf "$HOME/.clawui_dev"
echo "已删除数据目录: ~/.clawui_release"

# 移除项目文件
echo -e "\n${BLUE}步骤 3: 正在移除项目文件...${NC}"
if [ -d "$PROJECT_ROOT" ]; then
    rm -rf "$PROJECT_ROOT"
    echo "已删除项目目录: $PROJECT_ROOT"
else
    echo "未找到项目目录 $PROJECT_ROOT，跳过。"
fi

echo -e "\n${GREEN}================================================${NC}"
echo -e "${GREEN}   卸载完成！                                   ${NC}"
echo -e "${GREEN}================================================${NC}"
