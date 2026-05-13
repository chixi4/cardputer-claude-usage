#!/usr/bin/env node
import { getConfig } from './src/config.js';
import { createApp } from './src/server.js';
import { UsageService } from './src/usage.js';

const config = getConfig();
const usageService = new UsageService({
  cacheTtlMs: config.cacheTtlMs,
  requestTimeoutMs: config.requestTimeoutMs,
});

const app = createApp({
  config,
  usageService,
});

process.on('SIGINT', async () => {
  await app.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await app.close();
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  app.log.error({ err: error?.message ?? String(error) }, 'unhandled rejection');
});

try {
  await app.listen({ port: config.port, host: config.host });

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
