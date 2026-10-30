# 发布与更新

本文说明 `DeepSeek Harness` 桌面外壳的版本模型、部署方式与更新流程。当前版本为 `0.3.1`。

## 1. 版本模型

| 版本线 | 来源 | 更新方式 |
| --- | --- | --- |
| 桌面外壳 | 仓库根目录 `package.json` 的 `version` | 重新运行 `一键部署.bat`（`git pull` + 依赖与内核同步） |
| DSH 内核 | `@deepseek-ai/dsh` | 安装到 `dsh-runtime`，或下载到 `.dsh/local-runtime` 热更新 |

外壳版本通过 `app.getVersion()` 读取，菜单「引擎与更新」顶部显示 `外壳 vX.Y.Z · DSH 内核 vA.B.C (来源)`。

### 外壳版本

- 当前为 `0.3.1`，定义在 `package.json`。
- Git tag 使用 `v` 前缀，例如 `v0.3.1`。
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

1. 拉取最新代码：重新运行 `一键部署.bat`，或手动执行 `git pull --ff-only`。
2. 同步依赖：`npm ci`。
3. 内核与插件：`npm run runtime:prepare`。
4. 重启应用。

已配置的 API Key、工作区列表和用户数据位于 Electron 用户数据目录与 `%USERPROFILE%\.dsh`，更新不会清除。

### 内核

菜单「引擎与更新」→「检查更新」会对比 npm 源版本并热更新，15 秒看门狗未就绪时熔断并回退出厂内核。

### 应用内提示

检测到外壳新版本时，应用只提示版本号并提供「打开仓库」，由用户自行重新部署；安装包下载与执行逻辑已移除。

## 6. 回滚

- 外壳：`git checkout <上一个版本 tag>` 后重新执行 `npm ci` 与 `runtime:prepare`。
- 内核：菜单「引擎与更新」→「回退出厂内核」，会删除 `local-runtime` 并回到内置内核。
- 内置内核版本通过 `DSH_VERSION` 固定，重新执行 `runtime:prepare` 即可换回。

## 7. 说明

- 仓库不产出安装包，`electron-builder`、NSIS 配置与相关脚本已移除。
- 依赖安全：生产依赖为 0，`npm audit --omit=dev` 无告警；开发工具链的告警不进入运行时。
