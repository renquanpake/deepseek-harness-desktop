# 故障排查

本文适用于 `DeepSeek Harness` 0.6.2 桌面外壳。命令以 Windows 默认安装为例；便携模式请把 `%USERPROFILE%\.dsh` 替换为 `<程序目录>\portable-data\.dsh`。

菜单栏默认自动隐藏，按 `Alt` 可显示。应用内菜单名为「引擎与更新」；部分历史弹窗文案仍写作「引擎与救援」，指向同一个菜单。

## 快速分诊顺序

1. 等待启动握手完成。外壳最多等待 30 秒，8 秒后启动页会出现「环境自动体检」提示。
2. 点击启动页的检修按钮，或使用「引擎与更新」→「环境自动体检与自愈」。
3. 使用「引擎与更新」→「故障排查安全模式」排除第三方插件影响。
4. 使用「引擎与更新」→「回退至出厂内置内核」排除热更新内核问题。
5. 切换「运行引擎：Windows 原生模式」与「运行引擎：WSL2 兼容模式」。
6. 按「日志位置」收集主进程输出。

## 1. 后端未就绪或空白页

### 症状

- 启动页停留时间较长，随后进入空白页。
- 弹出「后端未能就绪，当前显示空白页」警告。
- 标题栏和窗口正常，页面一直无法交互。
- 控制台出现 `[dsh-backend] Failed to spawn backend`、`[dsh]` 错误或反复崩溃日志。

### 原因

- `dsh-runtime` 缺失、被杀毒软件隔离，或 `@deepseek-ai/dsh` 文件不完整。当前版本发现运行时会直接弹出「DSH 运行时缺失」并停止启动，不再通过 `npx` 联网兜底。
- 认证 URL 未从后端 stdout 捕获，窗口加载了裸 `http://127.0.0.1:<端口>`，后端返回 401。
- 热更新内核损坏，或 `.dsh/profiles/web` 中的插件配置损坏。
- 端口被占用且连续探测失败，或 WSL2 环境不可用。
- 后端连续崩溃并重启 5 次后，再次崩溃时外壳停止自动重启。

### 处理

先执行自愈，再回退内核：

- 「引擎与更新」→「环境自动体检与自愈」
- 「引擎与更新」→「回退至出厂内置内核」

从终端启动以查看主进程输出：

```bash
npm start
```

检查当前端口是否有服务响应：

```powershell
curl.exe -I http://127.0.0.1:3080
```

检查 DSH 数据目录是否存在：

```powershell
dir "%USERPROFILE%\.dsh"
```

检查认证 URL 是否捕获成功，控制台应出现：

```text
[dsh-auth] 成功捕获启动认证 URL: ...
```

如果弹出「DSH 运行时缺失」，说明 `dsh-runtime` 不可用。在部署目录执行：

```bash
npm run runtime:prepare
```

如果只有裸地址、没有认证 URL，先重启后端；仍失败时使用安全模式或回退内核。

### 说明

- 后端最多自动重启 5 次；第 6 次崩溃后停止自动重启。延迟依次为 1.5 秒、3 秒、6 秒、12 秒、15 秒。
- 启动页 8 秒提示只是检修入口，不会自动重启后端。
- 热更新内核有独立的 15 秒启动看门狗，见第 3 节。

## 2. 端口占用

### 症状

- 空白页，但后端进程存在。
- 控制台出现端口监听失败、`EADDRINUSE` 或健康检查一直失败。
- 访问 `http://127.0.0.1:<端口>` 返回其他本地服务的页面。
- WSL2 模式下 Windows 侧端口空闲，但 WSL 内部端口已被占用。

### 原因

- 其他本地服务占用了 3080 起始端口。
- 外壳会从 3080 开始向上探测，最多尝试 50 个端口；全部失败时会回退到一个未经校验的候选端口。
- WSL2 引擎在 WSL 内部监听，Windows 侧的端口探测无法代表 WSL 内部状态。
- 上一次后端进程没有退出，继续占用端口。

### 处理

查看 3080 及后续端口的占用：

```powershell
netstat -ano | findstr :3080
```

```powershell
Get-NetTCPConnection -LocalPort 3080 -State Listen
```

确认 PID 后结束对应进程：

```powershell
taskkill /PID <PID> /F
```

WSL2 模式下在发行版内部检查：

```powershell
wsl.exe -- bash -lc "curl -I http://127.0.0.1:3080"
```

清理占用后，在「引擎与更新」中切换一次引擎，或重启应用，让外壳重新探测端口。

