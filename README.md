# DeepSeek Harness 桌面增强发行版

> 专为国内开发者与 Windows 平台深度调优的 DeepSeek Harness (DSH) 原生桌面客户端。
> 开箱即用 · 原生极简外壳 · 启动超时自愈 · 端口防冲突 · 预置出厂官方插件。

---

## 🚀 极速上手与构建指南

### 方式一：源码一键启动（免打包直接运行）
1. 在项目根目录双击 **`一键启动.bat`**。
2. 脚本将自动连接国内镜像、配置环境并直接拉起原生暗黑桌面端。
3. 在界面中配置您的 DeepSeek API Key，即可开启流畅的 AI 协作。

### 方式二：本地一键生成 Windows 安装包
1. 在项目根目录双击 **`一键打包及安装.bat`**。
2. 脚本全自动配置环境并在 `dist/` 目录下生成 `DeepSeek-Harness-Desktop Setup 0.1.0.exe` 安装包。
3. 双击生成的 `.exe` 即可像普通 Windows 软件一样安装使用。

### 方式三：GitHub Actions 云端全自动打包
* 本项目已配置自动化 CI/CD 流程（`.github/workflows/build.yml`）。
* 代码推送到 GitHub 仓库并打上版本标签（如 `v0.1.0`）后，GitHub Actions 将自动完成云端构建并发布正式的 Release 安装包供公开下载。

---

## 🌟 核心特色功能

* **🖥️ 旗舰原生桌面外壳 (`shell/`)**：
  * 告别生硬的纯网页形态，拥有 48px 极简侧边导航轨、沉浸式 Windows 无边框暗黑界面与智能底部状态栏。
  * 内嵌核心 `<webview>` 隔离渲染，彻底消除启动白屏闪烁与外跳。
* **🩺 自动故障排查与环境自愈引擎 (`lib/self-repair.js`)**：
  * **8 秒超时守护**：启动阶段若因环境阻塞超过 8 秒未就绪，自动触发无感检修与自愈。
  * **强退残留死锁自愈**：基于 PID 存活探活，毫秒级清理 `.lock` 进程死锁。
  * **解封熔断标记**：自动扫描并清除 `.broken-marker.json` 异常阻断。
  * **端口冲突自适应**：自动释放孤儿进程并进行 50 轮端口递增自适应（3080、3081...）。
  * **正常界面体检医生**：底部状态栏 `🩺 自动检修` 和设置面板均可一键呼出可视化体检弹窗。
* **🧩 出厂官方增强插件深度合并 (`lib/preset-hydrator.js`)**：
  * 预置并自动激活 `dsh-codex-ui`（工作台增强）、`dshmarket`（插件市场）、`dsh-better-sidebar`、`dsh-pathlink`、`dsh-paste-input`、`dsh-checkpoint-rewind` 等全套体验。
* **⚡ 国内双轨秒级热更**：
  * 内核走阿里云 npmmirror 镜像源秒级更新，外壳走国内多源 CDN 智能回退。

---

## ⌨️ 常用快捷键

| 快捷键 | 功能说明 |
| :--- | :--- |
| `Alt + Space` | 全局快速呼出 / 隐藏桌面客户端窗口 |
| `Alt + Shift + V` | 将剪贴板中的最新截图或内容投喂至输入框 |

---

## 🛠️ 命令行开发与测试

```bash
# 1. 安装项目依赖（推荐使用国内镜像）
npm install --registry=https://registry.npmmirror.com

# 2. 准备出厂内置运行时与插件
npm run runtime:prepare

# 3. 启动开发模式
npm start

# 4. 执行全量测试（包含 62 项全量自愈与 IPC 鉴权测试）
npm test

# 5. 打包生成 Windows 安装包
npm run dist
```
