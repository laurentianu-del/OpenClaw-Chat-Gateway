# OpenClaw Chat Gateway

[English](#english) | [简体中文](#简体中文)

---

## English

**OpenClaw Chat Gateway** is a modern, feature-rich web client designed specifically for the OpenClaw ecosystem. It provides a premium chat experience with robust session management and environment isolation.

### ✨ Key Features

- **🚀 Advanced Chat UI**: 
  - Telegram-style image previews.
  - Multi-line text input with automatic height adjustment.
  - Drag-and-drop file/image uploads.
  - Message quoting and search functionality.
- **📁 Session Management**:
  - Create and manage multiple character sessions.
  - **Drag-and-drop reordering** of sessions in the sidebar.
- **🛡️ Environment Isolation**:
  - **Dev Mode**: Runs on ports 3105 (Frontend) / 3100 (Backend). Uses `~/.clawui_dev`.
  - **Release Mode**: Runs on ports 3115 (Frontend) / 3110 (Backend). Uses `~/.clawui_release`.
  - Complete data and database isolation between environments.
- **⚙️ Robust Settings**:
  - Mandatory Gateway URL validation with connectivity testing.
  - AI branding (custom AI names).
  - Domain whitelist (allowed hosts) for secure reverse proxy deployment.
  - Optional login password protection.
- **🤖 System Integration**:
  - Built-in `systemd` user service support for auto-start.
  - One-click deployment script (`deploy-release.sh`).

### 🛠️ Tech Stack

- **Frontend**: Vite, React, Tailwind CSS, Lucide React, Framer Motion (`motion/react`).
- **Backend**: Node.js, Express, Better-SQLite3, Multer.

### 📥 Installation & Usage

#### Prerequisites
- Node.js (v18+)
- npm

#### Development
```bash
# Install root dependencies
npm install

# Run backend and frontend in Dev mode
npm run dev
```

#### Release Deployment (with Auto-start)
```bash
# Build and setup systemd services
chmod +x deploy-release.sh
./deploy-release.sh
```

---

## 简体中文

**OpenClaw Chat Gateway** 是一款为 OpenClaw 生态系统打造的现代化、功能丰富的 Web 客户端。它提供极致的聊天体验、强大的会话管理以及环境隔离功能。

### ✨ 核心功能

- **🚀 高级聊天界面**：
  - 类 Telegram 的图片预览。
  - 支持多行文本输入，高度自适应。
  - 支持文件和图片的拖拽上传。
  - 消息引用与全局搜索功能。
- **📁 会话管理**：
  - 创建并管理多个角色会话。
  - 侧边栏支持**拖拽排序**。
- **🛡️ 环境隔离**：
  - **开发模式 (Dev)**：使用端口 3105 (前端) / 3100 (后端)，数据存储于 `~/.clawui_dev`。
  - **发布模式 (Release)**：使用端口 3115 (前端) / 3110 (后端)，数据存储于 `~/.clawui_release`。
  - 两套环境数据库与上传文件完全隔离。
- **⚙️ 强大设置**：
  - 强制网关连接测试，确保配置正确后方可保存。
  - 自定义 AI 名称。
  - 域名白名单管理，适配反向代理安全环境。
  - 可选的登录密码保护。
- **🤖 系统集成**：
  - 原生支持 `systemd` 用户服务，实现开机自启。
  - 提供一键部署脚本 (`deploy-release.sh`)。

### 🛠️ 技术栈

- **前端**：Vite, React, Vanilla CSS (Premium UI), Lucide React, Framer Motion.
- **后端**：Node.js, Express, Better-SQLite3, Multer.

### 📥 安装与使用

#### 前提条件
- Node.js (v18+)
- npm

#### 开发环境
```bash
# 安装根目录依赖
npm install

# 以开发模式运行前后端
npm run dev
```

#### 发布部署（带自启）
```bash
# 编译并设置 systemd 服务
chmod +x deploy-release.sh
./deploy-release.sh
```
