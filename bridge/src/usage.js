import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CREDENTIAL_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const CLAUDE_WEB_BASE = 'https://claude.ai';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_SAFE_STORAGE = 'Claude Safe Storage';
const CLAUDE_COOKIE_DB = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'Cookies');
const STATUSLINE_USAGE_CACHE = process.env.CLAUDE_USAGE_STATUSLINE_CACHE || '/tmp/claude/usage.json';
const STATUSLINE_SESSION_CACHE = process.env.CLAUDE_USAGE_STATUSLINE_SESSION || '/tmp/claude/status.json';
const STATUSLINE_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_PERSISTENT_CACHE_FILE = process.env.CLAUDE_USAGE_BRIDGE_CACHE
  || path.join(os.homedir(), '.claude', 'usage-bridge-cache.json');
const DEFAULT_PERSISTENT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_FALLBACK_BACKOFF_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_BACKOFF_MS = 30 * 60 * 1000;
const SUBSCRIPTION_REQUIRED_MESSAGE = 'Claude Pro/Max required';
const OAUTH_NOT_ALLOWED_MESSAGE = 'Claude Code OAuth not allowed';
const USAGE_SOURCE_UNAVAILABLE_MESSAGE = 'Claude usage source unavailable';
const AUTH_ISSUE_TTL_MS = 10 * 60 * 1000;

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
    source: credentials.source === 'demo' ? 'demo' : (credentials.source || 'anthropic-oauth'),
    status: error ? 'stale' : 'live',
    model: raw.model || raw.model_display_name || null,
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

function parseRetryAfterMs(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, Math.floor(seconds * 1000));
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function isRateLimitError(error) {
  return error?.statusCode === 429 || /rate[_ -]?limit|HTTP 429/i.test(error?.message || '');
}

function isSubscriptionRequiredText(value) {
  const text = String(value?.message || value || '');
  return /Claude (Max|Pro).*required|Pro.*Max.*required|Max.*Pro.*required|subscription.*required|required.*subscription|upgrade to (Max|Pro)|use your API key/i.test(text);
}

function isOauthNotAllowedText(value) {
  const text = String(value?.message || value || '');
  return /OAuth authentication.*not allowed|not allowed for this organization|permission_error/i.test(text);
}

function hasDisqualifyingSubscription(credentials) {
  const source = String(credentials?.source || '').toLowerCase();
  if (source === 'environment') return false;

  const subscription = String(credentials?.subscriptionType || '').trim().toLowerCase();
  if (!subscription) return false;
  if (/\b(pro|max|team|enterprise|business)\b/.test(subscription)) return false;
  return /\b(free|none|expired|inactive|cancelled|canceled|basic|default)\b/.test(subscription);
}

function subscriptionRequiredError(message = SUBSCRIPTION_REQUIRED_MESSAGE) {
  const error = new Error(message);
  error.code = 'subscription_required';
  return error;
}

function isSubscriptionRequiredError(error) {
  return error?.code === 'subscription_required' || isSubscriptionRequiredText(error);
}

function oauthNotAllowedError(message = OAUTH_NOT_ALLOWED_MESSAGE) {
  const error = new Error(message);
  error.code = 'oauth_not_allowed';
  return error;
}

function isOauthNotAllowedError(error) {
  return error?.code === 'oauth_not_allowed' || isOauthNotAllowedText(error);
}

function isHardAuthError(error) {
  return isSubscriptionRequiredError(error) || isOauthNotAllowedError(error);
}

function conciseUsageError(error) {
  const text = String(error?.message || error || '');
  if (isSubscriptionRequiredError(error)) return SUBSCRIPTION_REQUIRED_MESSAGE;
  if (isOauthNotAllowedError(error)) return OAUTH_NOT_ALLOWED_MESSAGE;
  if (isRateLimitError(error)) return 'Claude usage API rate limited';
  if (/401|Invalid authentication credentials|expired|credentials/i.test(text)) {
    return 'Claude login expired';
  }
  if (/invalid JSON/i.test(text)) {
    return USAGE_SOURCE_UNAVAILABLE_MESSAGE;
  }
  if (/403|Just a moment|Cloudflare/i.test(text)) {
    return 'Claude usage access blocked';
  }
  if (/abort|timeout/i.test(text)) {
    return 'Claude usage request timed out';
  }
  return text.replace(/\s+/g, ' ').slice(0, 160) || 'Claude usage request failed';
}

