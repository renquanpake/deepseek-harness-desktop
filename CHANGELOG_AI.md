# 代码更新索引与变更全景清单 (AI Agent 极速比对指引)

> **致协同 AI / 开发者**：本文件专为快速检索版本变更而生成。若你的本地环境处于上一版本，无需通篇逐行比对整个仓库，请直接查阅本清单或应用同级目录下的 `CHANGES.patch` 补丁文件。

---

## 快速导航与文件变更一览

| 变更文件 | 变更类型 | 关键改动函数 / 目标 | 核心解决问题与架构意图 |
| :--- | :--- | :--- | :--- |
| **`一键打包及安装.bat`** | **ADDED / MERGED** | 全自动一步到位打包及安装脚本 | **极简傻瓜化**：彻底消除新手在“先安装还是先打包”的困惑，双击后一站式全自动走完「环境自检 -> 高速换源 -> 依赖安装 -> 内核预置 -> NSIS 安装包打包 -> 自动弹出 dist 目录 -> 引导一键启动安装」。 |
| **`package.json`** | **MODIFIED** | `nsis.oneClick: true`<br>`win.target: ["nsis"]` | 1. 开启真正的 Windows 一键安装（双击即装，桌面与开始菜单自动生成快捷方式，无多余冗长步骤）；<br>2. **便携版策略调整**：当前版本暂时移除便携版打包，待后续按“功能缩水、极小内存占用、极低体积”的全新轻量化架构重新设计。 |
| **`main.js`** | **MODIFIED** | `restartWithCurrentConfig`<br>`runPnpmAdd`<br>`performAutoUpdate`<br>`isLocalRuntimeAvailable` | 1. 端口自动探测防冲突（`findAvailablePort`）<br>2. pnpm 强制 `--package-import-method=copy` 防 FAT32 报错<br>3. NSIS 静默升级 `app.exit(0)` 防覆盖锁死<br>4. 看门狗熔断版本绑定与热更解封<br>5. 接入开机自启 IPC 与菜单项 |
| **`preload.js`** | **MODIFIED** | `mountSidebarAutoStartButton`<br>`contextBridge` | 1. 暴露 `getAutoStart` / `setAutoStart` / `onAutoStartChanged`<br>2. 注入侧边栏轻量胶囊按钮（自启动: 开/关），实现三端实时同步 |
| **`lib/win-utils.js`** | **MODIFIED** | `toWslPath` | 针对含空格路径强制添加双引号包裹（`"/mnt/c/Users/John Doe/..."`），防止 WSL CLI Agent 解析断裂 |
| **`lib/updater.js`** | **MODIFIED** | `downloadFromUrl`<br>`httpGetJson`<br>`checkRemote*Version` | 1. 延迟文件写盘流（仅在 2xx 时打开），根治 302 重定向造成的 `EBUSY` 与 0 字节文件<br>2. 统一收拢更新网络探测方法为单一真实数据源 |
| **`prepare-runtime.js`** | **MODIFIED** | `main` | 在出厂构建尾声自动触发 `scripts/patch-dsh-runtime.js`，闭环 Win32 目录选择器内存越界修复 |
| **`lib/auto-start.js`** | **ADDED** | `getAutoStart`<br>`setAutoStart` | 封装 Windows 原生登录项设置，包含 `--hidden` 静默托盘启动与权限拒绝异常保护 |
| **`lib/env-utils.js`** | **ADDED** | `findAvailablePort`<br>`prependPathDirs` | 端口可用性扫描器（3080 被占自动切 3081）与跨平台环境变量去重注入 |
| **`lib/lock-cleaner.js`** | **ADDED** | `cleanStaleLocks`<br>`isPidAlive` | 精准区分 `ESRCH`（死进程）与 `EPERM`（高权限存活进程），安全清理死锁文件 |
| **`CHANGES.patch`** | **ADDED** | 标准 Git Unified Patch | 包含所有修改文件的标准 `diff -u` 补丁，可直接使用 `git apply CHANGES.patch` |

---

## 便携版后续轻量化重构路线（按用户指示暂缓）
- **核心目标**：针对超小内存、低配 U 盘场景，大幅精简体积与内存占用。
- **设计方向**：
  1. 剥离繁重的完整出厂 npm/pnpm 依赖缓存；
  2. 采用动态按需加载或极简 C/Win32 原生轻量胶囊载体；
  3. 内核常驻内存由默认百兆级缩减至极简运行模式。
