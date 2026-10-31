# 发布与更新

本文说明 `DeepSeek Harness` 桌面外壳的版本模型、部署方式与更新流程。当前版本为 `0.5.0`。

## 1. 版本模型

| 版本线 | 来源 | 更新方式 |
| --- | --- | --- |
| 桌面外壳 | 仓库根目录 `package.json` 的 `version` | 重新运行 `一键部署.bat`（`git pull` + 依赖与内核同步） |
| DSH 内核 | `@deepseek-ai/dsh` | 安装到 `dsh-runtime`，或下载到 `.dsh/local-runtime` 热更新 |

外壳版本通过 `app.getVersion()` 读取，菜单「引擎与更新」顶部显示 `外壳 vX.Y.Z · DSH 内核 vA.B.C (来源)`。

### 外壳版本

- 当前为 `0.5.0`，定义在 `package.json`。
- Git tag 使用 `v` 前缀，例如 `v0.5.0`。
- 仓库不再构建安装包，外壳更新以重新部署为准。

### 内置内核版本

- 由 `npm run runtime:prepare` 安装到 `dsh-runtime`。
- 版本由环境变量 `DSH_VERSION` 决定，默认 `latest`。
- `dsh-runtime` 不进入 Git，部署时重新生成。
- 正式发布必须显式固定 `DSH_VERSION`，并在记录中写明实际版本。

### 本地热更新内核

- 位于 `%USERPROFILE%\.dsh\local-runtime`，便携模式位于 `portable-data\.dsh\local-runtime`。
- 存在且未被标记损坏时优先于内置内核使用。
- 由「检查更新」按 npm 源的最新版本安装，失败时熔断并回退出厂内核。

## 2. 环境要求

- Windows 10 或 Windows 11 x64。
- Node.js 18 及以上，推荐 22。
- Git。
- 能访问 npm 源与 GitHub；国内网络默认走 npmmirror。

## 3. 部署

```powershell
git clone https://github.com/renquanpake/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm ci --no-audit --no-fund
npm run runtime:prepare
npm start
```

或直接双击 `一键部署.bat`，脚本会完成上述步骤。

## 4. 验证

```powershell
npm run lint
npm run test:coverage
npm run test:e2e
```

- 覆盖率门禁口径：`lib/**`、`src/**` 与 `main.js`，行 75%、分支 70%、函数 62%。
- e2e 需要图形环境，无桌面时用 `xvfb-run npm run test:e2e`。

## 5. 更新流程

### 外壳

重新运行 `一键部署.bat`，或手动执行 `git pull --ff-only` 后重装依赖。适配层的修复通过这条路径到达用户。

1. 拉取最新代码：重新运行 `一键部署.bat`，或手动执行 `git pull --ff-only`。
2. 同步依赖：`npm ci`。
3. 内核与插件：`npm run runtime:prepare`。
4. 重启应用。

已配置的 API Key、工作区列表和用户数据位于 Electron 用户数据目录与 `%USERPROFILE%\.dsh`，更新不会清除。

### 内核

菜单「引擎与更新」→「检查更新」会对比 npm 源版本并热更新，15 秒看门狗未就绪时熔断并回退出厂内核。

### 应用内提示

检测到外壳新版本时，应用只提示版本号并提供「打开仓库」，由用户自行重新部署；安装包下载与执行逻辑已移除。

## 5.1 内核兼容范围

外壳只保证在实测通过的内核范围内工作，当前范围是 `>=0.1.0-0 <0.3.0`（定义在 `lib/dsh-adapter.js` 的 `SUPPORTED_DSH_RANGE`）。

- 部署时 `scripts/check-runtime-compat.js` 会校验内核版本、可执行入口、pnpm 与预置 profile，超出范围直接中止，避免装完才发现白屏。
- 应用内「检查更新」只提示范围内的内核版本；超出范围的版本会被忽略并打印警告。
- 热更新安装前会再校验一次目标版本，不符合范围时拒绝执行。
- 内核下载完成后、切换之前会真实启动一次并验证契约（认证 URL、401、Cookie 换外壳）。
- 验证通过会把版本写入 `DSH_HOME/last-good-core.json`；验证失败时先隔离到 `local-runtime.broken.<时间戳>`，再自动装回 last-good 版本并重启；恢复失败才回退出厂内核。
- 上游发布新内核后，先在本地或 CI 验证启动、认证捕获、页面加载与插件加载，再把 `SUPPORTED_DSH_RANGE` 上限抬高并发布新外壳。

`lib/dsh-adapter.js` 同时集中处理启动参数、`bin` 入口解析与认证 URL 解析，上游调整这些格式时只需改这一处。上游 0.2.1-rc.5 的入口实际是 `node_modules/@deepseek-ai/dsh/lib/bin.js`，适配层读取 `bin` 字段后自动兼容，不再依赖旧的 `bin/dsh.mjs` 路径。

