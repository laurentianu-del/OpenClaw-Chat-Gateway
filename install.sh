#!/bin/bash
set -e

# Configuration
REPO_URL="https://github.com/liandu2024/OpenClaw-Chat-Gateway.git"
INSTALL_DIR="$HOME/OpenClaw-Chat-Gateway"

# Terminal Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}   OpenClaw Chat Gateway - One-Click Installer  ${NC}"
echo -e "${BLUE}================================================${NC}"

# Check for Prerequisites
echo -e "\n${BLUE}Step 1: Checking Prerequisites...${NC}"

if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: git is not installed. Please install git first.${NC}"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed. Please install Node.js (v18+) first.${NC}"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm is not installed. Please install npm first.${NC}"
    exit 1
fi

# Clone Repository
echo -e "\n${BLUE}Step 2: Cloning Repository...${NC}"
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${BLUE}Directory $INSTALL_DIR already exists. Updating...${NC}"
    cd "$INSTALL_DIR"
    git pull
else
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Run Deployment Script
echo -e "\n${BLUE}Step 3: Initializing Deployment...${NC}"
chmod +x deploy-release.sh
./deploy-release.sh "$1" # Pass single port argument if provided

# Get local IP address
LOCAL_IP=$(hostname -I | awk '{print $1}')
[ -z "$LOCAL_IP" ] && LOCAL_IP="localhost"

# LibreOffice Check
echo -e "\n${BLUE}Step 4: Checking for LibreOffice (Recommended)...${NC}"
if ! command -v libreoffice &> /dev/null; then
    echo -e "安装 libreoffice 有更好的文档预览体验。"
    read -p "检查到主机未安装 libreoffice，是否现在安装？(Y/n): " install_lo
    install_lo=${install_lo:-Y}
    
    if [[ "$install_lo" =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}正在安装 LibreOffice...${NC}"
        sudo apt update && sudo apt install libreoffice -y
    else
        echo -e "${BLUE}您可以下次自行安装，安装指令为: ${NC}sudo apt update && sudo apt install libreoffice -y"
    fi
else
    echo -e "${GREEN}LibreOffice 已安装，文档预览体验已就绪。${NC}"
fi

echo -e "\n${GREEN}================================================${NC}"
echo -e "${GREEN}   Installation Complete! ${NC}"
echo -e "${GREEN}================================================${NC}"
echo -e "You can now access your OpenClaw Chat Gateway."
echo -e "Local Access:   http://localhost:${1:-3115}"
echo -e "Network Access: http://$LOCAL_IP:${1:-3115}"
echo -e "Installation folder: $INSTALL_DIR"
