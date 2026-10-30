import { getAdminServices } from './firebaseAdmin.js';

const MAX_BODY_BYTES = 16_000;
const MAX_ID_TOKEN_LENGTH = 4_096;

function clientError(message, status) {
  return Object.assign(new Error(message), { status });
}

export function sendJson(res, status, body, { cacheControl = 'no-store' } = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

export function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { error: 'Method not allowed.' });
}

function parseObject(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw clientError('Request is too large.', 413);
  if (!text) return {};
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw clientError('Request body must be valid JSON.', 400); }
  return requireObject(parsed);
}

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw clientError('Request body must be a JSON object.', 400);
  }
  return value;
}

export async function readJson(req) {
  // Vercel's req.body is a lazy getter that throws on malformed JSON.
  let body;
  try { body = req.body; }
  catch { throw clientError('Request body must be valid JSON.', 400); }

  if (Buffer.isBuffer(body)) return parseObject(body.toString('utf8'));
  if (typeof body === 'string') return parseObject(body);
  if (body && typeof body === 'object') {
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
      throw clientError('Request is too large.', 413);
    }
    return requireObject(body);
  }

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw clientError('Request is too large.', 413);
  }
  return parseObject(raw);
}

// Exported for tests. An empty allowlist only means "allow any verified email"
// under `vercel dev`; every other environment (Vercel Preview/Production, or
// any non-Vercel host where VERCEL_ENV is unset) fails closed.
export function assertEmailAllowed(rawEmail, env = process.env) {
  const allowedEmails = (env.PHILOMARKET_ALLOWED_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const isLocalDev = env.VERCEL_ENV === 'development';
  if (allowedEmails.length === 0) {
    if (isLocalDev) return;
    throw clientError('The club email allowlist is not configured.', 503);
  }
  if (allowedEmails.includes('*')) return;
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email || !allowedEmails.includes(email)) {
    throw clientError('This verified email is not on the Philomarket club allowlist.', 403);
  }
}

export async function requireVerifiedUser(req) {
  const header = req.headers?.authorization || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match || match[1].length > MAX_ID_TOKEN_LENGTH) {
    throw clientError('Sign in with a verified email to continue.', 401);
  }

  const { auth } = getAdminServices();
  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1], true);
  } catch {
    throw clientError('Your sign-in expired. Sign in again to continue.', 401);
  }
  if (decoded.email_verified !== true) {
    throw clientError('Verify your email before using points or creating markets.', 403);
  }
  assertEmailAllowed(decoded.email);
  return decoded;
}

// Only errors this codebase raised on purpose (a plain `Error` with an HTTP
// status) keep their status. Library errors such as GaxiosError also expose
// `.status`, but their messages can carry project ids, service-account emails,
// or upstream details, so they become a generic 500. 5xx messages are never
// sent to the client.
function ownStatus(error) {
  const plain = error instanceof Error && Object.getPrototypeOf(error) === Error.prototype;
  const status = error?.status;
  return plain && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

export function handleApiError(res, error) {
  const status = ownStatus(error);
  if (status < 500) return sendJson(res, status, { error: error.message });
  console.error('Philomarket API error:', error?.name || 'Error', error?.message || 'Unknown error');
  return sendJson(res, status, { error: 'The market service is temporarily unavailable.' });
}

export function makeUserRef(db, uid) {
  return db.collection('users').doc(uid);
}

export function profileFrom(uid, email, data) {
  return {
    uid,
    email,
    points: data.points,
    marketsCreated: data.marketsCreated || 0,
  };
}
