'use strict';

const http = require('node:http');

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>DSH e2e fixture</title>
</head>
<body>
  <main id="app">fixture-ready</main>
  <script>
    window.__probe = { bridge: typeof window.dshDesktop === 'object' && window.dshDesktop !== null };
    if (window.__probe.bridge && typeof window.dshDesktop.getRuntimeInfo === 'function') {
      window.dshDesktop.getRuntimeInfo().then(function (info) {
        window.__probe.info = info;
        window.__probe.ok = true;
      }).catch(function (err) {
        window.__probe.error = String(err && err.message ? err.message : err);
      });
    } else {
      window.__probe.error = 'bridge-missing';
    }
  </script>
</body>
</html>
`;

function createFixtureServer() {
  const requests = [];
  let server = null;
  let baseUrl = null;

  function handler(request, response) {
    requests.push({ method: request.method, url: request.url });
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(PAGE);
      return;
    }
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer(handler);
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}/`;
        resolve(baseUrl);
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = null;
      baseUrl = null;
    });
  }

  return {
    start,
    stop,
    requests,
    getBaseUrl: () => baseUrl
  };
}

module.exports = { createFixtureServer, PAGE };
