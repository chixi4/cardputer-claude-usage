#!/usr/bin/env node
import { BLEManager } from './src/transports/ble.js';
import { USBManager } from './src/transports/usb.js';
import { getConfig } from './src/config.js';
import { createApp } from './src/server.js';
import { UsageService, generateDemo } from './src/usage.js';

const config = getConfig();
const usageService = new UsageService({
  cacheTtlMs: config.cacheTtlMs,
  requestTimeoutMs: config.requestTimeoutMs,
});
const bleManager = new BLEManager({
  autoConnect: config.ble.autoConnect,
  chunkSize: config.ble.chunkSize,
  scanTimeoutMs: config.ble.scanTimeoutMs,
});
const usbManager = new USBManager({
  baudRate: config.usb.baudRate,
  autoPath: config.usb.path,
});

const app = createApp({
  config,
  usageService,
  bleManager,
  usbManager,
});

async function pushLiveOrStatus() {
  if (!bleManager.isConnected() && !usbManager.isConnected()) return;

  try {
    const data = await usageService.getLiveUsage(false);
    await app.pushToTransports(data);
    app.log.info({
      current: data.current?.remaining_percent ?? null,
      weekly: data.weekly?.remaining_percent ?? null,
    }, 'usage pushed');
  } catch (error) {
    const fallback = usageService.getCachedUsage(true, error.message)
      ?? generateDemo(Date.now(), { status: 'demo', error: error.message });
    await app.pushToTransports(fallback);
    app.log.warn({ err: error.message }, 'usage push fell back');
  }
}

function startTimers() {
  if (config.ble.autoConnect) {
    bleManager.startAutoConnect();
  }

  if (config.usb.autoConnect) {
    usbManager.connect().catch((error) => {
      app.log.warn({ err: error.message }, 'USB auto-connect failed');
    });
  }

  setTimeout(() => {
    pushLiveOrStatus();
    setInterval(pushLiveOrStatus, config.pushIntervalMs).unref?.();
  }, config.initialPushDelayMs).unref?.();
}

process.on('SIGINT', async () => {
  await app.close();
  await bleManager.stop();
  await usbManager.disconnect().catch(() => {});
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await app.close();
  await bleManager.stop();
  await usbManager.disconnect().catch(() => {});
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  app.log.error({ err: error?.message ?? String(error) }, 'unhandled rejection');
});

try {
  await app.listen({ port: config.port, host: config.host });
  startTimers();

  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log('');
  console.log('Claude Usage Bridge');
  console.log(`  Dashboard: http://${shownHost}:${config.port}/`);
  console.log(`  Usage API: http://${shownHost}:${config.port}/api/usage`);
  console.log(`  Status:    http://${shownHost}:${config.port}/api/status`);
  console.log(`  Auth:      ${config.bridgeToken ? 'BRIDGE_TOKEN required' : 'local network open'}`);
  console.log('');
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
