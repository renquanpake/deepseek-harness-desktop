# DeepSeek Harness 桌面增强发行版

> 专为国内开发者与 Windows 平台深度调优的 DeepSeek Harness (DSH) 原生一体化桌面客户端。  
> 开箱即用 · 单窗口沉浸一体化 · 零外跳浏览器 · 自动 Token 认证 · 启动自愈排障 · 预置出厂插件。

详细文档：[用户指南](docs/user-guide.md) | [发布与校验](docs/release.md) | [故障排查](docs/troubleshooting.md)

---

## 🚀 部署与更新

### 一键部署（推荐）

只需下载 **`一键部署.bat`**，双击后输入或回车确认部署目录，脚本会自动完成：

1. 检查 Git 与 Node.js（要求 Node 18+，推荐 22）；缺失时提示用 winget 自动安装
2. 克隆仓库到指定目录；目录里已有部署时改为 `git pull` 更新
3. 通过 npmmirror 安装依赖与 Electron 二进制
4. 下载内置 DSH 内核与出厂插件（`runtime:prepare`）
5. 询问是否立即启动

目标目录非空且不是本仓库时会直接中止，不会覆盖已有文件。

### 日常启动

- 标准版：双击 **`一键启动.bat`**，或执行 `npm start`
- 轻量版：双击 **`一键启动-轻量.bat`**，或执行 `npm run start:lite`；只保留窗口与内核，没有托盘、菜单、更新

启动期展示轻量过渡加载屏，服务就绪后进入工作台，在界面里配置 DeepSeek API Key 即可使用。

### 更新

- **外壳**：重新运行 `一键部署.bat`，脚本会 `git pull` 并同步依赖与内核。
- **内核**：菜单「引擎与更新」→「检查更新」，热更新 DSH 内核并自动回滚。
- 应用内检测到外壳新版本时只弹出提示并提供仓库入口，不再下载安装包。

---

## ⚡ 轻量化基线

- 生产依赖为 0，外壳只依赖 Electron 与 Node 标准库
- 工作区、插件、设置、会话等界面能力全部交给 DSH 自带，外壳不重复实现
- 启动时的内核能力探测结果落盘缓存，只有内核版本变化才重新探测
- 度量命令：

```bash
npm run footprint        # 外壳源码与测试规模、内置运行时体积
npm run footprint -- --full   # 额外统计 node_modules
```



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


---

## 🛠️ 命令行开发与测试

```bash
# 1. 安装项目依赖（推荐使用国内镜像）
npm install --registry=https://registry.npmmirror.com

# 2. 准备出厂内置运行时与插件
npm run runtime:prepare

# 3. 启动开发模式
npm start

# 4. 静态检查与全量测试（覆盖自愈、Token 捕获与 IPC 鉴权）
npm run lint
npm test

# 4.1 带覆盖率门禁的测试（行 75% / 分支 70% / 函数 62%）
npm run test:coverage

# 5. 执行 Electron 端到端测试（需要图形环境，无桌面时用 xvfb-run）
npm run test:e2e
```

端到端测试通过 `DSH_E2E=1` 与 `DSH_E2E_BACKEND_URL` 指向本地夹具服务，只接受 `127.0.0.1`/`localhost` 的 HTTP 地址，用于验证窗口启动、preload 桥接、CSP 注入与外链拦截；CI 在 `ubuntu-latest` 上以 `xvfb-run` 执行。
