import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { generateDemo } from '../src/usage.js';

function appForTest() {
  const usageService = {
    generateDemo: () => generateDemo(Date.parse('2026-05-13T00:00:00.000Z')),
    getLiveUsage: async () => generateDemo(Date.parse('2026-05-13T00:00:00.000Z')),
    getCachedUsage: () => null,
    getRawSnapshot: () => null,
    getCacheStatus: () => ({ has_cache: false, cache_age_seconds: null, fetched_at: null }),
    diagnoseCredentials: () => ({ ok: true, source: 'test' }),
  };
  const app = createApp({
    config: {
      host: '127.0.0.1',
      port: 8787,
      bridgeToken: '',
      cacheTtlMs: 60_000,
      loggerLevel: 'silent',
      production: true,
    },
    usageService,
  });
  return { app };
}

test('status endpoint exposes browser-managed Bluetooth setup state', async () => {
  const { app } = appForTest();
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.auth.ok, true);
  assert.equal(body.transports.bluetooth.kind, 'web-bluetooth');
  assert.equal(body.transports.bluetooth.device_name, 'Claude-Usage');
  assert.equal(body.transports.usb, undefined);
  await app.close();
});

test('native push endpoint is retired in favor of Web Bluetooth', async () => {
  const { app } = appForTest();
  const res = await app.inject({ method: 'POST', url: '/api/push?mode=demo' });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json().error, 'browser_bluetooth_only');
  await app.close();
});

test('device payload endpoint returns the Web Bluetooth line format', async () => {
  const { app } = appForTest();
  const res = await app.inject({ method: 'GET', url: '/api/device-payload?force=1' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.line.endsWith('\n'), true);
  assert.equal(body.payload.v, 1);
  assert.equal(Number.isInteger(body.payload.fs), true);
  await app.close();
});
