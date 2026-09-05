#!/usr/bin/env node
'use strict';

/*
 * Interactive browser DOM test runner.
 *
 * This deliberately does not launch a browser. It serves only the sortable
 * browser suite and its source file from a loopback-only, ephemeral server,
 * then exits only after that page posts its actual completed result.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_FAILURE_MESSAGES = 50;
const MAX_FAILURE_LINE_LENGTH = 300;
const MAX_PRINTED_FAILURES = 8;
const TIMEOUT_MS = 120000;
const CLOSE_GRACE_MS = 250;
const FORCE_EXIT_AFTER_MS = 1000;
const REPORT_PATH = '/__browser-test-report';
const TEST_PAGE_PATH = path.join(__dirname, 'tests.html');
const SORTABLE_PATH = path.join(__dirname, '..', 'Worker', 'kjr-sortable.js');

function startupFailure(err) {
  const message = err && err.message ? err.message : String(err);
  console.error('[browser-tests] Could not prepare the loopback suite: ' + message);
  process.exitCode = 1;
}

function readAsset(filePath) {
  return fs.readFileSync(filePath);
}

let testPageSource;
let sortableSource;
try {
  testPageSource = readAsset(TEST_PAGE_PATH).toString('utf8');
  sortableSource = readAsset(SORTABLE_PATH);
} catch (err) {
  startupFailure(err);
  return;
}

const token = crypto.randomBytes(32).toString('hex');
const sortableScriptPattern = /(<script\b[^>]*\bsrc=")\.\.\/Worker\/kjr-sortable\.js(?:\?[^"]*)?(")/i;
const tokenisedTestPage = testPageSource.replace(
  sortableScriptPattern,
  '$1/Worker/kjr-sortable.js?test-run=' + token + '$2'
);
if (tokenisedTestPage === testPageSource) {
  startupFailure(new Error('tests.html does not contain the expected sortable script tag'));
  return;
}
const testPageSourceBuffer = Buffer.from(tokenisedTestPage, 'utf8');

function tokenMatches(value) {
  if (typeof value !== 'string' || value.length !== token.length || !/^[a-f0-9]+$/.test(value)) return false;
  return crypto.timingSafeEqual(Buffer.from(value, 'utf8'), Buffer.from(token, 'utf8'));
}

function hasOnlyRunToken(url) {
  const entries = Array.from(url.searchParams.entries());
  return entries.length === 1 && entries[0][0] === 'test-run' && tokenMatches(entries[0][1]);
}

function isLoopbackRequest(req) {
  const address = req.socket && req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function send(res, status, body, headers) {
  const output = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  res.writeHead(status, Object.assign({
    'Cache-Control': 'no-store',
    'Connection': 'close',
    'Content-Length': String(output.length),
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  }, headers || {}));
  res.end(output);
}

function methodNotAllowed(res, allowed) {
  send(res, 405, 'Method not allowed\n', { 'Allow': allowed, 'Content-Type': 'text/plain; charset=utf-8' });
}

function staticHeaders(contentType) {
  return {
    'Content-Security-Policy': "default-src 'none'; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    'Content-Type': contentType
  };
}

function validReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  if (!tokenMatches(report.token) || report.status !== 'complete') return false;
  const values = [report.pass, report.fail, report.total];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return false;
  if (report.total === 0 || report.total !== report.pass + report.fail) return false;
  if (!Array.isArray(report.failures) || report.failures.length !== report.fail || report.failures.length > MAX_FAILURE_MESSAGES) return false;
  return report.failures.every(message => typeof message === 'string' && message.length <= MAX_FAILURE_LINE_LENGTH);
}

function printReport(report) {
  console.log('[browser-tests] ' + report.pass + '/' + report.total + ' passed');
  if (!report.fail) return;
  report.failures.slice(0, MAX_PRINTED_FAILURES).forEach(message => {
    console.error('[browser-tests] FAIL: ' + message.replace(/[\r\n]+/g, ' '));
  });
  if (report.failures.length > MAX_PRINTED_FAILURES) {
    console.error('[browser-tests] ' + (report.failures.length - MAX_PRINTED_FAILURES) + ' further failure message(s) omitted');
  }
}

let finished = false;
let timeoutId = null;
const activeSockets = new Set();
const server = http.createServer((req, res) => {
  if (!isLoopbackRequest(req)) {
    send(res, 403, 'Loopback only\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://' + HOST);
  } catch (_) {
    send(res, 400, 'Bad request\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  if (url.pathname === '/tests.html') {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    if (!hasOnlyRunToken(url)) {
      send(res, 403, 'Invalid test run token\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    send(res, 200, testPageSourceBuffer, staticHeaders('text/html; charset=utf-8'));
    return;
  }

  if (url.pathname === '/Worker/kjr-sortable.js') {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    if (!hasOnlyRunToken(url)) {
      send(res, 403, 'Invalid test run token\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    send(res, 200, sortableSource, staticHeaders('application/javascript; charset=utf-8'));
    return;
  }

  if (url.pathname !== REPORT_PATH) {
    send(res, 404, 'Not found\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  if (url.search) {
    send(res, 400, 'Report query is not allowed\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  const declaredLength = String(req.headers['content-length'] || '');
  if (!contentType.startsWith('application/json')) {
    send(res, 415, 'Expected JSON\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    req.resume();
    return;
  }
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    send(res, 413, 'Report too large\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    req.resume();
    return;
  }

  let bytes = 0;
  let rejected = false;
  const chunks = [];
  req.on('data', chunk => {
    if (rejected) return;
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      rejected = true;
      send(res, 413, 'Report too large\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', () => {
    if (!rejected) {
      rejected = true;
      send(res, 400, 'Report read failed\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });
  req.on('end', () => {
    if (rejected) return;
    let report;
    try {
      report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_) {
      send(res, 400, 'Invalid report JSON\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    if (!validReport(report)) {
      send(res, 400, 'Invalid browser report\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    res.once('finish', () => {
      printReport(report);
      finish(report.fail === 0 ? 0 : 1);
    });
    send(res, 200, '{"ok":true}\n', { 'Content-Type': 'application/json; charset=utf-8' });
  });
});

server.on('connection', socket => {
  activeSockets.add(socket);
  socket.once('close', () => activeSockets.delete(socket));
});

function finish(exitCode) {
  if (finished) return;
  finished = true;
  process.exitCode = exitCode;
  if (timeoutId) clearTimeout(timeoutId);
  if (!server.listening) {
    return;
  }
  let closeFinished = false;
  const onClosed = () => {
    closeFinished = true;
    clearTimeout(closeGrace);
    clearTimeout(forceExit);
    process.exitCode = exitCode;
  };
  const closeGrace = setTimeout(() => {
    if (closeFinished) return;
    activeSockets.forEach(socket => socket.destroy());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }, CLOSE_GRACE_MS);
  const forceExit = setTimeout(() => {
    if (closeFinished) return;
    console.error('[browser-tests] Forced shutdown after the close grace period');
    process.exit(exitCode);
  }, CLOSE_GRACE_MS + FORCE_EXIT_AFTER_MS);
  try {
    server.close(onClosed);
  } catch (_) {
    onClosed();
  }
}

server.on('clientError', (_err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
server.once('error', err => {
  if (!finished) {
    console.error('[browser-tests] Loopback server failed: ' + err.message);
    finish(1);
  }
});

function stopForSignal(signal) {
  if (finished) return;
  console.error('[browser-tests] Stopped by ' + signal);
  finish(130);
}
process.once('SIGINT', () => stopForSignal('SIGINT'));
process.once('SIGTERM', () => stopForSignal('SIGTERM'));

server.listen(0, HOST, () => {
  const address = server.address();
  const testUrl = 'http://' + HOST + ':' + address.port + '/tests.html?test-run=' + token;
  console.log('[browser-tests] Open this URL in a browser to run interactive DOM checks:');
  console.log(testUrl);
  console.log('[browser-tests] Waiting up to ' + Math.round(TIMEOUT_MS / 1000) + ' seconds for the browser result');
  timeoutId = setTimeout(() => {
    console.error('[browser-tests] Timed out without a complete browser report');
    finish(1);
  }, TIMEOUT_MS);
});
