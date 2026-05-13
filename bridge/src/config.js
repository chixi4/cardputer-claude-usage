export function numberEnv(env, name, fallback) {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export function getConfig(env = process.env) {
  return {
    host: env.HOST || '0.0.0.0',
    port: numberEnv(env, 'PORT', 8787),
    bridgeToken: env.BRIDGE_TOKEN || '',
    cacheTtlMs: numberEnv(env, 'CACHE_TTL_MS', 60_000),
    requestTimeoutMs: numberEnv(env, 'REQUEST_TIMEOUT_MS', 10_000),
    loggerLevel: env.LOG_LEVEL || 'info',
    production: env.NODE_ENV === 'production',
  };
}
