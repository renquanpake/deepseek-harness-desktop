# 用户指南

本指南适用于 `DeepSeek Harness` 0.4.0 桌面外壳。界面菜单默认自动隐藏，按 `Alt` 显示菜单栏。

## 1. 安装与首次启动

### 系统要求

- Windows 10 或 Windows 11，x64。
- 需要 Git 与 Node.js 18+（推荐 22）；用 `一键部署.bat` 时缺失会提示用 winget 安装。
- 使用 Worktree 沙箱需要系统可执行 `git`，并且目标目录是 Git 仓库。
- 使用 WSL2 引擎需要 Windows 已安装 WSL2、默认发行版内有 Node.js 与 npx。

### 安装

下载仓库根目录的 `一键部署.bat`，双击后选择部署目录，脚本会自动拉取代码、安装依赖并准备内置内核。

也可以在终端执行：

```powershell
git clone https://github.com/renquanpake/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm ci
npm run runtime:prepare
npm start
```

### 首次启动

1. 双击部署目录里的 `一键启动.bat` 启动。
2. 启动页会显示连接、插件同步和 Token 校验提示。
3. 后端通常在数秒内就绪；最长等待 30 秒。
4. 8 秒后启动页会出现「环境自动体检」入口，可手动触发自愈。
5. 进入工作台后，按 DSH 界面提示配置 DeepSeek API Key。

首次启动会在 `%USERPROFILE%\.dsh` 创建数据目录，包括 `profiles/web` 插件配置和后续的 `local-runtime` 热更新内核。

### 一键部署（新用户）

1. 从仓库根目录下载 `一键部署.bat`。
2. 双击运行，按提示输入部署目录（直接回车使用 `%USERPROFILE%\DeepSeek-Harness`）。
3. 脚本自动检查 Git / Node.js、克隆或更新代码、安装依赖、准备内置内核，完成后询问是否启动。
4. 之后双击部署目录内的 `一键启动.bat` 即可日常启动。

脚本不会覆盖非空且不属于本仓库的目录，重复运行会改为 `git pull` 更新。

### 窗口与退出

- 点击窗口关闭按钮时，如果托盘可用，窗口会隐藏到托盘，后端继续运行。首次隐藏会弹窗说明，确认后写入标记，后续不再询问。
- 从托盘菜单选择「显示主窗口」恢复。
- 选择「工作台」→「退出程序」或托盘菜单「退出 DSH Studio」才会真正退出。
- 后端处于运行状态时，退出会先弹出确认框，默认选中「取消」，避免误杀正在进行的对话与任务；后端未运行或启动失败时直接退出。
- 从托盘或菜单退出不会触发 Worktree 关闭确认，Worktree 需要手动回收。

### 更新源与镜像

- 默认只使用官方源：npmmirror 注册表、npm 官方注册表与 GitHub Releases。
- 第三方 GitHub 加速镜像默认关闭，需要时显式设置环境变量 `DSH_ALLOW_THIRD_PARTY_MIRROR=1` 后启动。
- 随包提供 `build/update-public-key.pem` 时，外壳只接受带有效 Ed25519 签名的更新清单；没有公钥时退回 SHA-256 校验。

### 快捷键配置

呼出窗口与 DevTools 的快捷键保存在 Electron 用户数据目录的 `keybindings.json`：

```json
{
  "relayShortcut": "Alt+Space",
  "relayFallback": "CommandOrControl+Alt+D",
  "toggleDevTools": "F12"
}
```

- 「Windows 系统集成」→「打开快捷键配置」会给出文件路径。
- 修改后点「重新加载快捷键」，立即重新注册，无需重启应用。
- 非法值会被忽略并回退到默认值，弹窗会列出具体错误。
- `relayShortcut` 被其他程序占用时自动尝试 `relayFallback`，两者都失败会提示注册失败。
- 加速键语法与 Electron 一致，例如 `CommandOrControl+Shift+D`、`F12`、`Alt+Space`。

### dsh 命令行

Windows 版可以把内置的 `dsh` 命令注册到当前用户 PATH：

- 打开「Windows 系统集成」→「安装 / 修复 dsh 命令行」，会在 `%LOCALAPPDATA%\DeepSeek Harness\bin` 生成 `dsh.cmd`，并把该目录追加到用户 PATH（已存在时不重复追加）。
- 便携模式改为写入 `portable-data\bin`，PATH 指向便携目录。
- 修复场景：移动安装目录或 `dsh.cmd` 被删除后，再次点「安装 / 修复」会重写启动器。
- 移除：点「移除 dsh 命令行」，会删除 `dsh.cmd` 并只清理对应的 PATH 条目，其他条目保持不变。
- PATH 变更对新开的终端生效，已打开的终端需要重新启动。
- 启动器指向内置运行时，`dsh-runtime` 缺失时会提示安装失败，不会写入坏掉的快捷方式。

### 单实例

