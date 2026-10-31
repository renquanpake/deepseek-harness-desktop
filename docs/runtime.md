# Python / Office 运行时

本文档说明桌面外壳内置 Python 与 Office 文档处理能力所依赖的运行时布局、安装命令、离线部署方式与常见故障排查。

当前实现由 `lib/python-runtime.js` 与 `scripts/prepare-python-runtime.js` 提供，版本清单固定为 `build/runtime-manifest.json`。Python 运行时准备已作为 `runtime:prepare` 的可选增强步骤接入打包链路（allowFail 语义，见第 9 节），也可以独立命令方式运行。

## 1. 运行时布局

Node / pnpm 运行时位于项目根目录的 `dsh-runtime/`，出厂插件与 profile 通过 `DSH_HOME` 指向 `dsh-runtime/default-profile`。Python 运行时复用同一个 `dsh-runtime/` 根目录，并在其下新增 `python/` 子目录：

```text
dsh-runtime/
├── package.json                  # Node 运行时清单
├── node_modules/                 # node / pnpm / dsh 内核
├── preset-manifest.json          # 出厂插件清单
├── preinstalled-plugins.json     # 出厂插件清单副本
├── default-profile/              # DSH_HOME 预置 profile
└── python/
    └── python-runtime.json       # Python 包版本 stamp
```

`python-runtime.json` 记录以下字段：

```json
{
  "schemaVersion": 1,
  "python": {
    "executable": "python",
    "version": "3.12.4"
  },
  "packages": {
    "numpy": "2.1.3"
  },
  "updatedAt": "2026-10-27T00:00:00.000Z"
}
```

说明：

- 解释器本身不随安装包分发，`ensurePythonRuntime` 使用系统或用户指定的 CPython 3.11 / 3.12。
- `python/` 目录只保存版本 stamp，不复制 site-packages；打包时该目录由 `scripts/prepare-python-runtime.js` 按需创建。
- `python/` 目录遵循"有内容才打包"：打包 glob 只收集目录内实际存在的文件，构建机跳过 Python 步骤或安装失败时目录中不会有 stamp，安装包内也就没有这些产物，详见第 9 节。
- stamp 与当前探测到的 Python 版本不一致时，不会信任旧 stamp，会重新通过 `pip show` 校验。
- 安装失败时不会写入新的 stamp，旧 stamp 保持原样，下一次执行可通过 `pip show` 继续补齐。

## 2. 固定依赖清单

`build/runtime-manifest.json` 固定以下版本：

| 包 | 版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| numpy | 2.1.3 | 数值计算 | BSD-3-Clause |
| pandas | 2.2.3 | 表格与数据分析 | BSD-3-Clause |
| python-docx | 1.1.2 | Word `.docx` 读写 | MIT |
| python-pptx | 1.0.2 | PowerPoint `.pptx` 读写 | MIT |
| openpyxl | 3.1.5 | Excel `.xlsx` 读写 | MIT |
| Pillow | 11.0.0 | 图像处理 | HPND |
| CPython（外部） | 3.11 / 3.12 | 解释器 | PSF-2.0 |

## 3. 命令行用法

```bash
# 使用默认 dsh-runtime 目录与 build/runtime-manifest.json
npm run runtime:python

# 直接调用脚本
node scripts/prepare-python-runtime.js

# 指定运行时目录、Python 可执行文件与清单
node scripts/prepare-python-runtime.js \
  --runtime-dir ./dsh-runtime \
  --python "C:\Python312\python.exe" \
  --manifest build/runtime-manifest.json
```

参数：

- `--runtime-dir <dir>`：运行时根目录，默认 `<项目>/dsh-runtime`。
- `--python <exe>`：Python 可执行文件，默认环境变量 `DSH_PYTHON`，否则为 `python`。
- `--manifest <file>`：版本清单，默认 `<项目>/build/runtime-manifest.json`。
- `-h` / `--help`：显示帮助。

退出码：

- `0`：Python 可用，缺失包已安装或全部跳过。
- `1`：Python 探测失败、版本不受支持、清单非法、安装失败或 stamp 写入失败。

