export function numberEnv(env, name, fallback) {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export function boolEnv(env, name, fallback = false) {
  const value = env[name];
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

export function getConfig(env = process.env) {
  return {
    host: env.HOST || '0.0.0.0',
    port: numberEnv(env, 'PORT', 8787),
    bridgeToken: env.BRIDGE_TOKEN || '',
    cacheTtlMs: numberEnv(env, 'CACHE_TTL_MS', 60_000),
    requestTimeoutMs: numberEnv(env, 'REQUEST_TIMEOUT_MS', 10_000),
    pushIntervalMs: numberEnv(env, 'PUSH_INTERVAL_MS', 60_000),
    initialPushDelayMs: numberEnv(env, 'INITIAL_PUSH_DELAY_MS', 5_000),
    loggerLevel: env.LOG_LEVEL || 'info',
    production: env.NODE_ENV === 'production',
    ble: {
      autoConnect: boolEnv(env, 'BLE_AUTO_CONNECT', false),
      scanTimeoutMs: numberEnv(env, 'BLE_SCAN_TIMEOUT_MS', 15_000),
      chunkSize: numberEnv(env, 'BLE_CHUNK_SIZE', 18),
    },
    usb: {
      autoConnect: boolEnv(env, 'USB_AUTO_CONNECT', false),
      baudRate: numberEnv(env, 'USB_BAUD_RATE', 115_200),
      path: env.USB_PORT || '',
    },
  };
}
