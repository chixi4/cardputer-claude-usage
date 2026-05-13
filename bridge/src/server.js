import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { localAddresses } from './network.js';
import { makeDeviceStatusPayload, makePayloadLine } from './payload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

function readPublicFile(fileName) {
  return fs.readFileSync(path.join(PUBLIC_DIR, fileName), 'utf8');
}

function toBool(value) {
  return value === true || value === '1' || value === 'true' || value === 'on';
}

export function createApp({
  config,
  usageService,
  bleManager,
  usbManager,
}) {
  let lastPayload = null;
  let lastPush = null;
  let authDiag = null;
  let authDiagAt = 0;

  const app = Fastify({
    logger: {
      level: config.loggerLevel,
      transport: config.production
        ? undefined
        : {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
    },
  });

  function requireBridgeToken(req, reply, done) {
    if (!config.bridgeToken) {
      done();
      return;
    }

    const headerToken = req.headers['x-bridge-token'];
    const queryToken = req.query?.token;
    if (headerToken === config.bridgeToken || queryToken === config.bridgeToken) {
      done();
      return;
    }

    reply.code(401).send({
      status: 'error',
      error: 'missing or invalid bridge token',
    });
  }

  function credentialDiagnostic() {
    const now = Date.now();
    if (authDiag && now - authDiagAt < 10_000) return authDiag;
    authDiag = usageService.diagnoseCredentials();
    authDiagAt = now;
    return authDiag;
  }

  async function pushToTransports(data, targets = ['ble', 'usb']) {
    const payloadLine = makePayloadLine(data);
    const results = [];

    for (const target of targets) {
      if (target === 'ble') {
        if (!bleManager.isConnected()) {
          results.push({ target, ok: false, skipped: true, reason: 'not connected' });
          continue;
        }
        try {
          results.push({ target, ...(await bleManager.write(payloadLine)) });
        } catch (error) {
          results.push({ target, ok: false, error: error.message });
        }
      }

      if (target === 'usb') {
        if (!usbManager.isConnected()) {
          results.push({ target, ok: false, skipped: true, reason: 'not connected' });
          continue;
        }
        try {
          results.push({ target, ...(await usbManager.write(payloadLine)) });
        } catch (error) {
          results.push({ target, ok: false, error: error.message });
        }
      }
    }

    lastPayload = JSON.parse(payloadLine);
    lastPush = {
      at: new Date().toISOString(),
      results,
    };
    return {
      payload: lastPayload,
      pushed_at: lastPush.at,
      results,
    };
  }

  app.decorate('pushToTransports', pushToTransports);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'X-Bridge-Token, Content-Type');
    if (req.method === 'OPTIONS') {
      return reply.code(204).send();
    }
    return undefined;
  });

  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return readPublicFile('index.html');
  });

  app.get('/api/status', { preHandler: requireBridgeToken }, async () => ({
    status: 'ok',
    bridge: 'claude-usage-monitor',
    host: config.host,
    port: config.port,
    dashboard: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/`,
    cache_ttl_seconds: Math.floor(config.cacheTtlMs / 1000),
    has_bridge_token: Boolean(config.bridgeToken),
    auth: credentialDiagnostic(),
    cache: usageService.getCacheStatus(),
    transports: {
      ble: bleManager.status(),
      usb: usbManager.status(),
    },
    network: localAddresses(config.port),
    last_payload: lastPayload,
    last_push: lastPush,
    now: new Date().toISOString(),
  }));

  app.get('/api/usage', { preHandler: requireBridgeToken }, async (req, reply) => {
    if (req.query?.demo === '1') {
      const demo = usageService.generateDemo();
      if (req.query?.push === '1') await pushToTransports(demo);
      reply.header('X-Data-Source', 'demo');
      return demo;
    }

    const data = await usageService.getLiveUsage(req.query?.force === '1');
    if (req.query?.push === '1') await pushToTransports(data);
    reply.header('X-Data-Source', data.stale ? 'stale-cache' : 'live');
    if (data.stale) reply.header('X-Data-Stale', 'true');
    return data;
  });

  app.get('/api/demo', async () => usageService.generateDemo());

  app.get('/api/raw', { preHandler: requireBridgeToken }, async () => {
    if (!usageService.getRawSnapshot()) {
      await usageService.getLiveUsage(true);
    }
    return usageService.getRawSnapshot();
  });

  async function pushHandler(req) {
    const mode = req.query?.mode || req.body?.mode || 'live';
    const targets = String(req.query?.target || req.body?.target || 'ble,usb')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (mode === 'demo') {
      return pushToTransports(usageService.generateDemo(), targets);
    }

    try {
      return pushToTransports(await usageService.getLiveUsage(mode === 'force'), targets);
    } catch (error) {
      const data = usageService.getCachedUsage(true, error.message)
        ?? makeDeviceStatusPayload('error', error.message);
      return pushToTransports(data, targets);
    }
  }

  app.get('/api/push', { preHandler: requireBridgeToken }, pushHandler);
  app.post('/api/push', { preHandler: requireBridgeToken }, pushHandler);

  app.post('/api/transports/ble/connect', { preHandler: requireBridgeToken }, async () => bleManager.connect());
  app.get('/api/transports/ble/connect', { preHandler: requireBridgeToken }, async () => bleManager.connect());
  app.post('/api/transports/ble/disconnect', { preHandler: requireBridgeToken }, async () => bleManager.disconnect());
  app.post('/api/transports/ble/autoconnect', { preHandler: requireBridgeToken }, async (req) => {
    if (toBool(req.query?.enabled ?? req.body?.enabled)) bleManager.startAutoConnect();
    else bleManager.stopAutoConnect();
    return bleManager.status();
  });

  app.get('/api/transports/usb/list', { preHandler: requireBridgeToken }, async () => ({
    ports: await usbManager.listPorts(),
    selected: usbManager.status(),
  }));
  app.post('/api/transports/usb/connect', { preHandler: requireBridgeToken }, async (req) => (
    usbManager.connect(req.query?.path || req.body?.path)
  ));
  app.get('/api/transports/usb/connect', { preHandler: requireBridgeToken }, async (req) => (
    usbManager.connect(req.query?.path)
  ));
  app.post('/api/transports/usb/disconnect', { preHandler: requireBridgeToken }, async () => usbManager.disconnect());

  app.get('/api/diagnose', { preHandler: requireBridgeToken }, async () => ({
    auth: credentialDiagnostic(),
    cache: usageService.getCacheStatus(),
    ble: bleManager.status(),
    usb: {
      ...usbManager.status(),
      ports: await usbManager.listPorts(),
    },
    network: localAddresses(config.port),
  }));

  return app;
}