应用只允许一个实例运行。再次启动时会把已有窗口前置；如果新启动命令带有不同的工作区参数，会切换工作区并重启后端。

## 2. 打开工作区

### 默认工作区

未指定参数时，外壳使用启动进程的当前工作目录。从开始菜单启动时，该目录通常不是 Git 仓库，建议通过菜单或命令行明确指定工作区。

### 通过菜单打开

「工作台」→「新建独立工作区分支 (Git Worktree)...」选择任意 Git 仓库目录。外壳会创建隔离 Worktree 并在其中启动后端。

### 通过命令行打开

直接打开目录：

```powershell
& "DeepSeek Harness.exe" --open-dir "D:\code\my-repo"
```

从该目录创建 Worktree 后打开：

```powershell
& "DeepSeek Harness.exe" --worktree-dir "D:\code\my-repo"
```

`--worktree-dir` 可简写为 `--worktree`。

源码模式下通过 npm 传参：

```bash
npm start -- --open-dir "D:\code\my-repo"
```

### 通过右键菜单打开

在「Windows 系统集成」中注册后，文件夹或文件夹空白处右键会出现：

- 「Open with DeepSeek Harness Studio」：等价于 `--open-dir`。
- 「Open in New Git Worktree (DSH Studio)」：等价于 `--worktree-dir`。

便携版移动目录后需要重新注册。

### 隐藏启动

`--hidden` 和 `--minimized` 会让主窗口启动时保持隐藏，供开机自启动使用。普通使用不需要手动传入。

## 3. Worktree 沙箱

Worktree 用于在不影响主工作区的情况下执行任务。

- 外壳在仓库同级目录创建 `<仓库名>-wt-<5 位随机串>`。
- 自动创建临时分支 `dsh/task-<5 位随机串>`。
- 后端工作目录指向该 Worktree，改动和提交都落在临时分支。
- 创建失败时回退为直接打开原仓库目录，此时没有隔离效果，控制台会输出 `[git-worktree] Fallback to original dir`。

### 关闭 Worktree 窗口

关闭主窗口时会弹出确认框，确认后再走一次退出确认：

- 「保留目录并关闭」：保留 Worktree 目录和临时分支，之后手动处理。
- 「销毁 Worktree 并清理分支（推荐）」：结束占用进程，执行 `git worktree remove --force`，再删除临时分支。
- 「取消」：返回窗口。

选择保留或销毁后会先弹出退出确认；在退出确认里取消，Worktree 目录与分支保持原样，不会出现目录已删除但应用仍在运行的状态。

从托盘或菜单退出不会弹出该确认框，也不会自动清理 Worktree。需要手动回收时参考 `docs/troubleshooting.md` 第 4 节。

### 合并结果

Worktree 中的提交位于 `dsh/task-*` 分支。需要保留成果时，在关闭前提交，再在主仓库中合并该分支。选择销毁会强制删除临时分支，未合并的提交将丢失。

## 4. 便携模式

便携模式把用户数据放在程序目录旁边，便于整体拷贝。

### 启用方式

在可执行文件同目录创建名为 `portable-data` 的目录，然后启动程序：

```text
DeepSeek Harness\
  DeepSeek Harness.exe
  portable-data\
```

也可以通过环境变量 `PORTABLE_EXECUTABLE_DIR` 指定程序目录；外壳会在该目录下创建或使用 `portable-data`。

### 目录内容

启用后，外壳会创建并使用：

- `portable-data\.dsh`：DSH 数据、插件配置、热更新内核。
- `portable-data\electron-userdata`：Electron 用户数据。
- `portable-data\appdata-roaming`、`appdata-local`、`userprofile`：后端使用的 AppData 与用户目录。
- `portable-data\home`：后端 HOME，并生成包含系统 `.gitconfig` 的便携配置。
- `portable-data\temp-captures`：剪贴板截图。

后端进程的 `USERPROFILE`、`APPDATA`、`HOME`、`AppData`、`LocalAppData` 会指向上述目录。

### 注意事项

- `portable-data` 不可写时，外壳会回退到 `%USERPROFILE%\.dsh`，控制台输出 `[portable]` 警告。
- 便携目录需要自行在程序目录旁创建 `portable-data`；`portable-data` 不会被更新流程删除。

## 5. 全局快捷键与剪贴板注入

### Alt+Space

`Alt+Space` 全局呼出或隐藏主窗口。

如果该组合被系统或其他应用占用，外壳会回退注册 `Ctrl+Alt+D`，并在控制台输出 `[main] Global shortcut Alt+Space is occupied`。界面不会额外提示。

### Alt+Shift+V

「工作台」→「粘贴剪贴板截图/文本至输入框」对应 `Alt+Shift+V`，把剪贴板内容注入当前可编辑输入框。

行为说明：

- Windows 原生模式读取剪贴板文本并追加到输入框。
- WSL2 模式优先读取剪贴板图片，保存为 PNG 后转换成 `/mnt/...` 路径再注入。
- 输入框已有内容时，文本会以两个换行分隔追加。
- 目标为 `textarea`、`input` 或 `contenteditable` 元素；没有可编辑元素时不会注入。
- 在输入框内粘贴纯图片时，渲染层会请求主进程重新读取剪贴板。

