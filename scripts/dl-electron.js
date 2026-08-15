// 从 npmmirror 下载 electron 二进制（Node https，带重试）
const https = require('https');
const fs = require('fs');
const path = require('path');

const URL = 'https://npmmirror.com/mirrors/electron/33.4.11/electron-v33.4.11-win32-x64.zip';
const OUT = path.join(__dirname, 'electron.zip');

function download(resume = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(URL, {
      headers: resume > 0 ? { Range: `bytes=${resume}-` } : {},
      timeout: 30000,
    }, (res) => {
      if (res.statusCode === 200 || res.statusCode === 206) {
        const total = parseInt(res.headers['content-length'] || '0', 10) + resume;
        const fd = fs.openSync(OUT, resume > 0 ? 'a' : 'w');
        let received = resume;
        let lastLog = Date.now();
        res.on('data', (chunk) => {
          fs.writeSync(fd, chunk);
          received += chunk.length;
          if (Date.now() - lastLog > 5000) {
            console.log(`  ${(received / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB`);
            lastLog = Date.now();
          }
        });
        res.on('end', () => {
          fs.closeSync(fd);
          console.log(`done: ${(received / 1048576).toFixed(1)}MB`);
          resolve(received);
        });
        res.on('error', (e) => { fs.closeSync(fd); reject(e); });
      } else {
        reject(new Error(`HTTP ${res.statusCode}`));
      }
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

(async () => {
  let got = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
  const TARGET = 109.6 * 1048576; // ~109.6MB
  let attempts = 0;
  while (got < TARGET && attempts < 8) {
    attempts++;
    console.log(`attempt ${attempts}, resume from ${(got / 1048576).toFixed(1)}MB`);
    try {
      got = await download(got);
      if (got >= TARGET * 0.99) break;
    } catch (e) {
      console.log('  interrupted:', e.message);
      got = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log(`FINAL: ${(got / 1048576).toFixed(1)}MB`);
})();
