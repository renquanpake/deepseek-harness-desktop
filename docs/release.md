# 发布与回滚

本文说明 `DeepSeek Harness` 桌面外壳的版本绑定、构建、校验、发布、灰度与回滚流程。当前版本为 `0.3.0`。

## 1. 版本模型

项目同时存在两条版本线：

| 版本线 | 来源 | 更新方式 |
| --- | --- | --- |
| 桌面外壳 | 仓库根目录 `package.json` 的 `version` | 下载并运行新的 NSIS 安装包 |
| DSH 内核 | `@deepseek-ai/dsh` | 安装包内置运行时，或下载到 `.dsh/local-runtime` 热更新 |

外壳版本通过 `app.getVersion()` 读取，菜单「引擎与更新」顶部会显示 `外壳 vX.Y.Z · DSH 内核 vA.B.C (来源)`。

### 外壳版本

- 当前为 `0.3.0`，定义在 `package.json`。
- Git tag 使用 `v` 前缀，例如 `v0.3.0`。
- `build.yml` 只在 `v*` tag 上创建 GitHub Release。
- 工作流没有校验 tag 与 `package.json` 版本是否一致，发布前必须人工确认。

### 内置内核版本

- 由 `npm run runtime:prepare` 安装到 `dsh-runtime`。
- 版本由环境变量 `DSH_VERSION` 决定，默认值为 `latest`。
- `dsh-runtime` 不进入 Git，构建时重新生成。
- `package.json` 中 `@deepseek-ai/dsh` 的 `devDependencies` 版本不会自动决定内置内核版本；内置内核以 `DSH_VERSION` 为准。

未设置 `DSH_VERSION` 时，同一份源码在不同日期构建可能得到不同内核版本。正式发布必须显式固定该变量，并在 Release 记录中写明实际版本。

### 本地热更新内核

- 位于 `%USERPROFILE%\.dsh\local-runtime`，便携模式位于 `portable-data\.dsh\local-runtime`。
- 存在且未被标记损坏时优先于内置内核使用。
- 由「检查更新」按 npm 源的最新版本安装。
- 熔断或手动回退后会回到内置内核。

### WSL2 引擎

WSL2 模式不使用上述两条内核，而是在 WSL 默认发行版内执行 `npx --yes @deepseek-ai/dsh`，版本取决于当时的 npm 源。热更新与看门狗不适用于 WSL2。

### 版本检查命令

```powershell
node -p "require('./package.json').version"
```

```powershell
node -p "require('./dsh-runtime/node_modules/@deepseek-ai/dsh/package.json').version"
```

```powershell
node -p "require(process.env.USERPROFILE + '/.dsh/local-runtime/node_modules/@deepseek-ai/dsh/package.json').version"
```

## 2. 构建环境

- Windows 10 或 Windows 11 x64，或 GitHub Actions `windows-latest`。
- Node.js 22。
- npm 10 或兼容版本。
- 可访问 npm 源与 GitHub；国内构建可使用 npmmirror 镜像。
- 打包目标：Windows NSIS x64，产物输出到 `dist/`。

两段式 CI：`ci.yml` 在每次 push / PR 上依次执行 `npm ci`、语法检查、ESLint、带覆盖率门禁的单元测试与 Electron e2e；`build.yml` 复用同一套检查，打 `v*` tag 时先校验 tag 与 `package.json` 版本一致，再打包 Windows 安装包、校验 `app.asar` 内容并创建 Release。当前安装包为未签名构建。

覆盖率门禁口径：`lib/**`、`src/**` 与 `main.js`，行 75%、分支 70%、函数 62%；本地用 `npm run test:coverage` 复现。

## 3. 构建命令

锁文件已与 `package.json` 同步，统一使用 `npm ci` 获得可复现安装。

```powershell
npm ci --no-audit --no-fund
```

固定内置内核版本后再准备运行时：

```powershell
$env:DSH_VERSION = "0.1.0-rc.6"
npm run runtime:prepare
```

运行测试：

```powershell
npm test
```

生成安装包：

```powershell
npm run dist
```

`npm run dist` 会再次执行 `runtime:prepare`，然后调用 `electron-builder --win --publish never`。需要固定内核时，确保 `DSH_VERSION` 在 `npm run dist` 执行期间仍然有效。

等价的直接打包命令：

```powershell
npx electron-builder --win --publish never
```

### 运行时准备做了什么

- 删除并重建 `dsh-runtime`。
- 安装 pnpm，并复制到 `dsh-runtime/pnpm.cjs`。
- 通过 npmmirror 安装 `@deepseek-ai/dsh`。
- 安装出厂预置插件，并写入 `preset-manifest.json` 与 `preinstalled-plugins.json`。
- 对 `dsh-host-directory-picker-native` 应用目录选择器稳定性补丁。