### 说明

- 外壳只监听本机回环地址，不提供局域网访问。
- 当前没有固定端口配置项；端口每次重启都会重新探测。
- 结束进程前先确认 PID 对应的是 DSH 或占用端口的旧进程，避免终止其他应用。

## 3. 内核热更失败与看门狗回滚

### 症状

- 更新提示成功，但重启后空白。
- 弹出「已自动回滚内核」或「回滚后仍未就绪」。
- 控制台出现 `[dsh-watchdog] 已启用 15000ms 启动看门狗`、`[dsh-watchdog] 触发熔断`。
- `.dsh` 下出现 `local-runtime.broken.<时间戳>` 目录。
- 再次启动仍然使用出厂内核。

### 原因

- 新版本 `@deepseek-ai/dsh` 与当前插件、Node 运行时不兼容。
- 热更新安装不完整，`local-runtime/node_modules/@deepseek-ai/dsh` 缺失。
- 内置 `node.exe` 或 `pnpm.cjs` 缺失，无法完成热更新。
- 新内核 15 秒内未就绪，且窗口连续 2 次加载失败。
- 旧内核被隔离后留下 `.broken-marker.json`，同版本会被标记为不可用。

### 处理

查看隔离目录和熔断标记：

```powershell
dir "%USERPROFILE%\.dsh" /b | findstr /i "local-runtime"
```

```powershell
type "%USERPROFILE%\.dsh\local-runtime\.broken-marker.json"
```

查看当前本地内核版本：

```powershell
node -p "require(process.env.USERPROFILE + '/.dsh/local-runtime/node_modules/@deepseek-ai/dsh/package.json').version"
```

按影响从轻到重处理：

- 「引擎与更新」→「环境自动体检与自愈」：清除 `.broken-marker.json`、清理死锁并重启。
- 「引擎与更新」→「回退至出厂内置内核」：删除 `local-runtime` 与全部隔离目录，回到随应用下载的内置内核。
- 「引擎与更新」→「检查更新」：重新安装内核后再观察。

### 看门狗行为

- 只对本地热更新内核生效，出厂内置内核和 WSL2 引擎不走这套逻辑。
- 启动 15 秒后检查：进程已退出、启动失败，或后端未就绪且窗口连续 2 次加载失败，都会触发熔断。
- 熔断时优先把 `local-runtime` 重命名为 `local-runtime.broken.<时间戳>`，保留最近 2 份隔离目录。
- 重命名失败时写入 `.broken-marker.json`，记录 `brokenVersion`、`reason`、`at`、`detail`。
- 熔断后强制使用出厂内核，并在当前会话 6 小时内不再尝试本地内核。
- 新内核版本高于标记中的 `brokenVersion` 时，标记会被自动清除。
- 后端仍在正常启动中时，看门狗会放行，后续交给常规崩溃重启策略。

## 4. Worktree 残留进程与分支

### 症状

- 关闭 Worktree 窗口时提示回收失败。
- 同级目录残留 `<仓库名>-wt-<随机串>`。
- `git worktree list` 仍显示已删除的路径。
- `git branch --list "dsh/task-*"` 残留临时分支。
- 再次创建 Worktree 时报路径已存在或分支已存在。

### 原因

- Worktree 内有 Node 进程或编辑器占用文件，导致 `git worktree remove` 失败。
- 关闭时选择了「保留目录并关闭」，目录和分支会按设计保留。
- 从托盘或「工作台」→「退出程序」退出时，不会触发 Worktree 关闭确认，也不会自动回收。
- 创建新工作区会覆盖内存中的 Worktree 会话记录，旧目录需要手动清理。
- 临时分支未合并时，`git branch -D` 可能失败。

### 处理

先列出 Worktree 和分支：

```bash
git worktree list
```

```bash
git branch --list "dsh/task-*"
```

确认路径无人使用后强制移除：

```bash
git worktree remove "<worktree-path>" --force
```

路径已经不存在时清理 Git 元数据：

```bash
git worktree prune
```

删除临时分支：

```bash
git branch -D "dsh/task-<随机串>"
```

查找占用工作区的 Node 进程：

```powershell
tasklist /V /FI "IMAGENAME eq node.exe" /FO LIST
```

确认 PID 后结束进程树：

```powershell
taskkill /PID <PID> /T /F
```

### 说明

