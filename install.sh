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

echo -e "\n${GREEN}================================================${NC}"
echo -e "${GREEN}   Installation Complete! ${NC}"
echo -e "${GREEN}================================================${NC}"
echo -e "You can now access your OpenClaw Chat Gateway."
echo -e "URL: http://localhost:${1:-3115}"
echo -e "Installation folder: $INSTALL_DIR"