截图文件位置：

- 普通模式：`%TEMP%\dsh-studio-captures`。
- 便携模式：`portable-data\temp-captures`。

## 6. 引擎切换

「引擎与更新」中提供两种运行引擎：

- 「运行引擎：Windows 原生模式」：默认模式，使用内置或热更新的 DSH 内核，速度最快。
- 「运行引擎：WSL2 兼容模式」：通过 `wsl.exe` 在默认发行版内运行 `npx --yes @deepseek-ai/dsh`，适合依赖 Linux 工具链的场景。

切换引擎会重启后端并重新加载页面。

### WSL2 模式限制

- 仅在 Windows 主机可用；其他系统选择后会提示并回到原生模式。
- 需要 WSL2、默认发行版、`bash`、Node.js、npx 和可用网络。
- 工作区路径会转换为 `/mnt/<盘符>/...`。
- 不使用内置 `dsh-runtime`，也不参与本地内核热更新和 15 秒看门狗。
- 每次启动都通过 npx 获取内核，首次启动可能较慢。

### 状态持久化

引擎选择和安全模式都只保存在当前进程内。重启应用后恢复为 Windows 原生模式、安全模式关闭。

## 7. 更新

### 自动检查

应用就绪 5 秒后会静默检查一次更新，发现新版本时弹窗询问。也可以手动打开：

- 「引擎与更新」→「检查更新」
- 托盘菜单「检查更新」

### 内核热更新

DSH 内核通过国内镜像安装到 `%USERPROFILE%\.dsh\local-runtime`，安装完成后自动重启后端。

- 使用内置的 Node.js 与 pnpm 执行安装。
- 安装完成后先真实启动一次新内核，验证认证 URL、401 与 Cookie 换外壳三项契约。
- 验证通过会记录为 last-good；失败时先隔离新内核，再自动装回上次验证通过的版本并重启；连 last-good 都装不回来才回退出厂内核。
- 同步出厂预置插件依赖。
- 切换后由 15 秒看门狗检查；失败会隔离新内核并回滚到出厂内核。
- 可随时通过「引擎与更新」→「回退至出厂内置内核」手动回退。

### 外壳更新

两种方式，效果相同，都是 `git pull` + `npm ci`：

1. 「引擎与更新」→「更新外壳代码（git pull）」：应用内直接拉取并重装依赖，成功后提示重启。工作区有未提交改动或目录不是 Git 仓库时会拒绝执行；依赖安装失败会自动 `git reset` 回滚到更新前的提交。
2. 重新运行 `一键部署.bat`，适合已经出问题、应用起不来的情况。

需要提醒：应用内更新只能拿到仓库里已经修好的代码。上游改了启动参数或认证格式时，维护者要先推送适配补丁，用户更新外壳后才能对上。

- 更新过程：`git pull` → `npm ci` → `npm run runtime:prepare` → 重启应用。
- 用户数据（API Key、工作区、`%USERPROFILE%\.dsh`）不会被清除。
- 外壳不接受自动降级，`package.json` 版本落后时不会提示更新。

### 回滚

- 内核：菜单「回退至出厂内置内核」，或等待看门狗自动回滚。
- 外壳：在部署目录执行 `git checkout <上一个 tag>`，再执行 `npm ci` 与 `npm run runtime:prepare`；用户数据位于 `.dsh` 或 `portable-data`，不会被清除。

自动更新只接受更高的语义化版本，不能通过发布旧版本让客户端自动降级。

## 8. 卸载与数据位置

### 卸载

外壳没有安装程序，直接删除部署目录即可卸载。用户数据位于 `%USERPROFILE%\.dsh` 与 Electron 用户数据目录，需要时手动清理。

### 数据位置

普通模式：

| 内容 | 位置 |
| --- | --- |
| DSH 数据、插件、热更新内核 | `%USERPROFILE%\.dsh` |
| Electron 用户数据 | `%APPDATA%\DeepSeek Harness` |
| 剪贴板截图 | `%TEMP%\dsh-studio-captures` |
| 外壳更新下载 | `%TEMP%` |

便携模式：

| 内容 | 位置 |
| --- | --- |
| DSH 数据、插件、热更新内核 | `<程序目录>\portable-data\.dsh` |
| Electron 用户数据 | `<程序目录>\portable-data\electron-userdata` |
| 剪贴板截图 | `<程序目录>\portable-data\temp-captures` |

需要彻底清理时，在确认不再需要配置和会话记录后，手动删除上述目录。删除 `.dsh` 会同时删除插件配置和热更新内核。

## 9. 相关文档

- 故障排查：`docs/troubleshooting.md`
- 发布、校验与回滚：`docs/release.md`
- 构建与开发：仓库根目录 `README.md`
