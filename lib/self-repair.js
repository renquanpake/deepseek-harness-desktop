'use strict';

const fs = require('fs');
const path = require('path');
const { cleanStaleLocks } = require('./lock-cleaner');
const { hydratePresetPlugins } = require('./preset-hydrator');

function runSelfRepair({ dshHome, runtimeDir, killOrphanProcess = null } = {}) {
  const report = {
    repaired: false,
    actions: [],
    details: []
  };

  try {
    // 1. 清理死锁文件 (.lock)
    if (dshHome && fs.existsSync(dshHome)) {
      const cleaned = cleanStaleLocks(dshHome);
      if (cleaned > 0) {
        report.actions.push(`已清理 ${cleaned} 个异常残留的进程死锁文件`);
        report.details.push({ item: 'lock-cleaner', count: cleaned });
      }
    }

    // 2. 检查并移除熔断标记 (.broken-marker.json)
    const markerLocations = [
      dshHome ? path.join(dshHome, 'local-runtime', '.broken-marker.json') : null,
      runtimeDir ? path.join(runtimeDir, '.broken-marker.json') : null,
      dshHome ? path.join(dshHome, '.broken-marker.json') : null
    ].filter(Boolean);

    let removedMarkers = 0;
    for (const markerPath of markerLocations) {
      if (fs.existsSync(markerPath)) {
        try {
          fs.unlinkSync(markerPath);
          removedMarkers++;
        } catch {}
      }
    }
    if (removedMarkers > 0) {
      report.actions.push(`已解封并清除 ${removedMarkers} 处临时熔断阻塞标记`);
      report.details.push({ item: 'broken-markers', count: removedMarkers });
    }

    // 3. 修复预置工作台插件配置 (重新深度合并)
    if (runtimeDir) {
      const presetDir = path.join(runtimeDir, 'default-profile');
      if (fs.existsSync(presetDir)) {
        const hydRes = hydratePresetPlugins(presetDir, dshHome);
        if (hydRes.hydrated) {
          report.actions.push('已校准并修复出厂预置插件配置');
          report.details.push({ item: 'plugin-hydration', mode: hydRes.mode });
        }
      }
    }

    // 4. 清理孤儿进程句柄
    if (typeof killOrphanProcess === 'function') {
      try {
        killOrphanProcess();
        report.actions.push('已重置并清理后台进程句柄');
      } catch {}
    }

    report.repaired = report.actions.length > 0;
    return report;
  } catch (err) {
    report.error = err.message;
    return report;
  }
}

module.exports = { runSelfRepair };
