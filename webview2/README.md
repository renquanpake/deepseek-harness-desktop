# WebView2 轻量桌面壳（可选）

比 Electron 更小的桌面形态：约 70–90 MB 的自包含 exe + 系统自带 WebView2 运行时，外壳代码不到 400 行。

## 依赖

- Windows 10/11 x64
- .NET 8 SDK（仅构建需要）
- WebView2 Runtime（Windows 11 自带；Windows 10 通常随 Edge 安装）

## 构建

```powershell
dotnet publish webview2/DeepSeekHarnessLite.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o webview2\out
```

把 `webview2\out\DeepSeekHarnessLite.exe` 放到部署目录（与 `dsh-runtime` 同级）即可运行。

## 行为

- 拉起 `dsh-runtime\node_modules\@deepseek-ai\dsh` 的 `web --no-open --port 0`
- 从 stdout 解析认证 URL，用 WebView2 打开
- 关闭窗口结束内核进程
- 没有 preload、托盘、菜单、快捷键、更新

## 状态

本目录是脚手架，尚未在 Windows 实机编译验证；CI 的 `WebView2 Lite` 工作流会在 `windows-latest` 上执行发布并产出 artifact。