### 上游变更历史观察

基于官方仓库 `deepseek-harness` 2026-06-10 至 2026-10-30 的 24,922 个提交：

| 接触点 | 实际变化 | 对应处理 |
| --- | --- | --- |
| 启动参数 | `--no-open` 于 08-14 随「默认打开浏览器」引入；`--dev` 于 08-11 移除；`--host`、`--public-url`、TLS 为 09-30 至 10-04 的增量新增 | 启动前探测 `dsh web --help`，按实际支持拼参数 |
| 端口 | `--port` 长期存在；上游也支持 `--port 0` | 仍显式传端口，并跟随认证 URL 中的实际端口 |
| 认证 URL | 08-25 起强调跨重载保留 launch token，格式保持 `?token=` | 容错解析 + 真实启动契约检查 |
| 入口 | `apps/cli/src/bin.ts` 路径稳定，`bin` 指向 `lib/bin.js` | 按 package `bin` 字段解析 |
| Profile 结构 | 08-06 将 manifest 命名空间改为 `dsh.profile` / `dsh.bundle`，`dsh plugin --profile` 管理插件 | 部署检查校验 `dsh.profile.bundles` 数组 |
| 破坏性变更分布 | CLI/启动相关 `!` 提交集中在 08-04 至 08-09；之后集中在 session、api、web 工具语义 | 语义层变更仍需适配补丁 |

结论：启动契约在 0.1.0 之后趋于稳定，变化以增量参数为主，正是探测式适配能覆盖的部分；真正需要人工介入的是 profile 与语义层。

### 上游契约检查

```powershell
npm run check:upstream -- --runtime-dir .\dsh-runtime
```

脚本会用真实的 `dsh web --no-open --port <空闲端口>` 启动内核，验证四件事：

1. 启动后打印带 `token` 的认证 URL
2. 无 token 访问 `/` 返回 401
3. 带 token 的 URL 返回 3xx 并下发认证 Cookie
4. 携带 Cookie 访问 `/` 返回 200 且内容是 Web 外壳

任一步失败即以非零码退出。`upstream-contract.yml` 每天 03:00 自动安装 `@deepseek-ai/dsh@latest` 并执行该检查，失败会自动创建或追加一个 GitHub Issue，附上运行记录和处理步骤。

外壳在启动时还会探测 `dsh web --help`：如果新版本移除了 `--no-open` 或 `--port`，会按实际支持的参数组装命令；端口不匹配时自动采用上游打印的端口，而不是加载失败。

认证 URL 由上游在插件加载完成后才打印，外壳启动时最多等待 10 秒；超时会加载裸地址并输出警告，出现 401 时应优先运行上面的契约检查。

## 5.2 与官方更新栈的差距

| 能力 | 官方桌面端 | 本项目 | 状态 |
| --- | --- | --- | --- |
| 传输 | electron-updater generic feed，库内处理分块与续传 | pnpm 装内核、git pull 外壳 | 机制不同，均可用 |
| 信任 | 安装包签名 + publisher 校验 + 公证 | 启动契约验证 + last-good 回退 | 源码部署无安装包签名 |
| 通道 | nightly / latest | 仅 latest（npm dist-tag） | 缺 |
| 状态机 | idle/checking/downloading/verifying/ready/installing/error 跨重启 | 检查/安装/验证/切换/回退，本轮起落盘可跨重启 | 基本对齐 |
| 审计 | 每进程 JSONL，白名单字段并 flush | 本轮新增 JSONL journal，白名单字段并 flush | 已对齐 |
| 中断恢复 | 更新窗口与调度器配合 | 启动检测未完成更新并回车厂内核 | 已对齐 |
| 更新 UI | 专用更新窗口与覆盖层 | 窗口标题百分比 + 弹窗 | 缺 |
| 灰度与强制更新 | 通道 + 强制更新策略 | 版本范围 + 手动检查 | 缺 |

本轮补齐的是状态机与审计：`DSH_HOME/update-journal/update-journal.jsonl` 记录 `check-start`、`install-start`、`verify-ok`、`promote`、`restore`、`factory-fallback` 等事件；启动时若最后一条停在 `install-start` 或 `verify-ok`，判定为中断更新，自动标记本机内核不可用并回车厂内核，同时写操作日志并提示。

## 6. 回滚

- 外壳：`git checkout <上一个版本 tag>` 后重新执行 `npm ci` 与 `runtime:prepare`。
- 内核：菜单「引擎与更新」→「回退出厂内核」，会删除 `local-runtime` 并回到内置内核。
- 内置内核版本通过 `DSH_VERSION` 固定，重新执行 `runtime:prepare` 即可换回。

## 7. 说明

- 仓库不产出安装包，`electron-builder`、NSIS 配置与相关脚本已移除。
- 依赖安全：生产依赖为 0，`npm audit --omit=dev` 无告警；开发工具链的告警不进入运行时。
