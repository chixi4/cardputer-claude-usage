import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { localAddresses } from './network.js';
import { makeCompactPayload, makeDeviceStatusPayload } from './payload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const BLE_SERVICE_UUID = 'cafe1234-5678-1234-5678-123456789abc';
const BLE_CHAR_UUID = 'cafe5678-1234-5678-1234-56789abcdef0';
const BLE_DEVICE_NAME = 'Claude-Usage';
const SUBSCRIPTION_REQUIRED_MESSAGE = 'Claude Pro/Max required';
const OAUTH_NOT_ALLOWED_MESSAGE = 'Claude Code OAuth not allowed';
const DEBUG_LOG_LIMIT = 300;

function readPublicFile(fileName) {
  return fs.readFileSync(path.join(PUBLIC_DIR, fileName), 'utf8');
}

function findClaudeCli() {
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);

  const appRoot = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Claude', 'claude-code');
  try {
    const versions = fs.readdirSync(appRoot)
      .filter((name) => /^\d+\.\d+\.\d+/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      candidates.push(path.join(appRoot, version, 'claude.app', 'Contents', 'MacOS', 'claude'));
    }
  } catch {
    // Claude Code is optional; the dashboard will show the manual fallback.
  }

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function startClaudeAuthLogin() {
  const cli = findClaudeCli();
  if (!cli) {
    return {
      started: false,
      command: 'claude auth login',
      error: 'Claude Code CLI was not found',
    };
  }

  const child = spawn(cli, ['auth', 'login'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return {
    started: true,
    command: `${cli} auth login`,
    pid: child.pid,
  };
}

function isSubscriptionRequiredError(error) {
  return /Pro\/Max required|Claude (Max|Pro).*required|subscription.*required|upgrade to (Max|Pro)/i.test(error?.message || String(error || ''));
}

function isOauthNotAllowedError(error) {
  return /OAuth.*not allowed|not allowed for this organization|permission_error/i.test(error?.message || String(error || ''));
}

export function createApp({
  config,
  usageService,
}) {
  let authDiag = null;
  let authDiagAt = 0;
  let authDiagPromise = null;
  let debugSeq = 0;
  const debugLogs = [];

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

  function addDebugLog(event, detail = {}) {
    const entry = {
      seq: ++debugSeq,
      time: new Date().toISOString(),
      event,
      detail,
    };
    debugLogs.push(entry);
    if (debugLogs.length > DEBUG_LOG_LIMIT) debugLogs.shift();
    return entry;
  }

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

  async function credentialDiagnostic() {
    const now = Date.now();
    if (authDiag && now - authDiagAt < 10_000) return authDiag;
    if (!authDiagPromise) {
      authDiagPromise = Promise.resolve(usageService.diagnoseCredentials({ refresh: true }))
        .then((result) => {
          authDiag = result;
          authDiagAt = Date.now();
          return result;
        })
        .finally(() => {
          authDiagPromise = null;
        });
    }
    return authDiagPromise;
  }

  function bluetoothStatus() {
    return {
      kind: 'web-bluetooth',
      device_name: BLE_DEVICE_NAME,
      service_uuid: BLE_SERVICE_UUID,
      characteristic_uuid: BLE_CHAR_UUID,
      connection_owner: 'browser',
      browser_required: 'Chrome or Edge',
    };
  }

  function retiredNativeTransport(_req, reply) {
    return reply.code(410).send({
      status: 'retired',
      error: 'browser_bluetooth_only',
      message: 'Native BLE/USB bridge transports were removed. Use the dashboard Web Bluetooth flow.',
    });
  }

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
    auth: await credentialDiagnostic(),
    cache: usageService.getCacheStatus(),
    transports: {
      bluetooth: bluetoothStatus(),
    },
    network: localAddresses(config.port),
    now: new Date().toISOString(),
  }));

  app.get('/api/debug/logs', { preHandler: requireBridgeToken }, async (req) => {
    const limit = Math.max(1, Math.min(Number.parseInt(req.query?.limit ?? '120', 10) || 120, DEBUG_LOG_LIMIT));
    return {
      logs: debugLogs.slice(-limit),
      limit,
      now: new Date().toISOString(),
    };
  });

  app.post('/api/debug/events', { preHandler: requireBridgeToken }, async (req) => {
    const events = Array.isArray(req.body?.events) ? req.body.events : [req.body];
    let accepted = 0;
    for (const item of events) {
      if (!item || typeof item !== 'object') continue;
      addDebugLog(`browser:${String(item.event || 'event')}`, {
        message: item.message,
        step: item.step,
        detail: item.detail,
        browser_time: item.time,
      });
      accepted += 1;
    }
    return { ok: true, accepted };
  });

  app.get('/api/usage', { preHandler: requireBridgeToken }, async (req, reply) => {
    if (req.query?.demo === '1') {
      const demo = usageService.generateDemo();
      reply.header('X-Data-Source', 'demo');
      return demo;
    }

    const data = await usageService.getLiveUsage(req.query?.force === '1');
    reply.header('X-Data-Source', data.stale ? 'stale-cache' : 'live');
    if (data.stale) reply.header('X-Data-Stale', 'true');
    return data;
  });

  app.get('/api/auth/status', { preHandler: requireBridgeToken }, async (req) => {
    if (req.query?.probe === '1') {
      authDiag = null;
      authDiagAt = 0;
      const auth = await usageService.diagnoseCredentials({ refresh: true, probe: true });
      addDebugLog('auth-probe', { ok: auth.ok, source: auth.source, error: auth.error });
      return auth;
    }
    const auth = await credentialDiagnostic();
    addDebugLog('auth-status', { ok: auth.ok, source: auth.source, error: auth.error });
    return auth;
  });
  app.post('/api/auth/login', { preHandler: requireBridgeToken }, async () => startClaudeAuthLogin());
  app.post('/api/auth/logout', { preHandler: requireBridgeToken }, async (_req, reply) => {
    try {
      const result = usageService.logoutCredentials();
      authDiag = null;
      authDiagAt = 0;
      return result;
    } catch (error) {
      const statusCode = error.code === 'environment_credentials' ? 409 : 500;
      return reply.code(statusCode).send({
        status: 'error',
        error: 'logout_failed',
        message: error.message,
      });
    }
  });

  app.get('/api/device-payload', { preHandler: requireBridgeToken }, async (req, reply) => {
    let data;
    try {
      if (req.query?.demo === '1') {
        data = usageService.generateDemo();
      } else {
        const auth = await credentialDiagnostic();
        if (auth.needs_subscription) {
          throw new Error(SUBSCRIPTION_REQUIRED_MESSAGE);
        }
        if (auth.oauth_not_allowed) {
          throw new Error(OAUTH_NOT_ALLOWED_MESSAGE);
        }
        if (auth.needs_login) {
          throw new Error('Claude login expired');
        }
        data = await usageService.getLiveUsage(req.query?.force === '1');
      }
    } catch (error) {
      addDebugLog('device-payload-error', { message: error.message });
      data = isSubscriptionRequiredError(error)
        ? makeDeviceStatusPayload('subscription_required', SUBSCRIPTION_REQUIRED_MESSAGE)
        : isOauthNotAllowedError(error)
        ? makeDeviceStatusPayload('auth_required', OAUTH_NOT_ALLOWED_MESSAGE)
        : usageService.getCachedUsage(true, error.message)
        ?? makeDeviceStatusPayload('error', error.message);
      reply.header('X-Data-Stale', 'true');
    }
    const payload = makeCompactPayload(data);
    reply.header('X-Data-Source', data.stale ? 'stale-cache' : data.source);
    addDebugLog('device-payload', {
      force: req.query?.force === '1',
      status: data.status,
      source: data.stale ? 'stale-cache' : data.source,
      stale: Boolean(data.stale),
      current: payload.cu,
      weekly: payload.wu,
      error: payload.err,
    });
    return {
      payload,
      usage: data,
      line: `${JSON.stringify(payload)}\n`,
    };
  });

  app.get('/api/demo', async () => usageService.generateDemo());

  app.get('/api/raw', { preHandler: requireBridgeToken }, async () => {
    if (!usageService.getRawSnapshot()) {
      await usageService.getLiveUsage(true);
    }
    return usageService.getRawSnapshot();
  });

  app.get('/api/push', { preHandler: requireBridgeToken }, retiredNativeTransport);
  app.post('/api/push', { preHandler: requireBridgeToken }, retiredNativeTransport);
  app.get('/api/transports/ble/connect', { preHandler: requireBridgeToken }, retiredNativeTransport);
  app.post('/api/transports/ble/connect', { preHandler: requireBridgeToken }, retiredNativeTransport);
  app.post('/api/transports/ble/disconnect', { preHandler: requireBridgeToken }, retiredNativeTransport);
  app.post('/api/transports/ble/autoconnect', { preHandler: requireBridgeToken }, retiredNativeTransport);
  app.get('/api/transports/usb/list', { preHandler: requireBridgeToken }, retiredNativeTransport);
  app.get('/api/transports/usb/connect', { preHandler: requireBridgeToken }, retiredNativeTransport);
  app.post('/api/transports/usb/connect', { preHandler: requireBridgeToken }, retiredNativeTransport);
  app.post('/api/transports/usb/disconnect', { preHandler: requireBridgeToken }, retiredNativeTransport);

  app.get('/api/diagnose', { preHandler: requireBridgeToken }, async () => ({
    auth: await credentialDiagnostic(),
    cache: usageService.getCacheStatus(),
    bluetooth: bluetoothStatus(),
    network: localAddresses(config.port),
  }));

  return app;
}
