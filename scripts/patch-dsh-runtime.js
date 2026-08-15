// 稳定性补丁：修复 dsh-runtime 里 Win32 文件夹对话框 worker 的崩溃
//
// 背景：@deepseek-ai/dsh-host-directory-picker-native 的 readUtf16 用
// `koffi.view(address, 32768)` 读取 GetDisplayName 返回的路径字符串。koffi.view
// 在 Windows 上把裸地址包进外部 ArrayBuffer，当请求范围跨过不可读页边界时，
// koffi 会调用 napi_fatal_error 直接 abort 进程（SIGABRT），worker 进程随即
// 退出，GUI 报 "win32 folder dialog worker exited before reporting a result"。
//
// 修复：改为先用 lstrlenW（C 层逐 2 字节走到 NUL，永不越界）取长度，
// 再用 memcpy 把精确的字符串字节拷进 JS Buffer —— 完全不依赖 koffi.view。
// 本脚本幂等：已修复的文件直接跳过；每次构建前运行即可保持修复不丢失。
const fs = require('fs');
const path = require('path');

const TARGET = path.join(
  __dirname,
  '..',
  'dsh-runtime',
  'node_modules',
  '@deepseek-ai',
  'dsh-host-directory-picker-native',
  'lib',
  'worker.cjs'
);

// 匹配打包产物里的旧实现（兼容 tab/空格缩进与单双引号差异）
const OLD_PATTERN =
  /function readUtf16\(koffi, address\) \{\s*const bytes = Buffer\.from\(koffi\.view\(address, 32768\)\);\s*let end = 0;\s*while \(end \+ 1 < bytes\.length && bytes\[end\] !== 0\) end \+= 2;\s*return bytes\.toString\("utf16le", 0, end\);\s*\}/;

const NEW_IMPL = `function readUtf16(koffi, address) {
	if (address === 0n || address === 0 || address === null) return "";
	const kernel32 = koffi.load("kernel32.dll");
	const msvcrt = koffi.load("msvcrt.dll");
	const lstrlenW = kernel32.func("__stdcall", "lstrlenW", "int", ["void *"]);
	const memcpy = msvcrt.func("memcpy", "void *", ["void *", "void *", "size_t"]);
	const len = lstrlenW(address);
	if (len <= 0) return "";
	const out = Buffer.alloc(len * 2 + 2);
	memcpy(koffi.address(out, 0), address, len * 2 + 2);
	return out.toString("utf16le", 0, len * 2);
}`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.warn(`[patch-dsh-runtime] 跳过：未找到 ${TARGET}（先运行 runtime:prepare）`);
    return;
  }
  const code = fs.readFileSync(TARGET, 'utf8');
  if (!code.includes('koffi.view(address, 32768)')) {
    console.log('[patch-dsh-runtime] worker.cjs 已是安全实现，无需修补');
    return;
  }
  if (!OLD_PATTERN.test(code)) {
    console.error('[patch-dsh-runtime] 发现旧实现但模式不匹配，请手动检查 worker.cjs');
    process.exit(1);
  }
  fs.writeFileSync(TARGET, code.replace(OLD_PATTERN, NEW_IMPL));
  console.log('[patch-dsh-runtime] 已应用 readUtf16 安全读取修复 ->', TARGET);
}

main();
