import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { generateDemo } from '../src/usage.js';

function fakeManager(kind) {
  const state = {
    connected: false,
    writes: [],
  };
  return {
    state,
    isConnected: () => state.connected,
    status: () => ({
      kind,
      state: state.connected ? 'connected' : 'idle',
      connected: state.connected,
      bytes_written: state.writes.reduce((sum, item) => sum + item.length, 0),
    }),
    connect: async () => {
      state.connected = true;
      return { connected: true };
    },
    disconnect: async () => {
      state.connected = false;
      return { connected: false };
    },
    write: async (line) => {
      state.writes.push(line);
      return { ok: true, bytes: Buffer.byteLength(line) };
    },
    listPorts: async () => [],
  };
}

function appForTest() {
  const usageService = {
    generateDemo: () => generateDemo(Date.parse('2026-05-13T00:00:00.000Z')),
    getLiveUsage: async () => generateDemo(Date.parse('2026-05-13T00:00:00.000Z')),
    getCachedUsage: () => null,
    getRawSnapshot: () => null,
    getCacheStatus: () => ({ has_cache: false, cache_age_seconds: null, fetched_at: null }),
    diagnoseCredentials: () => ({ ok: true, source: 'test' }),
  };
  const ble = fakeManager('ble');
  const usb = fakeManager('usb');
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
    bleManager: ble,
    usbManager: usb,
  });
  return { app, ble, usb };
}

test('status endpoint exposes setup state', async () => {
  const { app } = appForTest();
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.auth.ok, true);
  await app.close();
});

test('push endpoint writes newline framed payload to connected transports', async () => {
  const { app, ble } = appForTest();
  ble.state.connected = true;

  const res = await app.inject({ method: 'POST', url: '/api/push?mode=demo&target=ble' });
  assert.equal(res.statusCode, 200);
  assert.equal(ble.state.writes.length, 1);
  assert.equal(ble.state.writes[0].endsWith('\n'), true);
  assert.equal(res.json().results[0].ok, true);
  await app.close();
});