- 外壳只会扫描并结束命令行包含 Worktree 路径的 `node.exe`，其他进程需要手动处理。
- Worktree 路径为仓库同级目录 `<仓库名>-wt-<5 位随机串>`，分支为 `dsh/task-<5 位随机串>`。
- 创建失败时会回退到原仓库目录，控制台输出 `[git-worktree] Fallback to original dir`，此时没有沙箱可清理。
- 需要保留现场时选择「保留目录并关闭」，之后按上面的命令手动回收。

## 5. WSL2 引擎不可用

### 症状

- 切换到 WSL2 后空白或后端未就绪。
- 弹出「WSL2 引擎仅在 Windows 主机上可用」。
- 控制台出现 `wsl.exe`、`bash`、`npx` 相关错误。
- Windows 原生模式正常，WSL2 模式一直启动失败。

### 原因

- 当前系统未安装 WSL2，或默认发行版未启动。
- 发行版内没有 `bash`、Node.js 或 `npx`。
- WSL 内无法访问 npm 源，`npx --yes @deepseek-ai/dsh` 下载失败。
- 工作区路径转换后不可访问，或路径包含特殊字符。
- WSL 内部端口已被占用。
- 热更新内核不会用于 WSL2，WSL2 每次都通过 `npx` 获取内核，对网络依赖更强。

### 处理

检查 WSL 状态和发行版：

```powershell
wsl.exe --status
```

```powershell
wsl.exe -l -v
```

检查发行版内的 Node 和 npx：

```powershell
wsl.exe -- bash -lc "node -v"
```

```powershell
wsl.exe -- bash -lc "npx -v"
```

未安装 WSL2 时安装并重启：

```powershell
wsl.exe --install
```

检查 WSL 内部端口：

```powershell
wsl.exe -- bash -lc "curl -I http://127.0.0.1:3080"
```

处理完成后在「引擎与更新」→「运行引擎：Windows 原生模式」切回原生模式，再切回 WSL2 重试。

### 说明

- WSL2 引擎只在 Windows 主机可用，固定使用 `wsl.exe` 的默认发行版。
- 工作区路径会从 `C:\path` 转换为 `/mnt/c/path`，含空格的路径会被引号包裹。
- WSL2 模式不使用安装包内的 `dsh-runtime`，也不参与本地内核热更新与 15 秒看门狗。
- 剪贴板截图在 WSL2 下会落盘并转换成 `/mnt/...` 路径后注入。

## 6. 安全模式

### 症状

- 怀疑第三方插件导致启动失败、白屏或界面异常。
- 正常模式反复崩溃，需要最小化插件影响。

### 原因

- 预置插件或用户安装的插件与当前 DSH 内核不兼容。
- 插件配置损坏，自愈合并后仍然异常。

### 处理

打开「引擎与更新」→「故障排查安全模式」，勾选后外壳会重启后端并传入 `--safe-mode`。

排查完成后取消勾选，外壳会再次重启并恢复正常模式。

如果安全模式仍然空白：

- 「引擎与更新」→「回退至出厂内置内核」
- 「引擎与更新」→「运行引擎：Windows 原生模式」
- 按第 1 节收集主进程日志

### 说明

- 安全模式只负责向 DSH 传递 `--safe-mode`，具体禁用哪些插件由 DSH 内核决定。
- 安全模式状态不持久化，重启应用后恢复为关闭。
- WSL2 模式同样会传递 `--safe-mode`。

## 7. 日志位置

外壳会把关键操作与崩溃写入 Electron 用户数据目录，主进程 stdout/stderr 仍然只到启动它的终端。

| 日志或数据 | 位置 | 查看方式 |
| --- | --- | --- |
| 外壳主进程 stdout/stderr | 启动终端 | 源码模式运行 `npm start`，或从 `一键启动.bat` 的窗口查看 |
| 操作日志 | Electron 用户数据目录下的 `logs\operations.jsonl` | 「Windows 系统集成」→「打开崩溃报告目录」后返回上一级 `logs`，或直接读取文件 |
| 崩溃报告 | Electron 用户数据目录下的 `crash-reports\crash-<时间戳>-<类型>.json` | 「Windows 系统集成」→「打开崩溃报告目录」，保留最近 20 份 |
| 渲染进程与 DSH 页面 | DevTools | 「Windows 系统集成」→「打开开发者调试工具」，或按 `F12` |
| DSH 数据目录 | `%USERPROFILE%\.dsh` | 「Windows 系统集成」→「打开 DSH 数据与插件目录」 |
| 本地热更新内核 | `%USERPROFILE%\.dsh\local-runtime` | 查看 `node_modules\@deepseek-ai\dsh\package.json` |
| 插件配置 | `%USERPROFILE%\.dsh\profiles\web` | 查看 `package.json` 与 profile 文件 |
| 熔断标记 | `%USERPROFILE%\.dsh\local-runtime\.broken-marker.json` | 使用 `type` 查看 |
| 隔离内核 | `%USERPROFILE%\.dsh\local-runtime.broken.<时间戳>` | 保留最近 2 份 |
| Electron 用户数据 | `%APPDATA%\DeepSeek Harness` | 以实际 productName 目录为准 |
| 剪贴板截图 | `%TEMP%\dsh-studio-captures` | 便携模式为 `portable-data\temp-captures` |
| 外壳更新安装包 | `%TEMP%` | 文件名取自 Release 资产 |

