export const DEVICE_PAYLOAD_VERSION = 1;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compactText(value, max = 64) {
  if (value == null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}.` : text;
}

export function makeCompactPayload(data) {
  const current = data?.current || {};
  const weekly = data?.weekly || {};
  const updatedAt = finiteNumber(data?.updated_at) ?? Math.floor(Date.now() / 1000);
  const currentUsed = finiteNumber(current.used_percent);
  const weeklyUsed = finiteNumber(weekly.used_percent);
  const seed = (
    ((updatedAt || 1) * 2654435761)
    ^ ((currentUsed ?? 0) * 97)
    ^ ((weeklyUsed ?? 0) * 193)
  ) >>> 0;

  return {
    v: DEVICE_PAYLOAD_VERSION,
    cu: currentUsed,
    cr: finiteNumber(current.remaining_percent),
    ri: compactText(current.resets_in, 18),
    wu: weeklyUsed,
    wr: finiteNumber(weekly.remaining_percent),
    wi: compactText(weekly.resets_in, 18),
    m: compactText(data?.model || data?.account?.rate_limit_tier || '', 16),
    d: Boolean(data?.demo),
    s: compactText(data?.status || (data?.stale ? 'stale' : 'live'), 12),
    age: finiteNumber(data?.age_seconds),
    stale: Boolean(data?.stale),
    src: compactText(data?.source || '', 20),
    err: compactText(data?.error || '', 54),
    ts: updatedAt,
    fs: seed || 1,
  };
}

export function makePayload(data) {
  return JSON.stringify(makeCompactPayload(data));
}

export function makePayloadLine(data) {
  return `${makePayload(data)}\n`;
}

export function makeDeviceStatusPayload(status, message, nowMs = Date.now()) {
  return {
    source: 'bridge',
    status,
    current: {
      used_percent: null,
      remaining_percent: null,
      resets_in: null,
    },
    weekly: {
      used_percent: null,
      remaining_percent: null,
      resets_in: null,
    },
    updated_at: Math.floor(nowMs / 1000),
    age_seconds: 0,
    stale: status !== 'live',
    demo: false,
    error: message || null,
  };
}