export function summarizeUsageSourceErrors(errors) {
  const joined = errors.join('; ');
  const missingStatusline = /statusline: fresh Claude Code statusline usage cache not found/i.test(joined);
  const sourceBlocked = /oauth: Claude usage access blocked|claude-app-cookie: Claude usage access blocked/i.test(joined);
  const appFallbackUnavailable = /claude-app-cookie: (Claude usage source unavailable|lastActiveOrg cookie not found|Claude app sessionKey cookie not found)/i.test(joined);

  if (missingStatusline && (sourceBlocked || appFallbackUnavailable)) {
    return USAGE_SOURCE_UNAVAILABLE_MESSAGE;
  }
  return joined;
}

function parseCredentialPayload(raw, source, storage = { type: 'unknown' }) {
  let json;
  try {
    json = JSON.parse(String(raw).trim());
  } catch {
    throw new Error(`${source} did not contain JSON credentials`);
  }

  const candidates = [
    ['claudeAiOauth', json.claudeAiOauth],
    ['claude_ai_oauth', json.claude_ai_oauth],
    ['oauth', json.oauth],
    [null, json],
  ].filter(([, value]) => Boolean(value));

  for (const [credentialKey, candidate] of candidates) {
    const accessToken = candidate.accessToken || candidate.access_token || candidate.token;
    if (!accessToken) continue;

    return {
      source,
      accessToken,
      refreshToken: candidate.refreshToken || candidate.refresh_token || null,
      expiresAtMs: parseDateMs(candidate.expiresAt || candidate.expires_at),
      subscriptionType: candidate.subscriptionType || candidate.subscription_type || null,
      rateLimitTier: candidate.rateLimitTier || candidate.rate_limit_tier || null,
      _rawPayload: json,
      _credentialKey: credentialKey,
      _storage: storage,
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
    _rawPayload: null,
    _credentialKey: null,
    _storage: { type: 'environment' },
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
    return parseCredentialPayload(raw, 'macOS Keychain', {
      type: 'keychain',
      account: os.userInfo().username,
    });
  } catch {
    return null;
  }
}

function readCredentialsFile() {
  const file = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(file)) return null;

  const raw = fs.readFileSync(file, 'utf8');
  return parseCredentialPayload(raw, file, { type: 'file', file });
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

function backupPathFor(file, nowMs = Date.now()) {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return `${file}.logged-out-${stamp}`;
}

export function forgetCredentials(nowMs = Date.now()) {
  const credentials = readCredentials();
  const storage = credentials._storage || {};

  if (storage.type === 'environment') {
    const error = new Error('Claude token is set by environment variable; unset CLAUDE_USAGE_ACCESS_TOKEN or ANTHROPIC_ACCESS_TOKEN to log out.');
    error.code = 'environment_credentials';
    throw error;
  }

  if (storage.type === 'keychain') {
    const args = ['delete-generic-password', '-s', KEYCHAIN_SERVICE];
    if (storage.account) args.push('-a', storage.account);
    execFileSync('/usr/bin/security', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: true,
      source: credentials.source,
      action: 'deleted-keychain-credential',
    };
  }

  if (storage.type === 'file' && storage.file) {
    const backup = backupPathFor(storage.file, nowMs);
    fs.renameSync(storage.file, backup);
    return {
      ok: true,
      source: credentials.source,
      action: 'moved-credentials-file',
      backup,
    };
  }

  throw new Error(`${credentials.source} credentials cannot be logged out automatically`);
}

function shouldRefreshCredentials(credentials, nowMs = Date.now()) {
  return Boolean(
    credentials?.refreshToken
      && credentials.expiresAtMs != null
      && credentials.expiresAtMs <= nowMs + CREDENTIAL_REFRESH_WINDOW_MS,
  );
}

function credentialTarget(rawPayload, credentialKey) {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  if (!credentialKey) return rawPayload;
  if (!rawPayload[credentialKey] || typeof rawPayload[credentialKey] !== 'object') {
    rawPayload[credentialKey] = {};
  }
  return rawPayload[credentialKey];
}

function setCredentialField(target, names, fallbackName, value) {
  if (value == null) return;
  const existing = names.find((name) => Object.prototype.hasOwnProperty.call(target, name));
  target[existing || fallbackName] = value;
}

function persistCredentialPayload(credentials, payload) {
  const text = JSON.stringify(payload);
  const storage = credentials._storage || {};

  if (storage.type === 'keychain') {
    execFileSync('/usr/bin/security', [
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      storage.account || os.userInfo().username,
      '-w',
      text,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return;
  }

  if (storage.type === 'file' && storage.file) {
    fs.writeFileSync(storage.file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return;
  }

  throw new Error(`${credentials.source} credentials cannot be refreshed automatically`);
}

export async function refreshCredentials(credentials, {
  requestTimeoutMs = 10_000,
  fetchFn = globalThis.fetch,
  nowMs = Date.now(),
} = {}) {
  if (!credentials?.refreshToken) {
    throw new Error(`${credentials?.source || 'Claude'} credentials do not include a refresh token`);
  }
  if (!credentials._rawPayload) {
    throw new Error(`${credentials.source} credentials cannot be persisted after refresh`);
  }

  const response = await fetchJsonWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    }),
  }, requestTimeoutMs, fetchFn);

  if (!response.access_token) {
    throw new Error('Claude OAuth refresh response did not include an access token');
  }

  const nextPayload = structuredClone(credentials._rawPayload);
  const target = credentialTarget(nextPayload, credentials._credentialKey);
  if (!target) throw new Error('Claude credentials had no writable OAuth payload');

  setCredentialField(target, ['accessToken', 'access_token', 'token'], 'accessToken', response.access_token);
  setCredentialField(target, ['refreshToken', 'refresh_token'], 'refreshToken', response.refresh_token);
  if (response.expires_in != null) {
    setCredentialField(
      target,
      ['expiresAt', 'expires_at'],
      'expiresAt',
      nowMs + Number(response.expires_in) * 1000,
    );
  }
  if (response.scope) {
    target.scopes = Array.isArray(response.scope) ? response.scope : String(response.scope).split(/\s+/).filter(Boolean);
  }
  setCredentialField(target, ['subscriptionType', 'subscription_type'], 'subscriptionType', response.subscription_type);
  setCredentialField(target, ['rateLimitTier', 'rate_limit_tier'], 'rateLimitTier', response.rate_limit_tier);

  persistCredentialPayload(credentials, nextPayload);
  return parseCredentialPayload(JSON.stringify(nextPayload), credentials.source, credentials._storage);
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
      const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'));
      const message = isSubscriptionRequiredText(snippet)
        ? SUBSCRIPTION_REQUIRED_MESSAGE
        : isOauthNotAllowedText(snippet)
        ? OAUTH_NOT_ALLOWED_MESSAGE
        : response.status === 429
        ? 'Claude usage API rate limited'
        : `Anthropic usage API returned HTTP ${response.status}: ${snippet}`;
      const error = new Error(message);
      error.statusCode = response.status;
      if (isSubscriptionRequiredText(snippet)) error.code = 'subscription_required';
      if (isOauthNotAllowedText(snippet)) error.code = 'oauth_not_allowed';
      error.retryAfterMs = retryAfterMs;
      error.responseBody = snippet;
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

function readJsonFileIfFresh(file, nowMs, maxAgeMs = STATUSLINE_MAX_AGE_MS) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (Math.abs(nowMs - stat.mtimeMs) > maxAgeMs) return null;
  return {
    json: JSON.parse(fs.readFileSync(file, 'utf8')),
    mtimeMs: stat.mtimeMs,
  };
}

function statusLineBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const utilization = bucket.utilization
    ?? bucket.used_percent
    ?? bucket.used_percentage;
  const resetsAt = bucket.resets_at
    ?? bucket.reset_at;
  if (utilization == null && resetsAt == null) return null;
  return {
    utilization,
    resets_at: resetsAt,
  };
}

function usageRawFromStatusLineCache(snapshot) {
  const json = snapshot.json;
  const rateLimits = json.rate_limits || json;
  const fiveHour = statusLineBucket(rateLimits.five_hour);
  const sevenDay = statusLineBucket(rateLimits.seven_day);
  if (!fiveHour && !sevenDay) return null;

  return {
    raw: {
      five_hour: fiveHour,
      seven_day: sevenDay,
      model: json.model?.display_name || json.model || null,
    },
    credentials: {
      source: 'Claude Code statusline',
      subscriptionType: null,
      rateLimitTier: json.model?.display_name || json.model || null,
      expiresAtMs: null,
    },
    fetchedAtMs: parseDateMs(json.updated_at) ?? snapshot.mtimeMs,
  };
}

function readStatusLineUsageSnapshot(nowMs = Date.now()) {
  const snapshots = [
    readJsonFileIfFresh(STATUSLINE_USAGE_CACHE, nowMs),
    readJsonFileIfFresh(STATUSLINE_SESSION_CACHE, nowMs),
  ].filter(Boolean);

  for (const snapshot of snapshots) {
    const usage = usageRawFromStatusLineCache(snapshot);
    if (usage) return usage;
  }
  throw new Error('fresh Claude Code statusline usage cache not found');
}

