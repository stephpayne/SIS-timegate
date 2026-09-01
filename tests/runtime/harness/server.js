'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const host = '127.0.0.1';
const staticPort = Number(process.env.SCORM_HARNESS_PORT || 4173);
const telemetryPort = staticPort + 1;
const root = path.resolve(__dirname, '../../..');
const telemetryRequests = [];

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw new Error('request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const staticServer = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${host}:${staticPort}`);
  if (requestUrl.pathname === '/__health') {
    sendJson(response, 200, { ok: true, staticPort, telemetryPort });
    return;
  }
  if (requestUrl.pathname === '/__telemetry') {
    if (request.method === 'DELETE' || request.method === 'POST') {
      telemetryRequests.length = 0;
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 200, telemetryRequests);
    return;
  }

  let relativePath;
  try {
    relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
  } catch (error) {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }
  if (!relativePath) relativePath = 'tests/runtime/harness/index.html';
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  try {
    if (
      relativePath === 'src/timegate.config.json' &&
      String(request.headers.referer || '').includes(
        '/tests/runtime/harness/timegate-production-order.html'
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    const body = await fs.readFile(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type':
        contentTypes[path.extname(filePath).toLowerCase()] ||
        'application/octet-stream',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(error && error.code === 'ENOENT' ? 404 : 500, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end(error && error.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
});

const telemetryServer = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${host}:${telemetryPort}`);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    response.end();
    return;
  }
  if (requestUrl.pathname !== '/telemetry' || request.method !== 'POST') {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  try {
    const body = await readBody(request);
    telemetryRequests.push({
      body,
      mode: request.headers['sec-fetch-mode'] || '',
      origin: request.headers.origin || '',
      receivedAt: new Date().toISOString(),
    });
  } catch (error) {
    response.writeHead(413);
    response.end('Too large');
    return;
  }

  const mode = requestUrl.searchParams.get('mode') || 'ok';
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  };
  if (mode !== 'cors-fallback') headers['Access-Control-Allow-Origin'] = '*';
  response.writeHead(202, headers);
  response.end('accepted');
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

function close() {
  staticServer.close();
  telemetryServer.close();
}

Promise.all([
  listen(staticServer, staticPort),
  listen(telemetryServer, telemetryPort),
]).then(() => {
  process.stdout.write(
    `SCORM harness: http://${host}:${staticPort} (telemetry ${telemetryPort})\n`,
  );
}, (error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

process.on('SIGINT', close);
process.on('SIGTERM', close);
