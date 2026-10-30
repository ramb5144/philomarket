// Server-side audit log + idempotency helpers. No Firebase imports, so the
// pure parts are unit-testable; Firestore objects are passed in by callers.
import { createHash } from 'node:crypto';

export const AUDIT_COLLECTION = 'auditLog';
export const IDEMPOTENCY_COLLECTION = 'idempotencyKeys';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function firstHeader(req, name) {
  const value = req?.headers?.[name];
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
}

// Vercel overwrites x-forwarded-for / x-vercel-forwarded-for at its edge, so
// a client cannot spoof them on hosted deployments.
export function clientIp(req) {
  const forwarded = firstHeader(req, 'x-vercel-forwarded-for')
    || firstHeader(req, 'x-forwarded-for')
    || firstHeader(req, 'x-real-ip');
  const ip = forwarded.split(',')[0].trim();
  return ip || req?.socket?.remoteAddress || 'unknown';
}

export function userAgentHash(req) {
  const ua = firstHeader(req, 'user-agent').trim();
  return ua ? sha256(ua).slice(0, 16) : 'none';
}

export function requestFingerprint(req) {
  return { ip: clientIp(req).slice(0, 64), uaHash: userAgentHash(req) };
}

// Optional key from the Idempotency-Key header or body.idempotencyKey.
// Returns null when absent; throws 400 when present but malformed.
export function readIdempotencyKey(req, body) {
  const raw = firstHeader(req, 'idempotency-key') || (typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : '');
  if (!raw) return null;
  if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw Object.assign(new Error('Invalid request key. Refresh and try again.'), { status: 400 });
  }
  return raw;
}

// Fingerprint of the request parameters so a reused key with different
// parameters is rejected instead of silently returning another trade's result.
export function requestDigest(route, params) {
  return sha256(JSON.stringify([route, params])).slice(0, 32);
}

export function idempotencyRef(db, uid, key) {
  return db.collection(IDEMPOTENCY_COLLECTION).doc(sha256(`${uid}:${key}`));
}

// Call inside the transaction, before any write. Returns the stored response
// for a replay, null for a fresh key, and throws 422 for a reused key whose
// parameters differ.
export async function readIdempotentReplay(transaction, ref, uid, digest) {
  if (!ref) return null;
  const snapshot = await transaction.get(ref);
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (data.uid !== uid || data.digest !== digest) {
    throw Object.assign(new Error('This request key was already used for a different trade.'), { status: 422 });
  }
  try {
    return JSON.parse(data.response);
  } catch {
    throw Object.assign(new Error('This trade was already processed. Refresh to see it.'), { status: 409 });
  }
}

export function writeIdempotency(transaction, ref, { uid, route, digest, response, nowMs = Date.now() }, FieldValue) {
  if (!ref) return;
  transaction.create(ref, {
    uid,
    route,
    digest,
    response: JSON.stringify(response),
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: new Date(nowMs + IDEMPOTENCY_TTL_MS),
  });
}

export function buildAuditEvent({ type, uid, marketId, outcomeId = null, amount = null, shares = null, fingerprint, idempotencyKey = null, nowMs = Date.now() }) {
  return {
    type,
    uid,
    marketId,
    outcomeId,
    amount,
    shares,
    ip: fingerprint?.ip || 'unknown',
    uaHash: fingerprint?.uaHash || 'none',
    idempotencyKey,
    atMs: nowMs,
  };
}

// Append-only: always create() with a fresh auto-id, never update or delete.
export function writeAuditEvent(transaction, db, event, FieldValue) {
  const ref = db.collection(AUDIT_COLLECTION).doc();
  transaction.create(ref, { ...event, at: FieldValue.serverTimestamp() });
  return ref;
}
