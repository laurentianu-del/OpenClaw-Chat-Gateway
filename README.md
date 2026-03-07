# OpenClaw Chat Gateway

[English](#english) | [简体中文](#简体中文)

![Preview](docs/screenshots/preview.png)

---

## English

**OpenClaw Chat Gateway** is a modern, feature-rich web client designed specifically for the OpenClaw ecosystem. It provides a premium chat experience with robust session management and system-level deployment.

### ✨ Key Features

- **🚀 Advanced Chat UI**: 
  - Telegram-style image previews.
  - Multi-line text input with automatic height adjustment.
  - Drag-and-drop file/image uploads.
  - Message quoting and search functionality.
- **📁 Session Management**:
  - Create and manage multiple character sessions.
  - **Drag-and-drop reordering** of sessions in the sidebar.
- **🛡️ Secure Isolation**:
  - Independent database and upload directories.
- **⚙️ Robust Settings**:
  - Mandatory Gateway URL validation with connectivity testing.
  - AI branding (custom AI names).
  - Domain whitelist (allowed hosts) for secure reverse proxy deployment.
  - Optional login password protection.
- **🤖 System Integration**:
  - Built-in `systemd` user service support for auto-start.
  - One-click deployment script with **customizable ports**.

### 🛠️ Tech Stack

- **Frontend**: Vite, React, Vanilla CSS (Premium UI), Lucide React, Framer Motion.
- **Backend**: Node.js, Express, Better-SQLite3, Multer.

### 📥 One-Click Installation

> [!IMPORTANT]
> To ensure a complete and seamless experience, this program must be installed on the same **Linux host** as OpenClaw, and it must be a **native installation** (not deployed via Docker).

The easiest way to install OpenClaw Chat Gateway is using the one-click installer:

```bash
curl -fsSL https://raw.githubusercontent.com/liandu2024/OpenClaw-Chat-Gateway/main/install.sh | bash
```

*By default, the backend uses port **3110** and the frontend uses port **3115**. You can pass custom ports to the script:*

```bash
curl -fsSL https://raw.githubusercontent.com/liandu2024/OpenClaw-Chat-Gateway/main/install.sh | bash -s 8080 8081
```

---

## 简体中文

**OpenClaw Chat Gateway** 是一款为 OpenClaw 生态系统打造的现代化、功能丰富的 Web 客户端。它提供极致的聊天体验、强大的会话管理及系统级自动部署功能。

### ✨ 核心功能

- **🚀 高级聊天界面**：
  - 类 Telegram 的图片预览。
  - 支持多行文本输入，高度自适应。
  - 支持文件和图片的拖拽上传。
  - 消息引用与全局搜索功能。
- **📁 会话管理**：
  - 创建并管理多个角色会话。
  - 侧边栏支持**拖拽排序**。
- **🛡️ 安全隔离**：
  - 独立的数据库与上传文件夹，确保数据纯净。
- **⚙️ 强大设置**：
  - 强制网关连接测试，确保配置正确后方可保存。
  - 自定义 AI 名称。
  - 域名白名单管理，适配反向代理安全环境。
  - 可选的登录密码保护。
- **🤖 系统集成**：
  - 原生支持 `systemd` 用户服务，实现开机自启。
  - 提供一键部署脚本，**支持参数化自定义端口**。

### 🛠️ 技术栈

- **前端**：Vite, React, Vanilla CSS (Premium UI), Lucide React, Framer Motion.
- **后端**：Node.js, Express, Better-SQLite3, Multer.

### 📥 一键安装

> [!IMPORTANT]
> 为了获得完整且无缝的体验，本项目须安装在安装了 OpenClaw 的 **Linux 主机**上，且必须是 **原生安装**（而非 Docker 模式部署）。

最简单的安装方式是使用一键安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/liandu2024/OpenClaw-Chat-Gateway/main/install.sh | bash
```

*默认后端端口为 **3110**，前端端口为 **3115**。您可以通过参数自定义端口：*

```bash
curl -fsSL https://raw.githubusercontent.com/liandu2024/OpenClaw-Chat-Gateway/main/install.sh | bash -s 8080 8081
```