常见日志前缀：

- `[dsh]`：后端 stdout/stderr 转发。
- `[dsh-auth]`：认证 URL 捕获。
- `[dsh-watchdog]`：崩溃重启、启动看门狗、熔断与回滚。
- `[hot-update]`、`[updater]`：内核热更新与 pnpm 安装。
- `[git-worktree]`：Worktree 创建、进程回收、分支删除。
- `[portable]`：便携数据目录初始化。
- `[reg-menu]`：右键菜单注册。
- `[ipc]`：IPC 来源校验拒绝。
- `[tray]`：托盘创建与菜单异常。
- `[crash]`：崩溃报告写入位置，例如 `uncaught-exception`、`unhandled-rejection`、`renderer-gone`。
- `[operation-log]`：操作日志写入失败。

需要提交问题时，优先提供从终端启动的完整输出，并注明外壳版本、DSH 内核版本、引擎模式和当前端口。

## 7.1 CSP 违规排查

- 默认 `DSH_BACKEND_CSP=report`：后端主文档会收到 `Content-Security-Policy-Report-Only`，违规只记录不拦截。
- 记录写入 `logs\operations.jsonl`，`type` 为 `csp-violation`，相同内容 10 秒内只记一次。
- 临时强制：设置 `DSH_BACKEND_CSP=enforce` 后重启应用，浏览器会按严格策略拦截；出现白屏就改回 `report` 并提交日志。
- 完全关闭：`DSH_BACKEND_CSP=off`。
- 该开关只影响后端 HTTP 主文档；`dsh-app://` 页面始终使用 `lib/app-protocol.js` 的完整策略。

## 7.2 内核被判定不兼容

症状：

- 部署脚本报「下载到的 DSH 内核超出外壳已验证的版本范围」。
- 「检查更新」不再提示新内核，控制台出现 `[updater] 内核 x.y.z 超出已验证范围`。

原因与处理：

- 外壳只支持 `lib/dsh-adapter.js` 里 `SUPPORTED_DSH_RANGE` 声明的范围，防止上游破坏性变更导致白屏。
- 热更新被判定不兼容时，外壳会先尝试恢复 `DSH_HOME/last-good-core.json` 记录的上一版内核；该文件不存在时才回退出厂内核。
- 想继续用当前外壳：固定内核版本，例如 `set DSH_VERSION=0.2.1` 后重新执行 `npm run runtime:prepare`。
- 想升级内核：先更新外壳代码，测试通过后由维护者抬高范围上限。
- 手动体检：`node scripts/check-runtime-compat.js`，会校验内核版本、入口、pnpm、`default-profile` 结构与 `dsh.profile.bundles` 格式。
- 端到端确认内核行为：`npm run check:upstream -- --runtime-dir .\dsh-runtime`，会真实启动内核并验证认证 URL、401 与 Web 外壳。

## 7.3 遇到兼容性报错的处理顺序

1. 先跑体检：`node scripts/check-runtime-compat.js`，确认内核版本与入口是否正常。
2. 再跑契约检查：`npm run check:upstream -- --runtime-dir .\dsh-runtime`，看是认证 URL、401、Cookie 还是外壳页面这一步失败。
3. 应用内「引擎与更新」→「更新外壳代码（git pull）」：拉取最新的适配层修复，重启后再试。
4. 还不行就固定内核：`set DSH_VERSION=<已知可用版本>` 后 `npm run runtime:prepare`，先用旧内核恢复工作。
5. 应用已经起不来时，直接重新运行 `一键部署.bat`，或在部署目录执行 `git pull` 与 `npm ci`。

