'use strict';

/**
 * 模拟真实使用的集成测试
 * 测试实际的 HTTP 请求、重定向跟随、下载失败回退、版本比较等
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { semverCompare, isNewer, decideUpdatePlan, buildProxyedUrls, pickInstallerUrl, downloadFromUrl, downloadWithProxies } = require('../lib/updater');

// ===== 辅助函数（与 main.js 逻辑一致，用于测试） =====

function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const lib = url.startsWith('https:') ? https : http;
    let req;
    try {
      req = lib.get(url, { headers: { 'User-Agent': 'deepseek-harness-desktop/1.0' } }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          finish(null, new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            finish(JSON.parse(text));
          } catch (err) {
            finish(null, err);
          }
        });
      });
    } catch (err) {
      finish(null, err);
      return;
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => finish(null, err));
  });
}

async function checkRemoteCoreVersion() {
  try {
    const data = await httpGetJson('https://registry.npmmirror.com/@deepseek-ai/dsh/latest');
    if (!data || !data.version) return null;
    return data.version;
  } catch {
    return null;
  }
}

async function checkRemoteShellVersion() {
  const urls = [
    'https://fastly.jsdelivr.net/gh/renquanpake/deepseek-harness-desktop@main/package.json',
    'https://ghfast.top/https://raw.githubusercontent.com/renquanpake/deepseek-harness-desktop/main/package.json',
    'https://raw.githubusercontent.com/renquanpake/deepseek-harness-desktop/main/package.json'
  ];
  for (const url of urls) {
    try {
      const data = await httpGetJson(url);
      if (data && data.version) return data.version;
    } catch {
      // try next mirror
    }
  }
  return null;
}

async function checkRemoteReleaseAssets() {
  const urls = [
    'https://api.github.com/repos/renquanpake/deepseek-harness-desktop/releases/latest',
    'https://ghfast.top/https://api.github.com/repos/renquanpake/deepseek-harness-desktop/releases/latest'
  ];
  for (const url of urls) {
    try {
      const data = await httpGetJson(url);
      if (data && data.assets && data.assets.length > 0) {
        const installerUrl = pickInstallerUrl(data.assets);
        if (installerUrl) {
          return { tag: data.tag_name, installerUrl };
        }
      }
    } catch {
      // try next mirror
    }
  }
  return null;
}

// ===== 下载函数：直接使用 lib/updater.js 的生产实现 =====

const PROXIES = [
  'https://ghfast.top/',
  'https://mirror.ghproxy.com/'
];

// ===== Mock HTTP 服务器 =====

const mockServers = [];
let mockServer = null;
let mockServerPort = null;

function createMockServer(routes) {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const route = routes[req.url];
      if (route) {
        route(req, res);
      } else {
        res.statusCode = 404;
        res.end('Not Found');
      }
    });
    mockServers.push(mockServer);
    mockServer.listen(0, '127.0.0.1', () => {
      mockServerPort = mockServer.address().port;
      resolve();
    });
  });
}

// ===== 测试用例 =====

test('1. 真实网络: 检查 DSH 内核版本 (npmmirror)', async () => {
  const version = await checkRemoteCoreVersion();
  assert.ok(version, '应该能从 npmmirror 获取到版本号');
  assert.match(version, /^\d+\.\d+\.\d+/, '版本号格式应该正确');
  console.log(`   ✓ 获取到 DSH 内核版本: ${version}`);
});

test('2. 真实网络: 检查外壳版本 (多源回退)', async () => {
  const version = await checkRemoteShellVersion();
  assert.ok(version, '应该能从至少一个源获取到版本号');
  console.log(`   ✓ 获取到外壳版本: ${version}`);
});

test('3. 真实网络: 检查 GitHub Release 资产 (可能为空)', async () => {
  const release = await checkRemoteReleaseAssets();
  // 仓库可能还没有发布 release，这是正常的
  if (release) {
    assert.ok(release.tag, '应该有 tag');
    assert.ok(release.installerUrl, '应该有安装包 URL');
    console.log(`   ✓ 获取到 release: ${release.tag}`);
    console.log(`   ✓ 安装包 URL: ${release.installerUrl}`);
  } else {
    console.log('   ⚠ 暂无 release 发布（正常，仓库可能还没有发布版本）');
  }
});

test('4. 版本比较: 与真实版本对比', async () => {
  const coreVersion = await checkRemoteCoreVersion();
  const shellVersion = await checkRemoteShellVersion();

  if (coreVersion) {
    assert.strictEqual(isNewer(coreVersion, '0.0.1'), true, '远程版本应该比 0.0.1 新');
    assert.strictEqual(isNewer('0.0.1', coreVersion), false, '本地旧版本不应该比远程新');
    assert.strictEqual(isNewer(coreVersion, coreVersion), false, '相同版本不应该更新');
    console.log(`   ✓ 核心版本 ${coreVersion} 比较正确`);
  }

  if (shellVersion) {
    assert.strictEqual(isNewer(shellVersion, '0.0.1'), true, '外壳远程版本应该比 0.0.1 新');
    assert.strictEqual(isNewer('0.0.1', shellVersion), false, '本地旧版本不应该比远程新');
    console.log(`   ✓ 外壳版本 ${shellVersion} 比较正确`);
  }
});

test('5. 更新计划: 真实版本数据', async () => {
  const coreVersion = await checkRemoteCoreVersion();
  const shellVersion = await checkRemoteShellVersion();

  if (coreVersion && shellVersion) {
    // 场景 1: 两边都需要更新
    const plan1 = decideUpdatePlan({
      core: { currentVersion: '0.0.1', remoteVersion: coreVersion },
      shell: { currentVersion: '0.0.1', remoteVersion: shellVersion }
    });
    assert.strictEqual(plan1.hasUpdate, true);
    assert.strictEqual(plan1.coreNeedsUpdate, true);
    assert.strictEqual(plan1.shellNeedsUpdate, true);

    // 场景 2: 只有核心需要更新
    const plan2 = decideUpdatePlan({
      core: { currentVersion: '0.0.1', remoteVersion: coreVersion },
      shell: { currentVersion: shellVersion, remoteVersion: shellVersion }
    });
    assert.strictEqual(plan2.hasUpdate, true);
    assert.strictEqual(plan2.coreNeedsUpdate, true);
    assert.strictEqual(plan2.shellNeedsUpdate, false);

    // 场景 3: 两边都最新
    const plan3 = decideUpdatePlan({
      core: { currentVersion: coreVersion, remoteVersion: coreVersion },
      shell: { currentVersion: shellVersion, remoteVersion: shellVersion }
    });
    assert.strictEqual(plan3.hasUpdate, false);

    console.log('   ✓ 更新计划决策正确 (3 种场景)');
  }
});

test('6. 代理 URL 构建: 真实代理配置', () => {
  const url = 'https://github.com/renquanpake/deepseek-harness-desktop/releases/download/v0.1.0/app.exe';
  const urls = buildProxyedUrls(url, PROXIES);
  assert.strictEqual(urls.length, 3, '应该生成 3 个候选 URL');
  assert.ok(urls[0].startsWith('https://ghfast.top/'), '第一个应该是 ghfast.top 代理');
  assert.ok(urls[1].startsWith('https://mirror.ghproxy.com/'), '第二个应该是 ghproxy 代理');
  assert.strictEqual(urls[2], url, '第三个应该是原始 URL');
  console.log(`   ✓ 生成 ${urls.length} 个候选 URL`);
  urls.forEach((u, i) => console.log(`     [${i}] ${u}`));
});

test('7. Mock 服务器: 直接下载 (无重定向)', async () => {
  await createMockServer({
    '/file': (req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Length', '13');
      res.end('Hello, World!');
    }
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
  const destPath = path.join(tmpDir, 'test-download.txt');

  try {
    const url = `http://127.0.0.1:${mockServerPort}/file`;
    const result = await downloadFromUrl(url, destPath, null);
    assert.strictEqual(result, destPath, '应该返回目标路径');

    const content = fs.readFileSync(destPath, 'utf8');
    assert.strictEqual(content, 'Hello, World!', '应该下载完整内容');
    console.log('   ✓ 直接下载成功');
    console.log(`   ✓ 下载内容: "${content}"`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('7b. Mock 服务器: 跟随 302 重定向', async () => {
  await createMockServer({
    '/redirect': (req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', 'http://127.0.0.1:' + mockServerPort + '/final');
      res.end();
    },
    '/final': (req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Length', '13');
      res.end('Hello, World!');
    }
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
  const destPath = path.join(tmpDir, 'test-redirect.txt');

  try {
    const redirectUrl = `http://127.0.0.1:${mockServerPort}/redirect`;
    const result = await downloadFromUrl(redirectUrl, destPath, null);
    assert.strictEqual(result, destPath, '应该返回目标路径');

    const content = fs.readFileSync(destPath, 'utf8');
    assert.strictEqual(content, 'Hello, World!', '应该跟随重定向并下载完整内容');
    console.log('   ✓ 成功跟随 302 重定向并下载文件');
    console.log(`   ✓ 下载内容: "${content}"`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('8. Mock 服务器: 下载失败时清理文件并回退', async () => {
  await createMockServer({
    '/fail-404': (req, res) => {
      res.statusCode = 404;
      res.end('Not Found');
    },
    '/success': (req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Length', '7');
      res.end('Success');
    }
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
  const destPath = path.join(tmpDir, 'test-download.txt');

  try {
    // 测试直接下载失败
    const failUrl = `http://127.0.0.1:${mockServerPort}/fail-404`;
    await assert.rejects(
      () => downloadFromUrl(failUrl, destPath, null),
      /HTTP 404/,
      '应该拒绝失败的下载'
    );
    console.log('   ✓ 下载 404 时正确拒绝');

    // 测试回退到下一个 URL
    const urls = ['http://127.0.0.1:' + mockServerPort + '/fail-404', 'http://127.0.0.1:' + mockServerPort + '/success'];
    // 手动测试回退逻辑
    let success = false;
    for (let i = 0; i < urls.length; i++) {
      try {
        await downloadFromUrl(urls[i], destPath, null);
        success = true;
        break;
      } catch {
        continue;
      }
    }
    assert.strictEqual(success, true, '应该至少有一个 URL 成功');
    const content = fs.readFileSync(destPath, 'utf8');
    assert.strictEqual(content, 'Success', '应该下载成功的内容');
    console.log('   ✓ 回退到第二个 URL 并成功下载');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('9. Mock 服务器: bodyReceived 标志防止错误 resolve', async () => {
  await createMockServer({
    '/partial': (req, res) => {
      // 发送部分内容后断开
      res.statusCode = 200;
      res.setHeader('Content-Length', '100');
      res.write('partial');
      req.on('close', () => {
        // 客户端断开
      });
      // 不发送 end，模拟下载中断
      setTimeout(() => {
        res.destroy();
      }, 100);
    }
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
  const destPath = path.join(tmpDir, 'test-partial.txt');

  try {
    const url = `http://127.0.0.1:${mockServerPort}/partial`;
    // 这个测试验证 bodyReceived 标志的工作
    // 由于 res.destroy() 不会触发 'end'，bodyReceived 应该保持 false
    await assert.rejects(
      () => downloadFromUrl(url, destPath, null),
      '应该拒绝不完整的下载'
    );
    console.log('   ✓ bodyReceived 标志正确防止了不完整下载的 resolve');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('10. 多代理回退: 所有代理失败时拒绝', async () => {
  // 使用不存在的域名测试所有代理失败
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
  const destPath = path.join(tmpDir, 'test-fail.txt');

  try {
    const fakeUrl = 'https://this-domain-does-not-exist-xyz123.com/file.exe';
    await assert.rejects(
      () => downloadWithProxies(fakeUrl, destPath, null, { proxies: PROXIES }),
      /All download mirrors exhausted/,
      '应该拒绝所有代理都失败的情况'
    );
    console.log('   ✓ 所有代理失败时正确拒绝');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('11. 小型文件真实下载测试', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
  const destPath = path.join(tmpDir, 'test-small.txt');

  try {
    // 从一个可靠的源下载一个小文件
    const smallUrl = 'https://raw.githubusercontent.com/renquanpake/deepseek-harness-desktop/main/README.md';
    const urls = buildProxyedUrls(smallUrl, PROXIES);

    let success = false;
    let progressCalls = 0;
    for (let i = 0; i < urls.length; i++) {
      try {
        await downloadFromUrl(urls[i], destPath, (pct) => {
          progressCalls++;
        });
        success = true;
        break;
      } catch {
        continue;
      }
    }
    assert.strictEqual(success, true, '应该至少有一个 URL 成功');

    const content = fs.readFileSync(destPath, 'utf8');
    assert.ok(content.length > 0, '应该有内容');
    assert.ok(content.includes('DeepSeek'), '应该包含项目相关内容');
    console.log(`   ✓ 从 ${urls.length} 个候选 URL 中成功下载`);
    console.log(`   ✓ 文件大小: ${content.length} 字节`);
    console.log(`   ✓ 进度回调调用次数: ${progressCalls}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('12. 完整更新流程模拟', async () => {
  // 模拟完整的更新检查流程
  console.log('   🔄 开始完整更新流程模拟...');

  // Step 1: 获取当前版本（模拟）
  const currentCoreVersion = '0.0.1';
  const currentShellVersion = '0.0.1';
  console.log(`   [1/6] 当前核心版本: ${currentCoreVersion}`);
  console.log(`   [2/6] 当前外壳版本: ${currentShellVersion}`);

  // Step 2: 检查远程版本
  const remoteCore = await checkRemoteCoreVersion();
  const remoteShell = await checkRemoteShellVersion();
  console.log(`   [3/6] 远程核心版本: ${remoteCore || '未获取'}`);
  console.log(`   [4/6] 远程外壳版本: ${remoteShell || '未获取'}`);

  // Step 3: 决策更新计划
  const plan = decideUpdatePlan({
    core: { currentVersion: currentCoreVersion, remoteVersion: remoteCore },
    shell: { currentVersion: currentShellVersion, remoteVersion: remoteShell }
  });
  console.log(`   [5/6] 更新计划: ${JSON.stringify(plan)}`);

  // Step 4: 检查 Release 资产
  if (plan.shellNeedsUpdate) {
    const release = await checkRemoteReleaseAssets();
    if (release) {
      console.log(`   [6/6] Release 资产: ${release.tag}`);
      console.log(`         安装包: ${release.installerUrl}`);
    }
  }

  // 验证
  if (remoteCore && remoteShell) {
    assert.ok(plan.hasUpdate, '应该检测到更新');
    console.log('   ✓ 完整更新流程模拟成功');
  } else {
    console.log('   ⚠ 部分版本检查失败，跳过完整流程验证');
  }
});

// ===== 清理 =====

after(async () => {
  await Promise.all(mockServers.map((server) => new Promise((done) => {
    server.closeAllConnections();
    server.close(() => done());
  })));
});