function sanitizeCredentialsForCache(credentials = {}) {
  return {
    source: credentials.source || null,
    subscriptionType: credentials.subscriptionType || null,
    rateLimitTier: credentials.rateLimitTier || null,
    expiresAtMs: credentials.expiresAtMs ?? null,
  };
}

function sanitizeSnapshotForCache(snapshot) {
  return {
    raw: snapshot.raw,
    credentials: sanitizeCredentialsForCache(snapshot.credentials),
    fetchedAtMs: snapshot.fetchedAtMs,
  };
}

function validCachedSnapshot(snapshot, nowMs, maxAgeMs) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (!snapshot.raw || typeof snapshot.raw !== 'object') return null;
  const fetchedAtMs = parseDateMs(snapshot.fetchedAtMs);
  if (fetchedAtMs == null) return null;
  if (Math.abs(nowMs - fetchedAtMs) > maxAgeMs) return null;
  return {
    raw: snapshot.raw,
    credentials: sanitizeCredentialsForCache(snapshot.credentials),
    fetchedAtMs,
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
    appUsageSnapshotFn = fetchClaudeAppUsageSnapshot,
    persistentCacheFile = DEFAULT_PERSISTENT_CACHE_FILE,
    persistentCacheMaxAgeMs = DEFAULT_PERSISTENT_CACHE_MAX_AGE_MS,
    now = () => Date.now(),
  } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchFn = fetchFn;
    this.appUsageSnapshotFn = appUsageSnapshotFn;
    this.persistentCacheFile = persistentCacheFile;
    this.persistentCacheMaxAgeMs = persistentCacheMaxAgeMs;
    this.now = now;
    this.cache = this.readPersistentCache();
    this.refreshPromise = null;
    this.rateLimitedUntilMs = 0;
    this.rateLimitAttempts = 0;
    this.lastRateLimitError = null;
    this.appFallbackBlockedUntilMs = 0;
    this.lastAuthIssue = null;
  }

  async refreshCredentialsIfNeeded(credentials, nowMs = this.now()) {
    if (!shouldRefreshCredentials(credentials, nowMs)) return credentials;
    if (!this.refreshPromise) {
      this.refreshPromise = refreshCredentials(credentials, {
        requestTimeoutMs: this.requestTimeoutMs,
        fetchFn: this.fetchFn,
        nowMs,
      }).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async getRequestCredentials() {
    const credentials = readCredentials();
    return this.refreshCredentialsIfNeeded(credentials);
  }

  cacheSnapshot(snapshot) {
    this.cache = sanitizeSnapshotForCache(snapshot);
    this.writePersistentCache(this.cache);
    this.clearAuthIssue();
    return normalizeUsage(this.cache.raw, this.cache.credentials, this.cache.fetchedAtMs, false, null, this.now());
  }

  readPersistentCache() {
    if (!this.persistentCacheFile) return null;
    try {
      if (!fs.existsSync(this.persistentCacheFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.persistentCacheFile, 'utf8'));
      return validCachedSnapshot(parsed, this.now(), this.persistentCacheMaxAgeMs);
    } catch {
      return null;
    }
  }

  writePersistentCache(snapshot) {
    if (!this.persistentCacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.persistentCacheFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.persistentCacheFile, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // The in-memory cache still works if the filesystem is temporarily unavailable.
    }
  }

  clearPersistentCache() {
    if (!this.persistentCacheFile) return;
    try {
      fs.rmSync(this.persistentCacheFile, { force: true });
    } catch {
      // Logging out should proceed even if the cache file has already gone away.
    }
  }

  noteAuthIssue(error, nowMs = this.now()) {
    this.lastAuthIssue = {
      code: error?.code || (isSubscriptionRequiredError(error) ? 'subscription_required' : 'oauth_not_allowed'),
      message: conciseUsageError(error),
      atMs: nowMs,
    };
  }

  currentAuthIssue(nowMs = this.now()) {
    if (!this.lastAuthIssue) return null;
    if (nowMs - this.lastAuthIssue.atMs > AUTH_ISSUE_TTL_MS) return null;
    return this.lastAuthIssue;
  }

  clearAuthIssue() {
    this.lastAuthIssue = null;
  }

  logoutCredentials() {
    const result = forgetCredentials(this.now());
    this.cache = null;
    this.clearPersistentCache();
    this.clearRateLimit();
    this.clearAuthIssue();
    this.appFallbackBlockedUntilMs = 0;
    return result;
  }

  noteRateLimit(error, nowMs = this.now()) {
    this.rateLimitAttempts += 1;
    const fallbackMs = Math.min(
      RATE_LIMIT_MAX_BACKOFF_MS,
      RATE_LIMIT_FALLBACK_BACKOFF_MS * (2 ** Math.max(0, this.rateLimitAttempts - 1)),
    );
    const retryAfterMs = error?.retryAfterMs && error.retryAfterMs > 0
      ? error.retryAfterMs
      : fallbackMs;
    this.rateLimitedUntilMs = nowMs + Math.min(RATE_LIMIT_MAX_BACKOFF_MS, retryAfterMs);
    this.lastRateLimitError = conciseUsageError(error);
  }

  clearRateLimit() {
    this.rateLimitedUntilMs = 0;
    this.rateLimitAttempts = 0;
    this.lastRateLimitError = null;
  }

  async getLiveUsage(force = false) {
    const nowMs = this.now();
    if (!force && this.cache && nowMs - this.cache.fetchedAtMs < this.cacheTtlMs) {
      return normalizeUsage(this.cache.raw, this.cache.credentials, this.cache.fetchedAtMs, false, null, nowMs);
    }

    const errors = [];

    if (nowMs >= this.rateLimitedUntilMs) {
      try {
        const credentials = await this.getRequestCredentials();
        if (hasDisqualifyingSubscription(credentials)) {
          throw subscriptionRequiredError();
        }
        const raw = await fetchJsonWithTimeout(USAGE_URL, {
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            Accept: 'application/json',
            'anthropic-beta': 'oauth-2025-04-20',
          },
        }, this.requestTimeoutMs, this.fetchFn);

        this.clearRateLimit();
        return this.cacheSnapshot({
          raw,
          credentials,
          fetchedAtMs: this.now(),
        });
      } catch (error) {
        if (isHardAuthError(error)) {
          this.noteAuthIssue(error, nowMs);
          throw error;
        }
        if (isRateLimitError(error)) this.noteRateLimit(error, nowMs);
        errors.push(`oauth: ${conciseUsageError(error)}`);
      }
    } else {
      errors.push(`oauth: ${this.lastRateLimitError || 'Claude usage API rate limited'}`);
    }

    try {
      return this.cacheSnapshot(readStatusLineUsageSnapshot(this.now()));
    } catch (error) {
      errors.push(`statusline: ${conciseUsageError(error)}`);
    }

    const cacheAgeMs = this.cache ? this.now() - this.cache.fetchedAtMs : Infinity;
    if ((!this.cache || cacheAgeMs > STATUSLINE_MAX_AGE_MS) && (force || this.now() >= this.appFallbackBlockedUntilMs)) {
      try {
        const snapshot = await this.appUsageSnapshotFn(this.requestTimeoutMs, this.fetchFn);
        this.appFallbackBlockedUntilMs = 0;
        return this.cacheSnapshot(snapshot);
      } catch (error) {
        this.appFallbackBlockedUntilMs = this.now() + RATE_LIMIT_FALLBACK_BACKOFF_MS;
        errors.push(`claude-app-cookie: ${conciseUsageError(error)}`);
      }
    }

    if (this.cache) {
      return normalizeUsage(
        this.cache.raw,
        this.cache.credentials,
        this.cache.fetchedAtMs,
        true,
        null,
        this.now(),
      );
    }

    throw new Error(summarizeUsageSourceErrors(errors));
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
    const nowMs = this.now();
    return {
      has_cache: Boolean(this.cache),
      cache_age_seconds: this.cache
        ? Math.floor((nowMs - this.cache.fetchedAtMs) / 1000)
        : null,
      fetched_at: this.cache ? new Date(this.cache.fetchedAtMs).toISOString() : null,
      rate_limited_until: this.rateLimitedUntilMs > nowMs
        ? new Date(this.rateLimitedUntilMs).toISOString()
        : null,
    };
  }

  async diagnoseCredentials({ refresh = true, probe = false } = {}) {
    try {
      let credentials = readCredentials();
      const nowMs = this.now();
      let refreshError = null;
      let probeError = null;
      if (refresh) {
        try {
          credentials = await this.refreshCredentialsIfNeeded(credentials, nowMs);
        } catch (error) {
          refreshError = error.message;
        }
      }
      if (probe && !refreshError) {
        try {
          await this.getLiveUsage(true);
        } catch (error) {
          probeError = conciseUsageError(error);
        }
      }
      const expired = credentials.expiresAtMs != null && credentials.expiresAtMs <= nowMs + 30_000;
      const authIssue = this.currentAuthIssue(nowMs);
      const needsSubscription = hasDisqualifyingSubscription(credentials)
        || isSubscriptionRequiredText(refreshError)
        || authIssue?.code === 'subscription_required';
      const oauthNotAllowed = authIssue?.code === 'oauth_not_allowed'
        || isOauthNotAllowedText(refreshError)
        || isOauthNotAllowedText(probeError);
      return {
        ok: !expired && !refreshError && !needsSubscription && !oauthNotAllowed,
        source: credentials.source,
        subscription_type: credentials.subscriptionType,
        rate_limit_tier: credentials.rateLimitTier,
        token_expires_at: credentials.expiresAtMs == null
          ? null
          : new Date(credentials.expiresAtMs).toISOString(),
        expired,
        needs_login: !needsSubscription && !oauthNotAllowed && (expired || Boolean(refreshError)),
        needs_subscription: needsSubscription,
        oauth_not_allowed: oauthNotAllowed,
        error: needsSubscription
          ? SUBSCRIPTION_REQUIRED_MESSAGE
          : oauthNotAllowed
          ? OAUTH_NOT_ALLOWED_MESSAGE
          : refreshError || (expired ? 'Claude OAuth credentials expired' : undefined),
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
