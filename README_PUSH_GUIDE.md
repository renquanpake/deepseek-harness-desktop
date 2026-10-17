# DeepSeek Harness Desktop - 旗舰原生桌面端更新指南

本更新包为 **DeepSeek Harness Desktop (v0.1.0 旗舰版)** 的全套核心文件。覆盖到本地仓库后即可直接 push 到 GitHub。

## 🌟 本次关键升级（旗舰体验与自愈引擎）

1. **告别纯网页形态，落地旗舰原生外壳 (`shell/`)**：
   - 沉浸式 Windows 无边框暗黑界面（48px 极简侧边导航轨 + 沉浸式标题栏 + 底部智能状态栏）。
   - 内置 `<webview>` 隔离渲染，彻底杜绝白屏闪烁与浏览器外跳。
   - 超轻量纯原生实现（< 30KB），零第三方臃肿框架依赖。

2. **全自动检修与环境自愈引擎 (`lib/self-repair.js`)**：
   - **8秒启动超时自愈守护**：若因后台卡顿或系统异常未能在 8 秒内就绪，启动过渡屏自动介入诊断并一键自愈，免除用户面对卡死。
   - **解决四大 Windows 顽疾**：
     - 自动检测并清理非正常退出的 `.lock` 进程死锁。
     - 自动清除多级目录中的 `.broken-marker.json` 临时熔断阻塞标记。
     - 自适应 50 轮端口冲突跳变（3080、3081...）与孤儿后台进程清理。
     - 深度校准并补齐出厂官方增强插件配置清单。
   - **正常界面内置检修医生**：底部状态栏 `🩺 自动检修` 及「通用设置」面板均提供一键体检弹窗，点一下自动自愈并平滑重连。

3. **官方出厂预置插件深度合并引擎 (`lib/preset-hydrator.js`)**：
   - 自动预装并激活 `dsh-codex-ui`（工作台增强）、`dshmarket`（插件市场）、`dsh-better-sidebar`、`dsh-pathlink`、`dsh-paste-input`、`dsh-checkpoint-rewind` 等全套体验。

4. **100% 严苛自动化测试**：
   - 包含 62 项全自动化测试（`npm test` 全绿通过）。

## 🚀 提交步骤 (MonkeyCode / 手动)
1. 将本压缩包解压，全部文件覆盖至仓库根目录。
2. 运行 `npm test` 确认 62 项测试通过。
3. 执行提交：
   ```bash
   git add .
   git commit -m "feat: flagship desktop shell with startup timeout auto-repair and diagnostic doctor"
   git push origin main
   ```