输出摘要包含 Python 路径、运行时目录、新安装包、跳过的包和 stamp 路径。

## 4. 安装流程

`ensurePythonRuntime({ runtimeDir, pythonExe, packages, runner, manifest })` 的执行顺序：

1. 读取并校验版本清单，拒绝非法包名、非法版本号、冲突版本和空清单。
2. 执行 `python --version` 探测解释器，检查是否为清单支持的 3.11 / 3.12。
3. 读取 `python/python-runtime.json`。stamp 中的 Python 版本与当前一致时，版本匹配的包直接跳过。
4. stamp 未覆盖或版本不一致时，执行 `python -m pip show <pkg>` 读取实际版本。已匹配的包跳过。
5. 仅对缺失或不匹配的包执行：

```text
python -m pip install --no-input --disable-pip-version-check <pkg>==<ver>
```

6. 全部包处理成功后写入新的 stamp，记录解释器、包版本与 UTC 时间。

所有子进程调用都使用 `execFile` 参数数组，显式设置 `shell: false`，不拼接 shell 命令。代码本身不发起任何网络请求，网络访问只发生在 pip 命令内部。

返回值：

```js
{
  ok: true,
  pythonPath: 'python',
  installed: ['numpy'],
  skipped: ['pandas'],
  reason: 'ok'
}
```

失败时 `ok` 为 `false`，`reason` 为可直接展示的中文错误，`installed` / `skipped` 反映失败前已完成的包。

`probePython(pythonExe, { runner })` 单独返回 `{ ok, version }`，失败时额外带 `reason`。`runner` 可注入，用于测试或替换执行器；默认实现为 `promisify(execFile)`。

## 5. 离线安装

在线机器准备与目标平台、Python 版本一致的 wheel 包：

```bash
mkdir wheelhouse
python -m pip download --only-binary=:all: --dest wheelhouse \
  numpy==2.1.3 pandas==2.2.3 python-docx==1.1.2 \
  python-pptx==1.0.2 openpyxl==3.1.5 Pillow==11.0.0
```

将 `wheelhouse/` 复制到离线机器，通过 pip 环境变量强制本地查找：

```bash
export PIP_NO_INDEX=1
export PIP_FIND_LINKS=/absolute/path/to/wheelhouse
node scripts/prepare-python-runtime.js --runtime-dir ./dsh-runtime
```

Windows CMD：

```bat
set PIP_NO_INDEX=1
set PIP_FIND_LINKS=C:\absolute\path\to\wheelhouse
node scripts\prepare-python-runtime.js --runtime-dir .\dsh-runtime
```

`ensurePythonRuntime` 会继承当前进程环境变量，因此 `PIP_NO_INDEX`、`PIP_FIND_LINKS`、`PIP_INDEX_URL`、`HTTP_PROXY`、`HTTPS_PROXY` 均可直接生效。

## 6. 许可证提示

- numpy 与 pandas 使用 BSD-3-Clause，再分发时需保留版权声明、许可证文本和免责声明。
- python-docx、python-pptx、openpyxl 使用 MIT，再分发时需保留版权声明与许可证文本。
- Pillow 使用 HPND（Historical Permission Notice and Disclaimer），属于宽松许可证，再分发时保留版权与许可声明。
- CPython 使用 PSF-2.0，随安装包分发解释器时需附带 PSF 许可证文本。

本仓库不重新打包上述 Python 包。若后续将 site-packages 或解释器打入安装包，需要在发行物中补充对应许可证文件与第三方声明。

## 7. 常见失败与排查

### Python 探测失败

现象：`Python 探测失败: spawn python ENOENT`。

处理：确认 Python 已安装，使用 `--python` 指向完整路径，或设置 `DSH_PYTHON`。Windows 可使用 `C:\Python312\python.exe`。

### 版本不受支持

现象：`Python 3.13.0 不受支持，请使用 3.11, 3.12`。

处理：切换到 CPython 3.11 或 3.12。当前固定版本的 numpy / pandas 轮子仅验证了这两个小版本。

### pip 不可用

现象：`No module named pip`。

处理：

```bash
python -m ensurepip --upgrade
python -m pip --version
```

