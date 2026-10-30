# DeepSeek Harness 桌面增强发行版

> 专为国内开发者与 Windows 平台深度调优的 DeepSeek Harness (DSH) 原生一体化桌面客户端。  
> 开箱即用 · 单窗口沉浸一体化 · 零外跳浏览器 · 自动 Token 认证 · 启动自愈排障 · 预置出厂插件。

详细文档：[用户指南](docs/user-guide.md) | [发布与校验](docs/release.md) | [故障排查](docs/troubleshooting.md)

---

## 🚀 极速上手与构建指南

### 方式一：源码一键启动（免打包直接运行）
1. 在项目根目录双击 **`一键启动.bat`**。
2. 脚本将自动连接国内镜像（npmmirror）、配置环境并直接拉起暗黑原生桌面端。
3. 启动期展示轻量过渡加载屏（`splash.html`），服务就绪后秒级平滑进入工作台，告别外部 Edge/Chrome 弹窗与 401 认证黑屏。
4. 在界面中配置您的 DeepSeek API Key，即可开启流畅的 AI 协作。

### 方式二：本地一键生成 Windows 安装包
1. 在项目根目录双击 **`一键打包及安装.bat`**。
  2. 脚本全自动配置国内全链路镜像并在 `dist/` 目录下生成 `DeepSeek Harness Setup 0.3.0.exe` 安装包。
3. 双击生成的 `.exe` 即可像普通 Windows 软件一样安装使用。

### 方式三：GitHub Actions 云端全自动打包
* 本项目已配置自动化 CI/CD 流程（`.github/workflows/build.yml`）。
* 代码推送到 GitHub 仓库并打上版本标签（如 `v0.3.0`）后，GitHub Actions 将自动完成云端构建并发布正式的 Release 安装包及 SHA-256 校验清单。

---

## 🌟 核心特色功能

* **🖥️ 单窗口一体化沉浸桌面 (Single-Window Seamless Immersion)**：
  * **杜绝浏览器外跳**：后台启动注入 `--no-open` 参数，彻底杜绝 DSH 自动拉起外置 Edge/Chrome 浏览器的割裂体验。
  * **动态 Token 认证捕获**：主进程流式捕获后端 stdout 中的认证 Token URL，自动无感直连，彻底根除 401 Unauthorized 黑屏。
  * **告别多余双侧栏**：剔除冗余外层 `<webview>` 与假侧边轨，完整呈现 DSH 原生全屏界面；启动阶段由轻量原生 `splash.html` 过渡，零白屏闪烁。
  * **Windows 原生集成**：支持 Windows 11 暗黑极简顶栏融合（`titleBarStyle: 'hidden'`）、全局呼出快捷键（`Alt+Space`）、桌面端托盘驻留与文件夹右键快捷启动。
* **🩺 自动故障排查与环境自愈引擎 (`lib/self-repair.js`)**：
  * **8 秒检修入口 + 15 秒看门狗**：启动页在 8 秒后显示「环境自动体检」入口供手动触发；热更内核由 15 秒启动看门狗校验，未就绪且窗口连续加载失败时熔断并回退到出厂内核。
  * **强退残留死锁自愈**：基于 PID 存活探活，毫秒级清理 `.lock` 进程死锁。
  * **解封熔断标记**：自动扫描并清除 `.broken-marker.json` 异常阻断。
  * **原生菜单一键体检**：在应用顶部菜单「引擎与更新」→「🩺 环境自动体检与自愈」中可随时一键体检并生成诊断报告。
  * **dsh 命令行一键注册**：在「Windows 系统集成」中安装或移除 `dsh` 命令，只改写当前用户 PATH 中对应的那一条。
  * **工作区快速切换**：「工作台」菜单支持打开目录与最近工作区列表，最多保留 12 个，切换后自动重启后端。
* **🧩 出厂官方增强插件深度合并 (`lib/preset-hydrator.js`)**：
  * 预置并自动激活 `dsh-codex-ui`（工作台增强）、`dshmarket`（插件市场）、`dsh-better-sidebar`、`dsh-pathlink`、`dsh-paste-input`、`dsh-checkpoint-rewind` 等全套体验。
* **⚡ 国内双轨秒级热更 (`lib/updater.js`)**：
  * **内核快轨**：通过阿里云 npmmirror 镜像源秒级热更 `@deepseek-ai/dsh` 内核，配合 15 秒看门狗与异常自动回退。
  * **外壳慢轨**：多源 CDN 智能回退下载，延迟文件流创建防 `EBUSY` 冲突，支持完整 SHA-256 完整性校验。

---

## ⌨️ 常用快捷键

| 快捷键 | 功能说明 |
| :--- | :--- |
| `Alt + Space` | 全局快速呼出 / 隐藏桌面客户端窗口 |
| `Alt + Shift + V` | 将剪贴板中的最新截图或文本直接灌入输入框 |
| `F12` | 打开开发者调试工具 (DevTools) |

呼出快捷键与 DevTools 快捷键可在用户数据目录的 `keybindings.json` 中修改，改完后从「Windows 系统集成」→「重新加载快捷键」生效。

---

## 🛠️ 命令行开发与测试

```bash
# 1. 安装项目依赖（推荐使用国内镜像）
npm install --registry=https://registry.npmmirror.com

# 2. 准备出厂内置运行时与插件
npm run runtime:prepare

# 3. 启动开发模式
npm start

# 4. 静态检查与全量测试（覆盖自愈、Token 捕获、IPC 鉴权与打包清单校验）
npm run lint
npm test

# 4.1 带覆盖率门禁的测试（行 75% / 分支 70% / 函数 62%）
npm run test:coverage

# 5. 执行 Electron 端到端测试（需要图形环境，无桌面时用 xvfb-run）
npm run test:e2e

# 6. 打包生成 Windows 安装包
npm run dist
```

端到端测试通过 `DSH_E2E=1` 与 `DSH_E2E_BACKEND_URL` 指向本地夹具服务，只接受 `127.0.0.1`/`localhost` 的 HTTP 地址，用于验证窗口启动、preload 桥接、CSP 注入与外链拦截；CI 在 `ubuntu-latest` 上以 `xvfb-run` 执行。
