import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildWindow, formatDurationUntil, normalizeUsage, refreshCredentials, summarizeUsageSourceErrors, UsageService } from '../src/usage.js';

test('window normalization clamps percentages and formats reset duration', () => {
  const now = Date.parse('2026-05-13T00:00:00.000Z');
  const win = buildWindow({
    utilization: 128.4,
    resets_at: '2026-05-13T02:30:00.000Z',
  }, now);

  assert.equal(win.used_percent, 100);
  assert.equal(win.remaining_percent, 0);
  assert.equal(win.resets_in, '2h 30m');
});

test('duration formatting handles sub-minute and elapsed reset times', () => {
  const now = Date.parse('2026-05-13T00:00:00.000Z');
  assert.equal(formatDurationUntil(now + 45_000, now), '45s');
  assert.equal(formatDurationUntil(now - 1_000, now), 'now');
});

test('usage normalization reports age from supplied clock', () => {
  const fetched = 1_000_000;
  const data = normalizeUsage({
    five_hour: { utilization: 25 },
    seven_day: { utilization: 60 },
  }, {
    source: 'test',
    subscriptionType: 'pro',
    rateLimitTier: 'tier',
    expiresAtMs: null,
  }, fetched, false, null, fetched + 42_000);

  assert.equal(data.current.remaining_percent, 75);
  assert.equal(data.weekly.remaining_percent, 40);
  assert.equal(data.age_seconds, 42);
});

test('OAuth refresh persists rotated tokens to credential storage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-refresh-'));
  const file = path.join(dir, 'credentials.json');
  const payload = {
    claudeAiOauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: 1,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: 'default',
    },
  };
  fs.writeFileSync(file, JSON.stringify(payload));

  const updated = await refreshCredentials({
    source: file,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAtMs: 1,
    subscriptionType: 'pro',
    rateLimitTier: 'default',
    _rawPayload: payload,
    _credentialKey: 'claudeAiOauth',
    _storage: { type: 'file', file },
  }, {
    nowMs: 1_000_000,
    fetchFn: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user:inference user:profile',
        subscription_type: 'pro',
        rate_limit_tier: 'default_claude_ai',
      }),
    }),
  });

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(updated.accessToken, 'new-access');
  assert.equal(updated.refreshToken, 'new-refresh');
  assert.equal(saved.claudeAiOauth.accessToken, 'new-access');
  assert.equal(saved.claudeAiOauth.refreshToken, 'new-refresh');
  assert.equal(saved.claudeAiOauth.expiresAt, 4_600_000);
});

test('usage service backs off after 429 and serves stale cache without retrying immediately', async () => {
  const previousToken = process.env.CLAUDE_USAGE_ACCESS_TOKEN;
  process.env.CLAUDE_USAGE_ACCESS_TOKEN = 'test-token';
  let now = Date.parse('2026-05-13T00:00:00.000Z');
  let calls = 0;
  let oauthCalls = 0;

  try {
    const service = new UsageService({
      cacheTtlMs: 0,
      persistentCacheFile: null,
      now: () => now,
      fetchFn: async (url) => {
        calls += 1;
        if (String(url).includes('/api/oauth/usage')) oauthCalls += 1;
        if (calls === 1) {
          return {
            ok: true,
            text: async () => JSON.stringify({
              five_hour: { utilization: 12, resets_at: now + 60_000 },
              seven_day: { utilization: 34, resets_at: now + 120_000 },
            }),
          };
        }
        return {
          ok: false,
          status: 429,
          headers: { get: () => '0' },
          text: async () => JSON.stringify({
            error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' },
          }),
        };
      },
    });

    const live = await service.getLiveUsage(true);
    assert.equal(live.current.used_percent, 12);

    now += 61_000;
    const stale = await service.getLiveUsage(true);
    assert.equal(stale.stale, true);
    assert.equal(stale.error, null);
    assert.equal(calls, 2);
    assert.equal(oauthCalls, 2);

    now += 1_000;
    const backedOff = await service.getLiveUsage(true);
    assert.equal(backedOff.stale, true);
    assert.equal(calls, 2);
    assert.equal(oauthCalls, 2);
  } finally {
    if (previousToken == null) delete process.env.CLAUDE_USAGE_ACCESS_TOKEN;
    else process.env.CLAUDE_USAGE_ACCESS_TOKEN = previousToken;
  }
});

test('usage service treats Claude Code subscription loss as a hard state', async () => {
  const previousToken = process.env.CLAUDE_USAGE_ACCESS_TOKEN;
  process.env.CLAUDE_USAGE_ACCESS_TOKEN = 'test-token';

  try {
    const service = new UsageService({
      persistentCacheFile: null,
      fetchFn: async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
        text: async () => 'Claude Max or Pro is required to connect to Claude Code',
      }),
    });

    await assert.rejects(
      () => service.getLiveUsage(true),
      /Claude Pro\/Max required/,
    );
  } finally {
    if (previousToken == null) delete process.env.CLAUDE_USAGE_ACCESS_TOKEN;
    else process.env.CLAUDE_USAGE_ACCESS_TOKEN = previousToken;
  }
});

test('usage service treats organization OAuth denial as a hard auth state', async () => {
  const previousToken = process.env.CLAUDE_USAGE_ACCESS_TOKEN;
  process.env.CLAUDE_USAGE_ACCESS_TOKEN = 'test-token';

  try {
    const service = new UsageService({
      persistentCacheFile: null,
      fetchFn: async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'OAuth authentication is currently not allowed for this organization.',
          },
        }),
      }),
    });

    await assert.rejects(
      () => service.getLiveUsage(true),
      /Claude Code OAuth not allowed/,
    );

    const diagnostic = await service.diagnoseCredentials({ probe: false });
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.oauth_not_allowed, true);
  } finally {
    if (previousToken == null) delete process.env.CLAUDE_USAGE_ACCESS_TOKEN;
    else process.env.CLAUDE_USAGE_ACCESS_TOKEN = previousToken;
  }
});