### 系统 Python 受 PEP 668 保护

现象：`error: externally-managed-environment`。

处理：创建虚拟环境，并把虚拟环境解释器传给脚本：

```bash
python -m venv .venv-python
node scripts/prepare-python-runtime.js --python .venv-python/bin/python
```

Windows 下虚拟环境解释器为 `.venv-python\Scripts\python.exe`。

### 网络超时或下载缓慢

现象：`Read timed out`、`Could not find a version that satisfies the requirement`。

处理：配置国内镜像或代理，例如：

```bash
export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
```

离线环境按第 5 节配置 `PIP_NO_INDEX` 与 `PIP_FIND_LINKS`。

### 源码构建失败

现象：安装 numpy / pandas / Pillow 时出现编译错误。

处理：确认使用 64 位 CPython 3.11 / 3.12，并优先使用 wheel：

```bash
python -m pip install --only-binary=:all: numpy==2.1.3
```

无可用 wheel 时再安装编译工具链，或改用离线 wheelhouse。

### stamp 与真实环境不一致

现象：stamp 显示已安装，但运行时仍报模块缺失。

处理：先将 `dsh-runtime/python/python-runtime.json` 重命名备份，再重新执行准备脚本。脚本会通过 `pip show` 重新校验实际安装状态。

### 安装中断后的恢复

安装失败时旧 stamp 不会被覆盖。修复网络或权限问题后直接重跑脚本，已安装成功的包会通过 `pip show` 识别并跳过，只补齐剩余包。

## 8. 安全边界

- 不通过 shell 执行任何命令，包名与版本在执行前经过正则校验。
- 不隐式下载解释器、pip 或任何包。
- 网络行为完全来自显式执行的 pip 命令，可通过 pip 环境变量控制镜像、代理与离线模式。
- 不在 stamp 中记录凭据、镜像密码或代理信息。

## 9. 构建与打包链路集成

### 触发方式

- 部署时在 `runtime:prepare` 之后执行 `npm run runtime:prune`，删除非运行时文件（约省 300 MB），再跑兼容与契约检查。
- `npm run runtime:prepare` 是准备运行时的主步骤，部署时由 `一键部署.bat` 或手动执行。`prepare-runtime.js` 在完成 Node / pnpm 运行时与出厂插件准备后，最后一步以可选增强方式调用：

```bash
node scripts/prepare-python-runtime.js --runtime-dir dsh-runtime --manifest build/runtime-manifest.json
```

- Python 准备也可以单独触发：`npm run runtime:python`，或使用第 3 节的命令行形式。
- 子进程继承当前环境变量，执行 `npm run runtime:prepare` 前设置 `DSH_PYTHON` 即可指定使用的 Python 可执行文件。

### 失败语义（allowFail）

- Python 步骤是可选增强，不引入独立打包入口。机器上没有 Python、版本不受支持、`pip install` 失败或 stamp 写入失败时，仅输出 `[prepare-runtime] Warning` 告警，`runtime:prepare` 继续正常完成。
- 构建机缺少 Python 时，安装包内没有 Python stamp 产物；目标机器或构建机装好 CPython 3.11 / 3.12 后，可补跑 `npm run runtime:python` 生成 stamp。
- 需要显式跳过该步骤时，设置 `DSH_SKIP_PYTHON=1` 后执行 `runtime:prepare` 或 `dist`。

### 产物位置与打包配置

- Python 运行时产物位于 `dsh-runtime/python/python-runtime.json`：`lib/python-runtime.js` 的 `RUNTIME_SUBDIR` 为 `python`，与 Node 运行时共用同一个 `dsh-runtime/` 根目录，由 `scripts/prepare-python-runtime.js` 按需创建。
- Python 运行时写入 `dsh-runtime/python`，与 CLI 默认位置保持一致；目录缺失或为空时跳过，不影响应用启动。
- `build.asarUnpack` 已有 `dsh-runtime/**` 规则，`dsh-runtime/python/` 随整个 `dsh-runtime/` 一起从 asar 解包，安装后可在 `app.asar.unpacked` 下直接读取。
