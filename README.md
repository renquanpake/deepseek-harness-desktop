# DeepSeek Harness 桌面端外壳

把 DeepSeek Harness (dsh) WebUI 包成原生 Windows 桌面应用。

## 功能
- 一键启动：自动拉起 dsh web 服务（127.0.0.1:3080），就绪后打开窗口
- 关窗即停：窗口关闭自动杀掉后端进程树，不留僵尸进程
- 系统托盘：最小化到托盘 + 右键菜单（显示/重启/退出）
- 开机自启动
- 全局快捷键 Ctrl+Alt+D 呼出窗口
- 深色模式跟随系统
- 自动更新（electron-updater，下载完成后弹窗确认安装）
- 双击安装的 NSIS 安装程序，用户无需装 Node.js

## 开发
```bash
npm install          # 安装依赖（含 dsh）
npm start            # 开发模式启动
npm run dist         # 打包安装程序（dist/ 目录）
```

## 自动更新（自测流程）
1. `npm run dist` 打包当前版本（如 0.1.0）
2. 把 `package.json` 的 version 升到 0.1.1，再 `npm run dist`
3. 建目录 `updates/`，把新版 `DeepSeek-Harness-Desktop-Setup-0.1.1.exe` + `latest.yml` 放进去
4. 起本地服务器：在 `updates/` 父目录执行 `python -m http.server 8080`（确保 URL 形如 `http://127.0.0.1:8080/updates/latest.yml`）
5. 安装 0.1.0 旧包 → 启动 → 8 秒后自动检查（或托盘菜单"检查更新"）→ 弹窗确认重启安装

正式发布：把 `package.json` 的 `build.publish.url` 换成真实静态服务器地址（nginx/OSS 均可），发布时上传 exe + latest.yml 即可。

## 架构
- `electron/main.js` — 主进程：窗口、托盘、快捷键、自启动、后端生命周期管理
- `electron/backend.js` — 后端管理：spawn dsh / 端口轮询 / 进程树清理
- `scripts/prepare-runtime.js` — 打包前准备 dsh-runtime/（把 dsh 及其依赖复制出来，用 Electron 自带 Node 运行，用户零安装）
