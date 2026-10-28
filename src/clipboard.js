'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { toWslPath } = require('../lib/win-utils');

function createClipboardBridge({
  clipboard,
  getMainWindow,
  getPortableDataRoot,
  getEngine,
  isWindowsPlatform
}) {
  function saveClipboardImage(image) {
    const portableRoot = getPortableDataRoot();
    const captureDir = portableRoot
      ? path.join(portableRoot, 'temp-captures')
      : path.join(os.tmpdir(), 'dsh-studio-captures');
    const target = path.join(
      captureDir,
      `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
    );
    try {
      fs.mkdirSync(captureDir, { recursive: true });
      fs.writeFileSync(target, image.toPNG());
      console.warn(`[clipboard] 截图已落盘: ${target}`);
      return target;
    } catch (err) {
      console.warn(`[clipboard] 截图落盘失败: ${err.message}`);
      return null;
    }
  }

  function convertToWslMountPath(windowsPath) {
    if (typeof windowsPath !== 'string' || !windowsPath.trim()) return windowsPath;
    return toWslPath(windowsPath.trim());
  }

  function feedClipboardIntoEditor() {
    const mainWindow = getMainWindow();
    if (!mainWindow || !mainWindow.webContents) return;
    if (getEngine() === 'wsl2' && isWindowsPlatform()) {
      try {
        const image = clipboard.readImage();
        if (image && !image.isEmpty()) {
          const imagePath = saveClipboardImage(image);
          if (imagePath) {
            mainWindow.webContents.send('dsh:inject-clipboard-text', convertToWslMountPath(imagePath));
            return;
          }
        }
      } catch (err) {
        console.warn(`[clipboard] 读取剪贴板截图失败: ${err.message}`);
      }
    }
    let text = '';
    try {
      text = clipboard.readText() || '';
    } catch (err) {
      console.warn(`[clipboard] 读取剪贴板文本失败: ${err.message}`);
    }
    if (text) {
      mainWindow.webContents.send('dsh:inject-clipboard-text', text);
    }
  }

  return { saveClipboardImage, convertToWslMountPath, feedClipboardIntoEditor };
}

module.exports = { createClipboardBridge };