自动化的边界：外壳能自己拉取修复代码，也能在启动时探测 `dsh web --help` 自动切换启动参数、跟随上游打印的端口，但不能凭空生成适配逻辑。上游语义级变更需要维护者更新 `lib/dsh-adapter.js` 并推送，用户侧再通过上面的步骤拿到；仓库侧有每日 `upstream-contract` 工作流负责提前发现。

## 7.4 更新中断后的恢复

症状：应用提示「更新未完成」，内核回到出厂版本。

- 原因：上次内核更新停在安装或验证阶段就被关闭或崩溃，`update-journal.jsonl` 最后一条不是 `promote`/`restore`/`factory-fallback`。
- 处理：重新点「检查更新」，或执行 `npm run runtime:prepare` 后重启。
- 排查：查看 `%USERPROFILE%\.dsh\update-journal\update-journal.jsonl`，按顺序即可看到停在哪一步。

## 8. 自愈流程

### 自动执行的部分

- 每次启动后端前，递归清理 DSH 数据目录中的失效 `.lock` 文件，跳过 `node_modules`。
- 每次启动后端前，把出厂 `default-profile` 合并到 `.dsh/profiles/web`。
- 后端异常退出时按退避策略重启，最多 5 次。
- 热更新内核启动时启用 15 秒看门狗，失败则隔离并回滚到出厂内核。
- 启动页 8 秒后显示检修提示，由用户点击触发。
### 手动自愈

「引擎与更新」→「环境自动体检与自愈」会依次执行：

1. 清理 DSH 数据目录中的失效 `.lock`。
2. 删除 `local-runtime`、当前运行时目录和 DSH 数据根目录下的 `.broken-marker.json`。
3. 重新合并出厂预置插件配置。
4. 结束当前后端子进程树。
5. 重新探测端口、启动后端并等待就绪。
6. 在对话框中报告执行动作、当前端口和引擎模式。

### 自愈不能解决的问题

- 系统未安装 WSL2，或 WSL 发行版内缺少 Node.js。
- 安装包内的 `dsh-runtime` 缺失或损坏；当前外壳不会通过 `npx` 联网兜底，需要重新安装或重新准备运行时。
- Worktree 目录被其他程序占用。
- 端口被其他服务长期占用。
- 已隔离的内核目录不会自动恢复；需要重新检查更新。

## 9. 上下文菜单注册失败

### 症状

- 注册后提示「部分成功（x/12），N 项写入失败」。
- 文件夹空白处或文件夹右键没有「Open with DeepSeek Harness Studio」。
- 移动程序目录后，右键菜单仍指向旧路径。
- 非 Windows 系统提示右键菜单仅在 Windows 主机可用。

### 原因

- `HKCU\Software\Classes` 写入被组策略、安全软件或注册表权限拦截。
- 程序目录移动后，注册表中的 `process.execPath` 旧路径失效。
- 资源管理器缓存未刷新。
- 只注册了文件夹背景或文件夹本体的一部分，另一部分写入失败。

### 处理

先移除再重新添加：

- 「Windows 系统集成」→「移除 Windows 文件夹右键快捷项」
- 「Windows 系统集成」→「添加 Windows 文件夹右键快捷启动」

检查注册表项：

```powershell
reg query "HKCU\Software\Classes\Directory\Background\shell\DSHStudioOpen" /s
```

```powershell
reg query "HKCU\Software\Classes\Directory\shell\DSHStudioOpen" /s
```

```powershell
reg query "HKCU\Software\Classes\Directory\Background\shell\DSHStudioWorktree" /s
```

```powershell
reg query "HKCU\Software\Classes\Directory\shell\DSHStudioWorktree" /s
```

菜单项写入失败且需要手动删除时：

```powershell
reg delete "HKCU\Software\Classes\Directory\Background\shell\DSHStudioOpen" /f
```

```powershell
reg delete "HKCU\Software\Classes\Directory\shell\DSHStudioOpen" /f
```

```powershell
reg delete "HKCU\Software\Classes\Directory\Background\shell\DSHStudioWorktree" /f
```

```powershell
reg delete "HKCU\Software\Classes\Directory\shell\DSHStudioWorktree" /f
```

注销并重新登录，或在任务管理器中重启「Windows 资源管理器」，让菜单刷新。

### 说明

- 注册命令共 12 条，全部位于 `HKCU`，不需要管理员权限。
- 两个入口分别是「Open with DeepSeek Harness Studio」和「Open in New Git Worktree (DSH Studio)」，对应 `--open-dir` 与 `--worktree-dir`。
- 便携版移动目录后必须重新注册。
- 非 Windows 平台注册结果总数为 0，菜单会提示仅 Windows 可用。
