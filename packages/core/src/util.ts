/**
 * Small helpers shared by the bridge: UTF-8 safe truncation, secret masking
 * and input coercion. Kept dependency free so they can be unit tested.
 */

/** Cut text to at most maxBytes of UTF-8 without splitting a code point. */
export function truncateUtf8(
  text: string,
  maxBytes: number,
  mode: 'head' | 'both' = 'both'
): string {
  if (!text) return text;
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  const marker = '\n…（内容过长，已截断）…\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes <= markerBytes + 16) {
    return sliceUtf8(Buffer.from(text, 'utf8'), 0, maxBytes);
  }

  const buf = Buffer.from(text, 'utf8');
  const budget = maxBytes - markerBytes;

  if (mode === 'head') {
    return sliceUtf8(buf, 0, budget) + marker;
  }

  // Keep both ends: command errors usually sit at the tail.
  const headBudget = Math.floor(budget * 0.6);
  const tailBudget = budget - headBudget;
  return sliceUtf8(buf, 0, headBudget) + marker + sliceUtf8FromEnd(buf, tailBudget);
}

function sliceUtf8(buf: Buffer, start: number, length: number): string {
  let end = Math.min(buf.length, start + length);
  while (end > start && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(start, end).toString('utf8');
}

function sliceUtf8FromEnd(buf: Buffer, length: number): string {
  let start = Math.max(0, buf.length - length);
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

/** Show only the ends of a secret, never enough to reuse it. */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 12) return '••••••••';
  return `${secret.slice(0, 3)}••••${secret.slice(-3)}`;
}

/** Whether a value is the masked placeholder we handed out, not a new secret. */
export function looksMasked(value: string): boolean {
  return typeof value === 'string' && value.includes('••••');
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function asTrimmedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

export function asStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, maxLength);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}
