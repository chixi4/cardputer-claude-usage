import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_WEB_BASE = 'https://claude.ai';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_SAFE_STORAGE = 'Claude Safe Storage';
const CLAUDE_COOKIE_DB = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'Cookies');

export function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function clampPercent(value) {
  const number = asNumber(value);
  if (number == null) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

export function parseDateMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return parseDateMs(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatDurationUntil(value, nowMs = Date.now()) {
  const targetMs = parseDateMs(value);
  if (targetMs == null) return null;

  let seconds = Math.floor((targetMs - nowMs) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `${seconds}s`;

  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function buildWindow(bucket, nowMs = Date.now()) {
  if (!bucket || typeof bucket !== 'object') {
    return {
      used_percent: null,
      remaining_percent: null,
      resets_at: null,
      resets_at_iso: null,
      resets_in: null,
    };
  }

  const used = clampPercent(
    bucket.utilization
      ?? bucket.used_percent
      ?? bucket.used_percentage
      ?? bucket.usage
      ?? bucket.percent,
  );
  const resetMs = parseDateMs(bucket.resets_at ?? bucket.reset_at ?? bucket.expires_at);
  const resetEpoch = resetMs == null ? null : Math.floor(resetMs / 1000);

  return {
    used_percent: used,
    remaining_percent: used == null ? null : Math.max(0, 100 - used),
    resets_at: resetEpoch,
    resets_at_iso: resetMs == null ? null : new Date(resetMs).toISOString(),
    resets_in: resetMs == null ? null : formatDurationUntil(resetMs, nowMs),
  };
}

export function buildExtraUsage(extraUsage) {
  if (!extraUsage || typeof extraUsage !== 'object') return null;
  return {
    is_enabled: Boolean(extraUsage.is_enabled),
    monthly_limit: extraUsage.monthly_limit ?? null,
    used_credits: extraUsage.used_credits ?? null,
    utilization: clampPercent(extraUsage.utilization),
    currency: extraUsage.currency ?? null,
  };
}

export function normalizeUsage(raw, credentials, fetchedAtMs, stale = false, error = null, nowMs = Date.now()) {
  return {
    source: credentials.source === 'demo' ? 'demo' : 'anthropic-oauth',
    status: error ? 'stale' : 'live',
    current: buildWindow(raw.five_hour, nowMs),
    weekly: buildWindow(raw.seven_day, nowMs),
    sonnet: buildWindow(raw.seven_day_sonnet, nowMs),
    opus: buildWindow(raw.seven_day_opus, nowMs),
    extra_usage: buildExtraUsage(raw.extra_usage),
    account: {
      credential_source: credentials.source,
      subscription_type: credentials.subscriptionType,
      rate_limit_tier: credentials.rateLimitTier,
      token_expires_at: credentials.expiresAtMs == null
        ? null
        : new Date(credentials.expiresAtMs).toISOString(),
    },
    updated_at: Math.floor(fetchedAtMs / 1000),
    age_seconds: Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000)),
    stale,
    demo: credentials.source === 'demo',
    error,
  };
}

function parseCredentialPayload(raw, source) {
  let json;
  try {
    json = JSON.parse(String(raw).trim());
  } catch {
    throw new Error(`${source} did not contain JSON credentials`);
  }

  const candidates = [
    json.claudeAiOauth,
    json.claude_ai_oauth,
    json.oauth,
    json,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const accessToken = candidate.accessToken || candidate.access_token || candidate.token;
    if (!accessToken) continue;

    return {
      source,
      accessToken,
      refreshToken: candidate.refreshToken || candidate.refresh_token || null,
      expiresAtMs: parseDateMs(candidate.expiresAt || candidate.expires_at),
      subscriptionType: candidate.subscriptionType || candidate.subscription_type || null,
      rateLimitTier: candidate.rateLimitTier || candidate.rate_limit_tier || null,
    };
  }

  throw new Error(`${source} credentials did not include an access token`);
}

function readEnvCredentials() {
  const accessToken = process.env.CLAUDE_USAGE_ACCESS_TOKEN || process.env.ANTHROPIC_ACCESS_TOKEN;
  if (!accessToken) return null;
  return {
    source: 'environment',
    accessToken,
    refreshToken: null,
    expiresAtMs: null,
    subscriptionType: null,
    rateLimitTier: null,
  };
}

function readMacKeychainCredentials() {
  if (process.platform !== 'darwin') return null;

  try {
    const raw = execFileSync('/usr/bin/security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseCredentialPayload(raw, 'macOS Keychain');
  } catch {
    return null;
  }
}

function readCredentialsFile() {
  const file = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(file)) return null;

  const raw = fs.readFileSync(file, 'utf8');
  return parseCredentialPayload(raw, file);
}

export function readCredentials() {
  const readers = [
    readEnvCredentials,
    readMacKeychainCredentials,
    readCredentialsFile,
  ];

  const errors = [];
  for (const reader of readers) {
    try {
      const credentials = reader();
      if (credentials) return credentials;
    } catch (error) {
      errors.push(error.message);
    }
  }

  const detail = errors.length > 0 ? ` (${errors.join('; ')})` : '';
  throw new Error(`Claude OAuth credentials not found${detail}`);
}

function chromiumTimeToDateMs(value) {
  const number = asNumber(value);
  if (!number) return null;
  return Math.floor(number / 1000 - 11_644_473_600_000);
}

function readKeychainPassword(service) {
  return execFileSync('/usr/bin/security', [
    'find-generic-password',
    '-s',
    service,
    '-w',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function decryptChromiumCookie(hexValue, password) {
  if (!hexValue) return '';

  const encrypted = Buffer.from(hexValue, 'hex');
  if (encrypted.length === 0) return '';

  if (!encrypted.subarray(0, 3).equals(Buffer.from('v10'))) {
    return encrypted.toString('utf8');
  }

  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.from(' '.repeat(16));
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const decrypted = Buffer.concat([
    decipher.update(encrypted.subarray(3)),
    decipher.final(),
  ]);

  const payload = decrypted.length > 32
    && decrypted.subarray(0, 32).some((byte) => byte < 0x20 || byte > 0x7e)
    ? decrypted.subarray(32)
    : decrypted;
  return payload.toString('utf8');
}

function readClaudeAppCookies() {
  if (process.platform !== 'darwin') {
    throw new Error('Claude app cookie fallback is only implemented for macOS');
  }
  if (!fs.existsSync(CLAUDE_COOKIE_DB)) {
    throw new Error(`Claude app cookie database not found at ${CLAUDE_COOKIE_DB}`);
  }

  const password = readKeychainPassword(CLAUDE_SAFE_STORAGE);
  const sql = "select host_key, name, value, hex(encrypted_value), expires_utc from cookies where host_key like '%claude.ai' or host_key='claude.ai';";
  const rows = execFileSync('sqlite3', ['-tabs', '-noheader', CLAUDE_COOKIE_DB, sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\n').filter(Boolean);

  const cookies = [];
  for (const row of rows) {
    const [host, name, plainValue, encryptedHex, expiresUtc] = row.split('\t');
    const value = plainValue || decryptChromiumCookie(encryptedHex, password);
    const expiresAtMs = chromiumTimeToDateMs(expiresUtc);
    if (!value) continue;
    if (expiresAtMs && expiresAtMs < Date.now()) continue;
    cookies.push({ host, name, value });
  }

  if (!cookies.some((cookie) => cookie.name === 'sessionKey')) {
    throw new Error('Claude app sessionKey cookie not found; open Claude.app and make sure it is logged in');
  }

  return cookies;
}

function buildCookieHeader(cookies) {
  return cookies
    .filter((cookie) => cookie.host === '.claude.ai' || cookie.host === 'claude.ai')
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function findCookieValue(cookies, name) {
  return cookies.find((cookie) => cookie.name === name)?.value ?? null;
}

export async function fetchJsonWithTimeout(url, options, requestTimeoutMs = 10_000, fetchFn = globalThis.fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetchFn(url, {
      ...options,
      signal: controller.signal,
    });
    const body = await response.text();

    if (!response.ok) {
      const snippet = body.slice(0, 300).replace(/\s+/g, ' ');
      const error = new Error(`Anthropic usage API returned HTTP ${response.status}: ${snippet}`);
      error.statusCode = response.status;
      throw error;
    }

    try {
      return JSON.parse(body);
    } catch {
      throw new Error('Anthropic usage API returned invalid JSON');
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchClaudeAppUsageSnapshot(requestTimeoutMs, fetchFn) {
  const cookies = readClaudeAppCookies();
  const orgId = findCookieValue(cookies, 'lastActiveOrg');
  if (!orgId) {
    throw new Error('lastActiveOrg cookie not found');
  }

  const raw = await fetchJsonWithTimeout(
    `${CLAUDE_WEB_BASE}/api/organizations/${encodeURIComponent(orgId)}/usage`,
    {
      headers: {
        Accept: 'application/json',
        Cookie: buildCookieHeader(cookies),
        Origin: CLAUDE_WEB_BASE,
        Referer: `${CLAUDE_WEB_BASE}/settings/usage`,
        'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) ClaudeUsageMonitor/1.0 Safari/537.36',
      },
    },
    requestTimeoutMs,
    fetchFn,
  );

  return {
    raw,
    credentials: {
      source: 'Claude app cookie',
      subscriptionType: null,
      rateLimitTier: null,
      expiresAtMs: null,
    },
    fetchedAtMs: Date.now(),
  };
}

export function generateDemo(nowMs = Date.now(), overrides = {}) {
  const cycle = Math.floor(nowMs / 1000);
  const currentPct = 12 + (cycle % 76);
  const weeklyPct = 5 + (Math.floor(cycle / 3) % 50);

  const raw = {
    five_hour: {
      utilization: currentPct,
      resets_at: new Date(nowMs + 82 * 60 * 1000).toISOString(),
    },
    seven_day: {
      utilization: weeklyPct,
      resets_at: new Date(nowMs + (6 * 24 + 8) * 60 * 60 * 1000).toISOString(),
    },
    seven_day_sonnet: {
      utilization: Math.max(0, weeklyPct - 3),
      resets_at: new Date(nowMs + (6 * 24 + 8) * 60 * 60 * 1000).toISOString(),
    },
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used_credits: null,
      utilization: null,
    },
  };

  const data = normalizeUsage(raw, {
    source: 'demo',
    subscriptionType: 'pro',
    rateLimitTier: 'demo',
    expiresAtMs: null,
  }, nowMs, false, null, nowMs);

  return {
    ...data,
    source: 'demo',
    status: overrides.status || 'demo',
    demo: true,
    error: overrides.error || null,
  };
}

export class UsageService {
  constructor({
    cacheTtlMs = 60_000,
    requestTimeoutMs = 10_000,
    fetchFn = globalThis.fetch,
    now = () => Date.now(),
  } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchFn = fetchFn;
    this.now = now;
    this.cache = null;
  }

  async getLiveUsage(force = false) {
    const nowMs = this.now();
    if (!force && this.cache && nowMs - this.cache.fetchedAtMs < this.cacheTtlMs) {
      return normalizeUsage(this.cache.raw, this.cache.credentials, this.cache.fetchedAtMs, false, null, nowMs);
    }

    const errors = [];

    try {
      const credentials = readCredentials();
      const raw = await fetchJsonWithTimeout(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          Accept: 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
        },
      }, this.requestTimeoutMs, this.fetchFn);

      this.cache = {
        raw,
        credentials,
        fetchedAtMs: this.now(),
      };

      return normalizeUsage(this.cache.raw, credentials, this.cache.fetchedAtMs, false, null, this.now());
    } catch (error) {
      errors.push(`oauth: ${error.message}`);
      if (this.cache && (error.name === 'AbortError' || error.statusCode === 429 || error.statusCode >= 500)) {
        return normalizeUsage(
          this.cache.raw,
          this.cache.credentials,
          this.cache.fetchedAtMs,
          true,
          error.message,
          this.now(),
        );
      }
    }

    try {
      const snapshot = await fetchClaudeAppUsageSnapshot(this.requestTimeoutMs, this.fetchFn);
      this.cache = snapshot;
      return normalizeUsage(snapshot.raw, snapshot.credentials, snapshot.fetchedAtMs, false, null, this.now());
    } catch (error) {
      errors.push(`claude-app-cookie: ${error.message}`);
    }

    throw new Error(errors.join('; '));
  }

  getCachedUsage(stale = true, error = null) {
    if (!this.cache) return null;
    return normalizeUsage(
      this.cache.raw,
      this.cache.credentials,
      this.cache.fetchedAtMs,
      stale,
      error,
      this.now(),
    );
  }

  generateDemo() {
    return generateDemo(this.now());
  }

  getRawSnapshot() {
    if (!this.cache) return null;
    return {
      fetched_at: new Date(this.cache.fetchedAtMs).toISOString(),
      credential_source: this.cache.credentials.source,
      raw: this.cache.raw,
    };
  }

  getCacheStatus() {
    return {
      has_cache: Boolean(this.cache),
      cache_age_seconds: this.cache
        ? Math.floor((this.now() - this.cache.fetchedAtMs) / 1000)
        : null,
      fetched_at: this.cache ? new Date(this.cache.fetchedAtMs).toISOString() : null,
    };
  }

  diagnoseCredentials() {
    try {
      const credentials = readCredentials();
      return {
        ok: true,
        source: credentials.source,
        subscription_type: credentials.subscriptionType,
        rate_limit_tier: credentials.rateLimitTier,
        token_expires_at: credentials.expiresAtMs == null
          ? null
          : new Date(credentials.expiresAtMs).toISOString(),
      };
    } catch (error) {
      return {
        ok: false,
        source: null,
        error: error.message,
      };
    }
  }
}
