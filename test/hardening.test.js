import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertEmailAllowed, handleApiError, readJson, requireVerifiedUser } from '../server/http.js';
import { parseServiceAccount } from '../server/firebaseAdmin.js';

function fakeRes() {
  return { headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, end(body) { this.body = body; } };
}
const status = (code) => (error) => error.status === code;

test('library errors carrying .status are not echoed to the client', () => {
  class GaxiosError extends Error {}
  const res = fakeRes();
  handleApiError(res, Object.assign(new GaxiosError('invalid_grant for svc@proj.iam.gserviceaccount.com'), { status: 400 }));
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body, /gserviceaccount/);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('own 4xx errors keep their message; own 5xx keep status but hide message', () => {
  let res = fakeRes();
  handleApiError(res, Object.assign(new Error('Market not found.'), { status: 404 }));
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /Market not found/);
  res = fakeRes();
  handleApiError(res, Object.assign(new Error('The club email allowlist is not configured.'), { status: 503 }));
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(res.body, /allowlist/);
  res = fakeRes();
  handleApiError(res, Object.assign(new Error('redirect'), { status: 302 }));
  assert.equal(res.statusCode, 500);
});

test('allowlist fails closed everywhere except vercel dev', () => {
  assert.throws(() => assertEmailAllowed('a@b.c', {}), status(503));
  assert.throws(() => assertEmailAllowed('a@b.c', { VERCEL_ENV: 'production' }), status(503));
  assert.throws(() => assertEmailAllowed('a@b.c', { VERCEL_ENV: 'preview', PHILOMARKET_ALLOWED_EMAILS: ' , ' }), status(503));
  assert.doesNotThrow(() => assertEmailAllowed('a@b.c', { VERCEL_ENV: 'development' }));
});

test('allowlist matches case-insensitively and honours the wildcard', () => {
  const env = { VERCEL_ENV: 'production', PHILOMARKET_ALLOWED_EMAILS: 'Member@Club.org, other@club.org' };
  assert.doesNotThrow(() => assertEmailAllowed(' member@club.org ', env));
  assert.throws(() => assertEmailAllowed('m.ember@club.org', env), status(403));
  assert.throws(() => assertEmailAllowed('', env), status(403));
  assert.doesNotThrow(() => assertEmailAllowed('anyone@x.y', { ...env, PHILOMARKET_ALLOWED_EMAILS: '*' }));
});

test('missing, malformed, or oversized bearer tokens are rejected before Firebase is touched', async () => {
  await assert.rejects(requireVerifiedUser({ headers: {} }), status(401));
  await assert.rejects(requireVerifiedUser({ headers: { authorization: 'Basic abc' } }), status(401));
  await assert.rejects(requireVerifiedUser({ headers: { authorization: `Bearer ${'a'.repeat(5000)}` } }), status(401));
});

test('readJson accepts objects and rejects malformed, non-object, and oversized bodies', async () => {
  assert.deepEqual(await readJson({ body: { amount: 1 } }), { amount: 1 });
  assert.deepEqual(await readJson({ body: '{"amount":2}' }), { amount: 2 });
  assert.deepEqual(await readJson({ body: Buffer.from('{"amount":3}') }), { amount: 3 });
  await assert.rejects(readJson({ get body() { throw new SyntaxError('Invalid JSON'); } }), status(400));
  await assert.rejects(readJson({ body: '{oops' }), status(400));
  await assert.rejects(readJson({ body: '[1]' }), status(400));
  await assert.rejects(readJson({ body: [1] }), status(400));
  await assert.rejects(readJson({ body: 'null' }), status(400));
  await assert.rejects(readJson({ body: 'x'.repeat(16_001) }), status(413));
});

test('service account parsing validates shape and project match without echoing contents', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const json = JSON.stringify({ type: 'service_account', project_id: 'proj-a', client_email: 'svc@proj-a.iam.gserviceaccount.com', private_key: pem.replace(/\n/g, '\\n') });
  const parsed = parseServiceAccount(json, { VITE_FIREBASE_PROJECT_ID: 'proj-a' });
  assert.equal(parsed.projectId, 'proj-a');
  assert.match(parsed.privateKey, /^-----BEGIN PRIVATE KEY-----\n/);

  assert.throws(() => parseServiceAccount(json, { VITE_FIREBASE_PROJECT_ID: 'proj-b' }), /different Firebase project/);
  assert.throws(() => parseServiceAccount('', {}), /not configured/);
  assert.throws(() => parseServiceAccount('{"private_key":"SECRET', {}), (error) => !error.message.includes('SECRET'));
  assert.throws(() => parseServiceAccount('[]', {}), /JSON object/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ type: 'authorized_user', project_id: 'p', client_email: 'e', private_key: 'k' }), {}), /service-account key/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ project_id: 'p', client_email: 'e' }), {}), /missing required fields/);
});

test('vercel.json sends anti-framing and nosniff headers on every route', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const all = config.headers.find((entry) => entry.source === '/(.*)');
  const headers = Object.fromEntries(all.headers.map(({ key, value }) => [key.toLowerCase(), value]));
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
});