插件安装失败会记录警告并继续，具体安装结果以 `dsh-runtime/preset-manifest.json` 为准。

## 4. 产物与校验

### 产物

`electron-builder` 生成：

```text
dist\DeepSeek Harness Setup 0.3.0.exe        # Windows NSIS x64
```

同时可能生成 `.blockmap` 与 `latest.yml` 等辅助文件。当前 `package.json` 没有配置 Portable 目标。

`build.yml` 会额外生成：

```text
dist\SHA256SUMS.txt
```

### 生成校验和

`SHA256SUMS.txt` 由 `build.yml` 的 `release` 作业在汇总构建产物后生成，覆盖 `dist` 下的 `*.exe`，排除 `*.blockmap`。Release 正文会内嵌同一份校验和。

本地构建不会自动生成该文件；需要时按相同规则手工生成，或使用工作流产物。

### 校验安装包

```powershell
Get-FileHash ".\dist\DeepSeek Harness Setup 0.3.0.exe" -Algorithm SHA256
```

```powershell
Get-Content ".\dist\SHA256SUMS.txt"
```

```powershell
certutil -hashfile ".\dist\DeepSeek Harness Setup 0.3.0.exe" SHA256
```

三处结果应一致。`.blockmap` 与 `latest.yml` 不在 `SHA256SUMS.txt` 覆盖范围内，需要单独记录或校验。

### 校验安装包内容清单

`scripts/verify-packaging.js` 会扫描 `main.js`、`preload.js`、`lib/`、`src/` 的运行时 `require` 与启动页、语言包、托盘图标等静态资源，逐项比对 `package.json` 的 `build.files` 白名单。`build.yml` 在打包后自动执行该检查，产物缺文件时构建直接失败。

本地只检查白名单：

```powershell
node scripts/verify-packaging.js
```

检查已生成的 `app.asar` 实际内容（需要已安装 `@electron/asar`）：

```powershell
node scripts/verify-packaging.js --asar ".\dist\win-unpacked\resources\app.asar"
```

新增主进程模块或资源目录时，必须同时在 `build.files` 中登记，否则 `npm test` 中的打包清单用例会失败。

### 更新清单签名

安装包之外还会发布一个签名清单 `latest.json`，客户端用它校验下载的安装包是否来自本仓库发布流程：

1. 维护者本地生成密钥对（私钥不入库）：
   ```powershell
   node scripts/generate-update-keypair.js --private .\update-signing-key.pem --public .\build\update-public-key.pem
   ```
2. 私钥内容写入仓库 Secret `UPDATE_MANIFEST_KEY`，公钥随安装包发布（`build/update-public-key.pem`，已包含在 `build.files`）。
3. 打 `v*` tag 后，`build.yml` 会调用 `scripts/sign-update-manifest.js` 生成 `latest.json`，内容为 `{ manifest: { version, tag, installerUrl, sha256, createdAt }, signature }`。
4. 客户端检测到随包公钥时，必须找到签名有效的 `latest.json` 才接受该 Release；签名缺失或无效会跳过该来源。未随包公钥时沿用原来的 SHA-256 校验并继续工作。

私钥泄露后旧的清单会失效，需要重新生成密钥对、替换公钥并重新发布版本。

### 校验签名状态

```powershell
Get-AuthenticodeSignature ".\dist\DeepSeek Harness Setup 0.3.0.exe"
```

当前预期状态为 `NotSigned`。这不是校验失败，而是本期没有代码签名证书。

### 校验内置内核

从安装目录执行：

```powershell
node -p "require('./resources/app.asar.unpacked/dsh-runtime/node_modules/@deepseek-ai/dsh/package.json').version"
```

结果应与构建时设置的 `DSH_VERSION` 一致。

## 5. 清单签名现状

当前发布物只有 SHA-256 完整性清单，没有可用的密码学签名：

- `SHA256SUMS.txt` 由构建工作流生成，随 Artifact 和 GitHub Release 发布。
- Release 正文内嵌同一份校验和。
- 仓库已提供 `lib/update-manifest.js` 的 Ed25519 清单签名与验签工具，但 `build.yml` 没有生成清单签名，`main.js` 的更新流程也没有调用验签。
- 安装包没有 Authenticode 代码签名。
- 发布流程没有证书指纹、公钥或签名验证步骤。

因此 SHA-256 只能证明文件与清单一致，不能证明清单由谁生成。来源可信度依赖 GitHub Release 的 HTTPS、仓库权限和发布流程。

