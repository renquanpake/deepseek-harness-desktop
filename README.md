# DeepSeek Harness 桌面端外壳

把 DeepSeek Harness (dsh) WebUI 包成原生 Windows 桌面应用。

## 功能
- 一键启动：自动拉起 dsh web 服务（127.0.0.1:3080），就绪后打开窗口
- 关窗即停：窗口关闭自动杀掉后端进程树，不留僵尸进程
- 右键菜单：Git Worktree 隔离会话 + Open with DSH Studio
- Alt+Space 全局快捷键呼出/隐藏窗口
- WSL2 引擎切换（Windows 宿主桥接 Linux 内核）
- 失焦 CPU 降频（preload 层 requestAnimationFrame 节流）
- 死锁 .lock 清理（启动时扫描 DSH_HOME 中失效 PID 的锁文件）
- 内置独立 node.exe + pnpm.cjs：客户端无需安装 Node.js / npm
- 双轨自动更新：一键联检 DSH 官方内核与 Electron 外壳，国内镜像加速

## 开发
```bash
npm install          # 安装依赖（含 dsh）
npm start            # 开发模式启动
npm run dist         # 打包安装程序（dist/ 目录）
```

## 双轨自动更新（国内特供版）

### 核心思路

DSH 内核与 Electron 外壳采用**独立的双轨更新**：内核走热更新（`~/.dsh/local-runtime`），外壳走 NSIS 覆盖安装。用户在同一个菜单里一键联检，一次弹窗确认，后台自动完成。

### 双层运行时路由

`main.js` 中的 `getRuntimeDir()` 按以下优先级解析运行时目录：

1. `LOCAL_RUNTIME_DIR = ~/.dsh/local-runtime`（便携版为 `portable-data/.dsh/local-runtime`）——若 `node_modules/@deepseek-ai/dsh/bin/dsh.mjs` 存在则优先使用；
2. `dsh-runtime/`——安装包内置的出厂 dsh-runtime（`app.asar.unpacked/dsh-runtime`）。

热更新仅影响 `LOCAL_RUNTIME_DIR`，出厂内核保留在 asar 解包区作为回滚保底。

### 打包机的 Node / pnpm 捆绑

`prepare-runtime.js` 在构建时：

1. 把 `process.execPath`（打包机上的 Node 可执行文件）复制为 `dsh-runtime/node.exe`——彻底避免 `ELECTRON_RUN_AS_NODE` 引起的 Win11 沙箱 0xC0000142 崩溃；
2. 执行 `npm install pnpm@latest --registry=https://registry.npmmirror.com`，确保 `dsh-runtime/node_modules/pnpm/bin/pnpm.cjs` 存在；
3. 通过 npmmirror 安装 `@deepseek-ai/dsh@latest` 与预设插件。

客户端启动时优先用内置 `node.exe` 直接执行 `dsh.mjs`，零外部依赖。

### 一键联检 + 弹窗确认 + 全自动执行

菜单入口在「引擎与救援」下：

- 🔄 检查更新 (自动联检内核与外壳)
- ⏪ 回退至出厂内置内核（删除 `LOCAL_RUNTIME_DIR` 后重启后端）

应用启动完成 5 秒后自动触发一次静默检查（无更新不打扰）。

**第一步：并发联检**

- DSH 内核：`GET https://registry.npmmirror.com/@deepseek-ai/dsh/latest`（5 秒超时），取 `version` 与当前运行内核比对；
- Electron 外壳：轮询 `fastly.jsdelivr.net` → `ghfast.top` → `raw.githubusercontent.com` 上的 `package.json`（任一成功即止），取 `version` 与 `app.getVersion()` 比对。

**第二步：弹窗汇总**

- 两边均无新版：提示「当前外壳与 DSH 官方内核均已是最新版本」；
- 检测到任一侧新版：列出「DSH 官方内核：x.y.z -> a.b.c」/「客户端外壳：x.y.z -> a.b.c」，提供「立即全自动更新」与「稍后」。

**第三步：全自动执行**

内核有更新：标题栏显示「正在通过国内镜像热更新 DSH 内核与插件...」→ 停止后端 → 内置 `node.exe` 执行内置 `pnpm.cjs`，对 `LOCAL_RUNTIME_DIR` 运行 `pnpm add @deepseek-ai/dsh@latest --registry=https://registry.npmmirror.com` → 用新内核重启后端并刷新页面 → 提示热更新成功。

外壳有更新：调 GitHub API（带 ghfast 镜像回退）拉取最新 release → 自动拼接国内代理池（`ghfast.top` / `mirror.ghproxy.com`）流式下载到 `os.tmpdir()`，标题栏实时更新「正在下载客户端外壳更新 (XX%)...」。

- 普通安装版：下载完成后 `spawn(installer, ['/S'], { detached: true, stdio: 'ignore' }).unref()` 静默覆盖安装，`app.quit()` 让位。
- Portable 便携版：自动打开下载文件夹并提示用户解压覆盖（`portable-data` 数据不丢）。

### 回退保底

新版翻车时，点「⏪ 回退至出厂内置内核」删除 `LOCAL_RUNTIME_DIR` 并重启后端，秒回出厂内核。外壳 NSIS 静默覆盖不会删除 `portable-data` 与 `~/.dsh`，用户数据不会丢失。

## 架构
- `main.js` — 主进程：窗口、菜单、快捷键、双轨更新流水线、后端生命周期管理
- `prepare-runtime.js` — 打包前准备 dsh-runtime/（node.exe + pnpm.cjs + @deepseek-ai/dsh + 预设插件）
- `lib/updater.js` — 版本比较 / 更新计划决策 / GitHub URL 代理池拼接 / release 安装包挑选
- `lib/backend-lifecycle.js` — 崩溃重启策略（指数退避 + 上限）
- `lib/cli-workspace.js` — 命令行工作区参数解析（`--open-dir` / `--worktree-dir`）
- `lib/win-utils.js` — Windows 路径转 WSL 挂载路径
- `lib/win-reg.js` — 注册表命令批处理（右键菜单项注册/移除）
- `lib/trusted-url.js` — 后端 loopback 白名单校验（IPC 反冒用）

## 自动更新（自测流程）
1. `npm run dist` 打包当前版本（如 0.1.0）
2. 把 `package.json` 的 version 升到 0.1.1，再 `npm run dist`
3. 建目录 `updates/`，把新版 `DeepSeek-Harness-Desktop-Setup-0.1.1.exe` + `latest.yml` 放进去
4. 起本地服务器：在 `updates/` 父目录执行 `python -m http.server 8080`（确保 URL 形如 `http://127.0.0.1:8080/updates/latest.yml`）
5. 安装 0.1.0 旧包 → 启动 → 5 秒后自动检查（或菜单"检查更新"）→ 弹窗确认全自动升级

正式发布：把 `package.json` 的 `build.publish.url` 换成真实静态服务器地址（nginx/OSS 均可），发布时上传 exe + latest.yml 即可。

## 稳定性修复
- **0xC0000142（Win11 沙箱崩溃）**：`prepare-runtime.js` 把 `process.execPath` 复制为 `dsh-runtime/node.exe`，`main.js` 启动时优先用内置 node.exe 执行 `dsh.mjs`，彻底绕开 `ELECTRON_RUN_AS_NODE`。
- **dsh 内置 Win32 文件夹对话框崩溃**：`scripts/patch-dsh-runtime.js` 用 `lstrlenW` + `memcpy` 替代 `koffi.view` 读取路径字符串。