test('usage source errors collapse when every fallback is unavailable', () => {
  assert.equal(summarizeUsageSourceErrors([
    'oauth: Claude usage access blocked',
    'statusline: fresh Claude Code statusline usage cache not found',
    'claude-app-cookie: Claude usage source unavailable',
  ]), 'Claude usage source unavailable');
});

test('forced refresh retries Claude app fallback even after a temporary block', async () => {
  const previousToken = process.env.CLAUDE_USAGE_ACCESS_TOKEN;
  process.env.CLAUDE_USAGE_ACCESS_TOKEN = 'test-token';
  const now = Date.parse('2026-05-14T00:00:00.000Z');
  let appFallbackCalls = 0;

  try {
    const service = new UsageService({
      cacheTtlMs: 0,
      persistentCacheFile: null,
      now: () => now,
      fetchFn: async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          error: { type: 'forbidden', message: 'Request not allowed' },
        }),
      }),
      appUsageSnapshotFn: async () => {
        appFallbackCalls += 1;
        if (appFallbackCalls === 1) {
          throw new Error('Claude usage source unavailable');
        }
        return {
          raw: {
            five_hour: { utilization: 7 },
            seven_day: { utilization: 9 },
          },
          credentials: {
            source: 'Claude app cookie',
            subscriptionType: null,
            rateLimitTier: null,
            expiresAtMs: null,
          },
          fetchedAtMs: now,
        };
      },
    });

    await assert.rejects(
      () => service.getLiveUsage(false),
      /Claude usage source unavailable/,
    );
    assert.equal(appFallbackCalls, 1);

    await assert.rejects(
      () => service.getLiveUsage(false),
      /Claude usage source unavailable/,
    );
    assert.equal(appFallbackCalls, 1);

    const live = await service.getLiveUsage(true);
    assert.equal(appFallbackCalls, 2);
    assert.equal(live.source, 'Claude app cookie');
    assert.equal(live.current.used_percent, 7);
    assert.equal(live.weekly.used_percent, 9);
  } finally {
    if (previousToken == null) delete process.env.CLAUDE_USAGE_ACCESS_TOKEN;
    else process.env.CLAUDE_USAGE_ACCESS_TOKEN = previousToken;
  }
});

test('usage service loads persistent cache when live sources are temporarily unavailable', async () => {
  const previousToken = process.env.CLAUDE_USAGE_ACCESS_TOKEN;
  process.env.CLAUDE_USAGE_ACCESS_TOKEN = 'test-token';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-persistent-'));
  const cacheFile = path.join(dir, 'usage-cache.json');
  const now = Date.parse('2026-05-14T00:00:00.000Z');
  fs.writeFileSync(cacheFile, JSON.stringify({
    raw: {
      five_hour: { utilization: 22 },
      seven_day: { utilization: 44 },
    },
    credentials: {
      source: 'macOS Keychain',
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_ai',
      accessToken: 'must-not-be-used',
    },
    fetchedAtMs: now - 30 * 60 * 1000,
  }));

  try {
    const service = new UsageService({
      cacheTtlMs: 0,
      persistentCacheFile: cacheFile,
      now: () => now,
      fetchFn: async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          error: { type: 'forbidden', message: 'Request not allowed' },
        }),
      }),
      appUsageSnapshotFn: async () => {
        throw new Error('Claude usage source unavailable');
      },
    });

    const stale = await service.getLiveUsage(true);
    assert.equal(stale.stale, true);
    assert.equal(stale.current.used_percent, 22);
    assert.equal(stale.weekly.used_percent, 44);
    assert.equal(stale.account.credential_source, 'macOS Keychain');
    assert.equal(stale.account.token_expires_at, null);
  } finally {
    if (previousToken == null) delete process.env.CLAUDE_USAGE_ACCESS_TOKEN;
    else process.env.CLAUDE_USAGE_ACCESS_TOKEN = previousToken;
  }
});

test('persistent cache written after live success omits tokens', async () => {
  const previousToken = process.env.CLAUDE_USAGE_ACCESS_TOKEN;
  process.env.CLAUDE_USAGE_ACCESS_TOKEN = 'test-token';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-persistent-write-'));
  const cacheFile = path.join(dir, 'usage-cache.json');
  const now = Date.parse('2026-05-14T00:00:00.000Z');

  try {
    const service = new UsageService({
      persistentCacheFile: cacheFile,
      now: () => now,
      fetchFn: async () => ({
        ok: true,
        text: async () => JSON.stringify({
          five_hour: { utilization: 11 },
          seven_day: { utilization: 33 },
        }),
      }),
    });

    const live = await service.getLiveUsage(true);
    assert.equal(live.current.used_percent, 11);
    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(saved.credentials.source, 'environment');
    assert.equal(saved.credentials.accessToken, undefined);
    assert.equal(saved.credentials.refreshToken, undefined);
    assert.equal(saved.raw.five_hour.utilization, 11);
  } finally {
    if (previousToken == null) delete process.env.CLAUDE_USAGE_ACCESS_TOKEN;
    else process.env.CLAUDE_USAGE_ACCESS_TOKEN = previousToken;
  }
});
