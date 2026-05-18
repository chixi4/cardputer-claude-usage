import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { generateDemo } from '../src/usage.js';

function appForTest(overrides = {}) {
  const usageService = {
    generateDemo: () => generateDemo(Date.parse('2026-05-13T00:00:00.000Z')),
    getLiveUsage: async () => generateDemo(Date.parse('2026-05-13T00:00:00.000Z')),
    getCachedUsage: () => null,
    getRawSnapshot: () => null,
    getCacheStatus: () => ({ has_cache: false, cache_age_seconds: null, fetched_at: null }),
    diagnoseCredentials: () => ({ ok: true, source: 'test' }),
    logoutCredentials: () => ({ ok: true, source: 'test', action: 'test-logout' }),
    ...overrides,
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

test('device payload reports subscription loss without stale quota values', async () => {
  const { app } = appForTest({
    diagnoseCredentials: () => ({
      ok: false,
      source: 'test',
      needs_subscription: true,
      error: 'Claude Pro/Max required',
    }),
  });
  const res = await app.inject({ method: 'GET', url: '/api/device-payload?force=1' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.usage.status, 'subscription_required');
  assert.equal(body.usage.stale, false);
  assert.equal(body.payload.cu, null);
  assert.equal(body.payload.wu, null);
  assert.equal(body.payload.err, 'Pro/Max required');
  await app.close();
});

test('device payload reports organization OAuth denial without stale quota values', async () => {
  const { app } = appForTest({
    diagnoseCredentials: () => ({ ok: true, source: 'test' }),
    getLiveUsage: async () => {
      throw new Error('Claude Code OAuth not allowed');
    },
  });
  const res = await app.inject({ method: 'GET', url: '/api/device-payload?force=1' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.usage.status, 'auth_required');
  assert.equal(body.usage.stale, false);
  assert.equal(body.payload.cu, null);
  assert.equal(body.payload.wu, null);
  assert.equal(body.payload.err, 'OAuth not allowed');
  await app.close();
});

test('auth logout endpoint clears active credentials through usage service', async () => {
  let called = false;
  const { app } = appForTest({
    logoutCredentials: () => {
      called = true;
      return { ok: true, source: 'test', action: 'test-logout' };
    },
  });
  const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().action, 'test-logout');
  assert.equal(called, true);
  await app.close();
});

test('auth logout endpoint reports environment credentials as not removable', async () => {
  const { app } = appForTest({
    logoutCredentials: () => {
      const error = new Error('unset CLAUDE_USAGE_ACCESS_TOKEN');
      error.code = 'environment_credentials';
      throw error;
    },
  });
  const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'logout_failed');
  await app.close();
});

test('debug log endpoint stores browser diagnostic events', async () => {
  const { app } = appForTest();
  const post = await app.inject({
    method: 'POST',
    url: '/api/debug/events',
    payload: {
      events: [
        { event: 'ble-test', message: 'connect', step: 2, detail: { connected: false } },
        { event: 'sync-test', message: 'payload', step: 3 },
      ],
    },
  });
  assert.equal(post.statusCode, 200);
  assert.equal(post.json().accepted, 2);

  const res = await app.inject({ method: 'GET', url: '/api/debug/logs?limit=10' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.logs.some((entry) => entry.event === 'browser:ble-test'), true);
  assert.equal(body.logs.some((entry) => entry.event === 'browser:sync-test'), true);
  await app.close();
});