如果后续接入清单签名，需要在构建时生成签名文件、随 Release 发布公钥指纹，并在客户端更新流程中强制验签，同时在本文件补充验证命令。该能力不在本期范围。

## 6. 发布流程

1. 确认 `package.json` 版本号，例如 `0.3.0`。
2. 固定 `DSH_VERSION`，记录实际内置内核版本。
3. 在 Windows 构建机执行依赖安装、`npm run lint`、`npm test`、`runtime:prepare`、`npm run dist`。
4. 校验安装包 SHA-256、签名状态和内置内核版本。
5. 在干净的 Windows 虚拟机或测试机安装并启动，确认后端就绪、插件加载、快捷键和托盘正常。
6. 提交代码并创建与外壳版本一致的 tag，例如 `v0.3.0`。
7. 推送 tag，触发 `build.yml`。
8. 等待 `build.yml` 完成测试、Windows 打包、`app.asar` 内容校验、生成 `SHA256SUMS.txt` 和创建 Release。
9. 下载 Release 资产，复核校验和后再对外发布。

`build.yml` 还会在推送到 `main` 或 `master`、向 `main` 提交 Pull Request，以及手动触发时构建，但只有 `v*` tag 会创建 Release。

`ci.yml` 负责 push 和 Pull Request 的语法检查与单元测试；它不生成安装包，也不创建 Release。

### 发布前检查

- tag 版本与 `package.json` 一致。
- `DSH_VERSION` 已固定，并记录在发布说明或内部记录中。
- `npm test` 全绿。
- `dist` 中安装包名称与版本一致。
- `SHA256SUMS.txt` 覆盖所有对外安装包。
- 安装包在干净环境完成启动验证。
- 已确认 Release 资产与校验和一致。

## 7. 灰度

当前没有内置灰度通道、百分比发布或渠道切换开关。

- 所有客户端通过同一个最新版本源检查更新。
- 外壳检查 GitHub Release 的 `latest`，内核检查 npm 源的最新版本。
- 客户端启动 5 秒后静默检查一次更新，之后由用户手动检查。
- GitHub 的 `latest` 不包含预发布版本；同版本预发布在语义化比较中也不会被当作更新。
- 因此预发布 tag 不会自动进入客户端更新通道。

需要控制影响范围时，只能使用发布操作实现：

- 延迟创建 tag，先向小范围测试机分发安装包。
- 在确认稳定前不发布 Release。
- 内核更新可先在小范围机器手动检查，再对外发布。

当前没有服务端灰度开关，也没有按用户或机器分批放量的能力。

## 8. 回滚

### 内核回滚

自动回滚：

- 热更新内核启动后启用 15 秒看门狗。
- 进程退出、启动失败，或后端未就绪且窗口连续 2 次加载失败时触发熔断。
- 新内核被重命名为 `local-runtime.broken.<时间戳>`，保留最近 2 份。
- 外壳强制使用出厂内核，并提示用户。

手动回滚：

- 「引擎与更新」→「回退至出厂内置内核」。
- 删除 `local-runtime` 与全部隔离目录，重启后端，使用安装包内置内核。
- 「引擎与更新」→「环境自动体检与自愈」会清除 `.broken-marker.json`，但不会恢复已隔离目录。

### 外壳回滚

- 重新运行上一版 NSIS 安装包覆盖安装。
- 用户数据位于 `%USERPROFILE%\.dsh` 或 `portable-data\.dsh`，覆盖安装不会删除。
- 自动更新只接受更高的语义化版本，不能通过发布旧版本让客户端自动降级。
- 已经升级到问题版本的客户端需要手动安装旧版，或者等待更高的修复版本。

### 发布事故处理

1. 停止继续发布新的 tag。
2. 保留上一版安装包与校验和。
3. 发布更高版本的修复包；不要复用已发布的版本号。
4. 在 Release 说明中写明受影响版本、回滚方式和数据位置。
5. 删除或下架 Release 不会让已升级客户端自动降级，仍需修复版本或手动安装。

## 9. 本期范围外

以下能力明确不在本期范围：

- Windows Authenticode 代码签名与证书管理。
- 发布清单的 Ed25519、GPG、minisign 或 cosign 签名接入。
- 账号体系、登录、授权与用户级发布控制。
- 服务端灰度、分批放量和渠道切换。
- 自动降级。
- Portable 构建目标。

当前发布物的完整性依赖 SHA-256 清单，来源可信度依赖 GitHub Release 与 HTTPS。安装时可能出现 SmartScreen 未知发布者提示。
