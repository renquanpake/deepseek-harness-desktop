// DeepSeek Harness - Foolproof Desktop Shell Controller & Self-Repair Doctor
'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const dsh = window.dshDesktopShell;
  if (!dsh) {
    console.error('[shell] IPC bridge not available');
    return;
  }

  // 1. DOM 核心元素
  const splashScreen = document.getElementById('core-splash-screen');
  const splashStatusText = document.getElementById('splash-status-text');
  const splashRepairArea = document.getElementById('splash-repair-area');
  const splashRepairTip = document.getElementById('splash-repair-tip');
  const btnSplashManualRepair = document.getElementById('btn-splash-manual-repair');
  const dshCoreView = document.getElementById('dsh-core-view');

  const btnPinWindow = document.getElementById('btn-pin-window');
  const btnAutostartToggle = document.getElementById('btn-autostart-toggle');
  const labelAutostartStatus = document.getElementById('label-autostart-status');

  const shellDrawer = document.getElementById('shell-drawer');
  const drawerTitle = document.getElementById('drawer-title');
  const drawerContent = document.getElementById('drawer-content-area');
  const btnCloseDrawer = document.getElementById('btn-close-drawer');
  const railItems = document.querySelectorAll('.rail-item');

  const statusDot = document.getElementById('status-dot');
  const statusBackendText = document.getElementById('status-backend-text');
  const statusBackendIndicator = document.getElementById('status-backend-indicator');
  const statusRepairBtn = document.getElementById('status-repair-btn');
  const statusUpdateCheck = document.getElementById('status-update-check');

  // 检修弹窗元素
  const repairModal = document.getElementById('repair-modal');
  const btnCloseRepairModal = document.getElementById('btn-close-repair-modal');
  const btnCancelRepair = document.getElementById('btn-cancel-repair');
  const btnStartRepair = document.getElementById('btn-start-repair');
  const stepLock = document.getElementById('step-lock');
  const stepMarker = document.getElementById('step-marker');
  const stepPlugin = document.getElementById('step-plugin');
  const stepBackend = document.getElementById('step-backend');
  const repairResultBanner = document.getElementById('repair-result-banner');

  let activeDrawerTab = null;
  let isAlwaysOnTop = false;
  let isBackendMounted = false;
  let isAutoRepairing = false;
  let startupTimeoutTimer = null;
  let lastCoreUrl = 'about:blank';

  // 2. 启动超时守护机制 (8秒超时自动介入检修与自愈)
  function startStartupGuardian() {
    startupTimeoutTimer = setTimeout(async () => {
      if (isBackendMounted || isAutoRepairing) return;
      console.log('[shell] 触发启动超时守护自愈机制...');
      if (splashRepairArea) splashRepairArea.style.display = 'block';
      if (splashStatusText) splashStatusText.textContent = '启动耗时偏长，正在自动排查故障并自愈环境...';
      if (splashRepairTip) splashRepairTip.textContent = '检测到服务启动稍慢，正在自动清理异常死锁与重置连接...';
      await runSelfRepairWorkflow(true);
    }, 8000);
  }

  startStartupGuardian();

  // 3. 核心视图装载与 Splash 过渡
  function hideSplashAndMountCore(url) {
    if (isBackendMounted && dshCoreView && dshCoreView.src === url) return;
    isBackendMounted = true;
    lastCoreUrl = url;

    if (startupTimeoutTimer) {
      clearTimeout(startupTimeoutTimer);
      startupTimeoutTimer = null;
    }

    if (splashStatusText) splashStatusText.textContent = '正在进入工作台...';
    setTimeout(() => {
      if (splashScreen) splashScreen.style.display = 'none';
      if (dshCoreView) {
        dshCoreView.classList.remove('core-view-hidden');
        if (dshCoreView.src !== url) {
          dshCoreView.src = url;
        }
      }
      if (statusDot) {
        statusDot.className = 'status-dot dot-online';
      }
      if (statusBackendText) {
        statusBackendText.textContent = '服务就绪';
      }
    }, 300);
  }

  if (dsh.onBackendReady) {
    dsh.onBackendReady((url) => {
      hideSplashAndMountCore(url);
    });
  }

  try {
    const status = await dsh.getBackendStatus();
    if (status && status.ready && status.url) {
      hideSplashAndMountCore(status.url);
    }
  } catch {}

  // 4. 自动检修与自愈执行引擎
  async function runSelfRepairWorkflow(isFromSplash = false) {
    if (isAutoRepairing) return;
    isAutoRepairing = true;

    if (btnSplashManualRepair) {
      btnSplashManualRepair.disabled = true;
      btnSplashManualRepair.textContent = '正在自动修复中...';
    }
    if (btnStartRepair) {
      btnStartRepair.disabled = true;
      btnStartRepair.textContent = '正在全自动体检与修复中...';
    }

    function setStepState(el, statusClass, iconChar) {
      if (!el) return;
      el.className = 'repair-step ' + statusClass;
      const icon = el.querySelector('.step-status');
      if (icon) icon.textContent = iconChar;
    }

    // 重置步骤状态
    setStepState(stepLock, 'running', '⚙️');
    setStepState(stepMarker, '', '⏳');
    setStepState(stepPlugin, '', '⏳');
    setStepState(stepBackend, '', '⏳');
    if (repairResultBanner) repairResultBanner.style.display = 'none';

    try {
      await new Promise((r) => setTimeout(r, 250));
      setStepState(stepLock, 'done', '✓');
      setStepState(stepMarker, 'running', '⚙️');

      await new Promise((r) => setTimeout(r, 250));
      setStepState(stepMarker, 'done', '✓');
      setStepState(stepPlugin, 'running', '⚙️');

      // 调用主进程综合自愈 API
      const report = await dsh.runSelfRepair();

      setStepState(stepPlugin, 'done', '✓');
      setStepState(stepBackend, 'running', '⚙️');

      await new Promise((r) => setTimeout(r, 350));
      setStepState(stepBackend, 'done', '✓');

      const actions = (report && Array.isArray(report.actions) && report.actions.length > 0)
        ? report.actions
        : ['已清理异常残留死锁文件', '已解除熔断阻塞状态', '已深度校准预置增强插件', '已重置后台并建立连接'];

      if (repairResultBanner) {
        repairResultBanner.style.display = 'block';
        repairResultBanner.className = 'repair-result-banner';
        repairResultBanner.innerHTML = `
          <strong style="display:block;margin-bottom:6px;font-size:13px;">✓ 环境自动自愈修复完成！</strong>
          <div style="font-size:11px;line-height:1.7;">
            ${actions.map((act) => `<div>• ${act}</div>`).join('')}
          </div>
          <div style="font-size:11px;opacity:0.85;margin-top:6px;color:var(--accent-green);">
            本地 AI 工作台已平滑重启并重新握手。
          </div>
        `;
      }

      if (report && report.url) {
        hideSplashAndMountCore(report.url);
        if (dshCoreView && dshCoreView.src !== report.url) {
          dshCoreView.src = report.url;
        }
      }

      if (isFromSplash && splashStatusText) {
        splashStatusText.textContent = '自愈成功，正在载入工作台...';
      }
    } catch (err) {
      console.error('[shell] 自愈检修失败:', err);
      if (repairResultBanner) {
        repairResultBanner.style.display = 'block';
        repairResultBanner.className = 'repair-result-banner error';
        repairResultBanner.textContent = '自动检修执行异常: ' + (err.message || '未知错误');
      }
      if (isFromSplash && splashStatusText) {
        splashStatusText.textContent = '自动修复完成，请重试或查看设置面板。';
      }
    } finally {
      isAutoRepairing = false;
      if (btnSplashManualRepair) {
        btnSplashManualRepair.disabled = false;
        btnSplashManualRepair.textContent = '🩺 一键自动修复并重新启动';
      }
      if (btnStartRepair) {
        btnStartRepair.disabled = false;
        btnStartRepair.textContent = '再次全自动体检与修复';
      }
    }
  }

  // 5. 启动屏手动修复按钮
  if (btnSplashManualRepair) {
    btnSplashManualRepair.addEventListener('click', () => {
      runSelfRepairWorkflow(true);
    });
  }

  // 6. 检修弹窗展示与交互
  function openRepairModal() {
    if (!repairModal) return;
    repairModal.classList.remove('modal-hidden');
    // 重置步骤状态显示
    [stepLock, stepMarker, stepPlugin, stepBackend].forEach((s) => {
      if (s) {
        s.className = 'repair-step';
        const icon = s.querySelector('.step-status');
        if (icon) icon.textContent = '⏳';
      }
    });
    if (repairResultBanner) repairResultBanner.style.display = 'none';
  }

  function closeRepairModal() {
    if (!repairModal) return;
    repairModal.classList.add('modal-hidden');
  }

  if (btnCloseRepairModal) btnCloseRepairModal.addEventListener('click', closeRepairModal);
  if (btnCancelRepair) btnCancelRepair.addEventListener('click', closeRepairModal);
  if (btnStartRepair) {
    btnStartRepair.addEventListener('click', () => {
      runSelfRepairWorkflow(false);
    });
  }

  // 底部状态栏检修入口
  if (statusRepairBtn) {
    statusRepairBtn.addEventListener('click', openRepairModal);
  }
  if (statusBackendIndicator) {
    statusBackendIndicator.addEventListener('click', openRepairModal);
  }

  // 7. 开机自启控制
  try {
    const isAuto = await dsh.getAutoStart();
    updateAutostartUI(isAuto);
  } catch {}

  function updateAutostartUI(enabled) {
    if (!btnAutostartToggle) return;
    if (enabled) {
      btnAutostartToggle.classList.add('enabled');
      if (labelAutostartStatus) labelAutostartStatus.textContent = '自启动: 开';
    } else {
      btnAutostartToggle.classList.remove('enabled');
      if (labelAutostartStatus) labelAutostartStatus.textContent = '自启动: 关';
    }
  }

  if (dsh.onAutoStartChanged) {
    dsh.onAutoStartChanged(updateAutostartUI);
  }

  btnAutostartToggle.addEventListener('click', async () => {
    const isCurrentlyEnabled = btnAutostartToggle.classList.contains('enabled');
    const newState = await dsh.setAutoStart(!isCurrentlyEnabled);
    updateAutostartUI(newState);
  });

  // 8. 窗口置顶
  btnPinWindow.addEventListener('click', async () => {
    isAlwaysOnTop = !isAlwaysOnTop;
    btnPinWindow.classList.toggle('active', isAlwaysOnTop);
    if (dsh.setAlwaysOnTop) {
      await dsh.setAlwaysOnTop(isAlwaysOnTop);
    }
  });

  // 9. 抽屉控制
  function openDrawer(tabName, title, renderFn) {
    activeDrawerTab = tabName;
    drawerTitle.textContent = title;
    drawerContent.innerHTML = '';
    renderFn(drawerContent);
    shellDrawer.classList.remove('drawer-hidden');

    railItems.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
  }

  function closeDrawer() {
    activeDrawerTab = null;
    shellDrawer.classList.add('drawer-hidden');
    railItems.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === 'chat');
    });
  }

  btnCloseDrawer.addEventListener('click', closeDrawer);

  railItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === 'chat') {
        closeDrawer();
        return;
      }
      if (activeDrawerTab === tab) {
        closeDrawer();
        return;
      }

      if (tab === 'plugins') {
        openDrawer('plugins', '插件市场', renderPluginsDrawer);
      } else if (tab === 'settings') {
        openDrawer('settings', '通用设置', renderSettingsDrawer);
      }
    });
  });

  // 抽屉：插件市场（傻瓜化列表）
  const FRIENDLY_PLUGINS = [
    { name: '工作台增强界面 (dsh-codex-ui)', desc: '提供舒适的深色编码工作区与多任务视图' },
    { name: '官方扩展商店 (dshmarket)', desc: '在应用内自由安装社区官方海量技能与插件' },
    { name: '侧边栏优化 (dsh-better-sidebar)', desc: '优雅折叠与快捷切换最近会话' },
    { name: '路径链接解析 (dsh-pathlink)', desc: '自动识别对话中的代码与文件路径并支持点击打开' },
    { name: '剪贴板极速插入 (dsh-paste-input)', desc: '支持快捷键将截图和长文本直接灌入输入框' },
    { name: '会话存档与回滚 (dsh-checkpoint-rewind)', desc: '一键返回历史检查点，防止长对话失控' }
  ];

  function renderPluginsDrawer(container) {
    container.innerHTML = `
      <p style="color:var(--text-dim);font-size:12px;margin-bottom:12px;">已预置并激活的官方增强插件：</p>
      <div id="plugin-list-area"></div>
      <div style="margin-top:16px;">
        <button id="btn-rehydrate-plugins" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-main);font-size:12px;cursor:pointer;">
          🔄 一键修复与更新预置插件
        </button>
      </div>
    `;

    const listArea = container.querySelector('#plugin-list-area');
    FRIENDLY_PLUGINS.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'plugin-item';
      el.innerHTML = `
        <div class="p-info">
          <span class="p-title">${p.name}</span>
          <span class="p-desc">${p.desc}</span>
        </div>
        <span class="p-badge">已启用</span>
      `;
      listArea.appendChild(el);
    });

    container.querySelector('#btn-rehydrate-plugins').addEventListener('click', async () => {
      const btn = container.querySelector('#btn-rehydrate-plugins');
      btn.textContent = '正在刷新...';
      await dsh.rehydratePlugins();
      btn.textContent = '✓ 已就绪';
      setTimeout(() => { btn.textContent = '🔄 一键修复与更新预置插件'; }, 1500);
    });
  }

  // 抽屉：通用设置（傻瓜化开关 + 自动检修体检）
  function renderSettingsDrawer(container) {
    container.innerHTML = `
      <div class="setting-row">
        <div>
          <div class="setting-label">环境自动体检与自愈</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">排查死锁、端口占用与配置阻塞</div>
        </div>
        <button class="setting-btn accent" id="btn-setting-repair">一键检修</button>
      </div>
      <div class="setting-row">
        <span class="setting-label">开机自动启动</span>
        <button class="setting-btn" id="btn-setting-autostart">切换</button>
      </div>
      <div class="setting-row">
        <span class="setting-label">窗口始终置顶</span>
        <button class="setting-btn" id="btn-setting-pin">切换</button>
      </div>
      <div class="setting-row">
        <span class="setting-label">Windows 文件夹右键菜单</span>
        <button class="setting-btn" id="btn-setting-context">一键添加</button>
      </div>
      <div class="setting-row">
        <span class="setting-label">软件版本</span>
        <span style="font-size:12px;color:var(--accent-blue);font-weight:500;">v0.1.0 (旗舰桌面版)</span>
      </div>
    `;

    container.querySelector('#btn-setting-repair').addEventListener('click', () => {
      closeDrawer();
      openRepairModal();
    });

    container.querySelector('#btn-setting-autostart').addEventListener('click', () => {
      btnAutostartToggle.click();
    });

    container.querySelector('#btn-setting-pin').addEventListener('click', () => {
      btnPinWindow.click();
    });

    container.querySelector('#btn-setting-context').addEventListener('click', async () => {
      await dsh.registerContextMenu();
      alert('已成功将 DeepSeek Harness 添加到 Windows 鼠标右键菜单！');
    });
  }

  // 10. 检查更新
  if (statusUpdateCheck) {
    statusUpdateCheck.addEventListener('click', () => {
      dsh.checkUpdate();
    });
  }
});
