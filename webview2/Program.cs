using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DeepSeekHarnessLite;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

internal sealed class MainForm : Form
{
    private static readonly Regex AuthUrl = new(@"dsh web:\s*(http://127\.0\.0\.1:\d+/?\?token=\S+)", RegexOptions.Compiled);
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly StringBuilder _output = new();
    private readonly System.Windows.Forms.Timer _timeout = new() { Interval = 90_000 };
    private Process? _backend;

    public MainForm()
    {
        Text = "DeepSeek Harness";
        Width = 1440;
        Height = 920;
        MinimumSize = new Size(960, 640);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_webView);
        Load += async (_, _) => await StartAsync();
        FormClosing += (_, _) => StopBackend();
        _timeout.Tick += (_, _) =>
        {
            _timeout.Stop();
            MessageBox.Show(this, "DSH 内核在 90 秒内没有就绪。\n\n" + Tail(), "DeepSeek Harness",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        };
    }

    private async Task StartAsync()
    {
        try
        {
            await _webView.EnsureCoreWebView2Async();
        }
        catch (Exception error)
        {
            MessageBox.Show(this, "WebView2 运行时不可用：" + error.Message, "DeepSeek Harness",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        var settings = _webView.CoreWebView2.Settings;
        settings.AreDefaultContextMenusEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.AreDevToolsEnabled = false;

        var entry = ResolveEntry();
        if (entry is null)
        {
            MessageBox.Show(this, "未找到 dsh-runtime。请先运行一键部署脚本准备内核。", "DeepSeek Harness",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        var startInfo = new ProcessStartInfo(ResolveNode())
        {
            Arguments = $"\"{entry}\" web --no-open --port 0",
            WorkingDirectory = AppContext.BaseDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.Environment["DSH_HOME"] = ResolveDshHome();

        _backend = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        _backend.OutputDataReceived += (_, args) => OnLine(args.Data);
        _backend.ErrorDataReceived += (_, args) => OnLine(args.Data);
        _backend.Exited += (_, _) => BeginInvoke(() =>
        {
            if (IsDisposed) return;
            MessageBox.Show(this, "DSH 内核已退出。\n\n" + Tail(), "DeepSeek Harness",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        });

        try
        {
            _backend.Start();
            _backend.BeginOutputReadLine();
            _backend.BeginErrorReadLine();
            _timeout.Start();
        }
        catch (Exception error)
        {
            MessageBox.Show(this, "无法启动 DSH 内核：" + error.Message, "DeepSeek Harness",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private void OnLine(string? line)
    {
        if (string.IsNullOrEmpty(line)) return;
        lock (_output)
        {
            _output.AppendLine(line);
            if (_output.Length > 20_000) _output.Remove(0, _output.Length - 10_000);
        }

        var match = AuthUrl.Match(line);
        if (!match.Success) return;

        BeginInvoke(() =>
        {
            if (IsDisposed) return;
            _timeout.Stop();
            _webView.CoreWebView2.Navigate(match.Groups[1].Value);
        });
    }

    private static string ResolveNode()
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "dsh-runtime", "node.exe");
        return File.Exists(bundled) ? bundled : "node";
    }

    private static string ResolveDshHome()
    {
        var configured = Environment.GetEnvironmentVariable("DSH_HOME");
        if (!string.IsNullOrWhiteSpace(configured)) return configured;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
    }

    private static string? ResolveEntry()
    {
        var packageRoot = Path.Combine(AppContext.BaseDirectory, "dsh-runtime", "node_modules", "@deepseek-ai", "dsh");
        var manifestPath = Path.Combine(packageRoot, "package.json");
        var candidates = new List<string>();
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
            if (document.RootElement.TryGetProperty("bin", out var bin))
            {
                if (bin.ValueKind == JsonValueKind.String) candidates.Add(bin.GetString()!);
                else if (bin.ValueKind == JsonValueKind.Object && bin.TryGetProperty("dsh", out var dsh) && dsh.ValueKind == JsonValueKind.String)
                    candidates.Add(dsh.GetString()!);
            }
        }
        catch
        {
            // fall through to layout candidates
        }
        candidates.Add(Path.Combine("bin", "dsh.mjs"));
        candidates.Add(Path.Combine("lib", "bin.js"));

        foreach (var candidate in candidates)
        {
            var full = Path.GetFullPath(Path.Combine(packageRoot, candidate));
            if (File.Exists(full)) return full;
        }
        return null;
    }

    private string Tail()
    {
        lock (_output)
        {
            var text = _output.ToString();
            return text.Length <= 2_000 ? text : text[^2_000..];
        }
    }

    private void StopBackend()
    {
        try
        {
            if (_backend is { HasExited: false }) _backend.Kill(entireProcessTree: true);
        }
        catch
        {
            // ignore shutdown races
        }
    }
}
