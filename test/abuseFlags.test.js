import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFlags, creatorSelfTrading, exclusivePairs, flaggedUids, pumpAndDump, sharedFingerprints, tradeBursts,
} from '../server/abuseFlags.js';
import { isAdminEmail, parseAdminEmails } from '../server/abuseAdmin.js';
import { createWindowLimiter } from '../server/abuseRateLimit.js';
import { buildAuditEvent, readIdempotencyKey, requestDigest, requestFingerprint } from '../server/abuseAudit.js';

const T0 = 1_700_000_000_000;
const ev = (uid, type, marketId, outcomeId, atS, extra = {}) => ({
  uid, type, marketId, outcomeId, amount: 10, ip: `ip-${uid}`, uaHash: `ua-${uid}`, atMs: T0 + atS * 1000, ...extra,
});

test('shared ip + ua across two accounts is flagged; distinct fingerprints are not', () => {
  const events = [
    ev('jax', 'buy', 'm1', 'a', 0, { ip: '10.0.0.5', uaHash: 'abc' }),
    ev('jaxAlt', 'buy', 'm1', 'a', 5, { ip: '10.0.0.5', uaHash: 'abc' }),
    ev('honest', 'buy', 'm1', 'b', 9),
  ];
  const flags = sharedFingerprints(events);
  assert.deepEqual(flags.sharedIpAndUserAgent, [{ ip: '10.0.0.5', uaHash: 'abc', uids: ['jax', 'jaxAlt'], events: 2 }]);
  assert.equal(flags.sharedIp.length, 1);
  assert.equal(flags.sharedUserAgent.length, 1);
  assert.ok(!flags.sharedIp[0].uids.includes('honest'));
});

test('unknown/none fingerprints never group accounts together', () => {
  const events = [
    ev('a', 'buy', 'm', 'x', 0, { ip: 'unknown', uaHash: 'none' }),
    ev('b', 'buy', 'm', 'x', 1, { ip: 'unknown', uaHash: 'none' }),
  ];
  const flags = sharedFingerprints(events);
  assert.deepEqual(flags.sharedIp, []);
  assert.deepEqual(flags.sharedUserAgent, []);
  assert.deepEqual(flags.sharedIpAndUserAgent, []);
});

test('trade bursts: 10 trades in 60s flags, 9 does not, spread out does not', () => {
  const burst = Array.from({ length: 10 }, (_, i) => ev('vedant', i % 2 ? 'sell' : 'buy', 'm', 'x', i * 3));
  const nine = Array.from({ length: 9 }, (_, i) => ev('calm', 'buy', 'm', 'x', i * 3));
  const spread = Array.from({ length: 20 }, (_, i) => ev('slow', 'buy', 'm', 'x', i * 30));
  const result = tradeBursts([...burst, ...nine, ...spread], { burstCount: 10, burstWindowMs: 60_000 });
  assert.deepEqual(result.map((r) => [r.uid, r.count]), [['vedant', 10]]);
});

test('market_create events do not count toward trade bursts', () => {
  const creates = Array.from({ length: 12 }, (_, i) => ev('spammer', 'market_create', `m${i}`, null, i));
  assert.deepEqual(tradeBursts(creates, { burstCount: 10, burstWindowMs: 60_000 }), []);
});

test('exclusive pairs: two accounts alone in two markets are flagged; a third trader clears the market', () => {
  const events = [
    ev('jax', 'buy', 'm1', 'a', 0), ev('alt', 'buy', 'm1', 'a', 10),
    ev('jax', 'buy', 'm2', 'a', 20), ev('alt', 'buy', 'm2', 'a', 30),
    ev('jax', 'buy', 'm3', 'a', 40), ev('alt', 'buy', 'm3', 'a', 50), ev('honest', 'buy', 'm3', 'b', 60),
  ];
  const result = exclusivePairs(events, { minExclusiveTrades: 4 });
  assert.deepEqual(result, [{ uids: ['alt', 'jax'], markets: ['m1', 'm2'], trades: 4 }]);
});

test('exclusive pairs: one market with only two light trades is not flagged', () => {
  const events = [ev('a', 'buy', 'm1', 'x', 0), ev('b', 'buy', 'm1', 'y', 10)];
  assert.deepEqual(exclusivePairs(events, { minExclusiveTrades: 4 }), []);
});

test('pump and dump: holder buys, alt pumps, holder sells within window', () => {
  const events = [
    ev('jax', 'buy', 'm1', 'x', 0),
    ev('alt', 'buy', 'm1', 'x', 60),
    ev('jax', 'sell', 'm1', 'x', 120),
  ];
  assert.deepEqual(pumpAndDump(events, { pumpWindowMs: 30 * 60_000 }), [
    { beneficiary: 'jax', pumper: 'alt', occurrences: 1, markets: ['m1'] },
  ]);
});

test('pump and dump: other outcome, pump before own buy, or outside window are not flagged', () => {
  const window = { pumpWindowMs: 30 * 60_000 };
  assert.deepEqual(pumpAndDump([ev('jax', 'buy', 'm1', 'x', 0), ev('alt', 'buy', 'm1', 'y', 60), ev('jax', 'sell', 'm1', 'x', 120)], window), []);
  assert.deepEqual(pumpAndDump([ev('alt', 'buy', 'm1', 'x', 0), ev('jax', 'buy', 'm1', 'x', 60), ev('jax', 'sell', 'm1', 'x', 120)], window), []);
  assert.deepEqual(pumpAndDump([ev('jax', 'buy', 'm1', 'x', 0), ev('alt', 'buy', 'm1', 'x', 60), ev('jax', 'sell', 'm1', 'x', 60 + 31 * 60)], window), []);
  // Averaging up on your own position and then selling is not a pump by someone else.
  assert.deepEqual(pumpAndDump([ev('jax', 'buy', 'm1', 'x', 0), ev('jax', 'buy', 'm1', 'x', 60), ev('jax', 'sell', 'm1', 'x', 120)], window), []);
});

test('creator self-trading uses both market docs and market_create events', () => {
  const events = [
    ev('jax', 'market_create', 'm2', null, 0),
    ev('jax', 'buy', 'm2', 'x', 10, { amount: 25 }),
    ev('jax', 'sell', 'm2', 'x', 20, { amount: 30.5 }),
    ev('vedant', 'buy', 'm1', 'x', 30, { amount: 40 }),
    ev('jax', 'buy', 'm1', 'x', 40),
  ];
  const result = creatorSelfTrading(events, { m1: 'vedant' });
  assert.deepEqual(result, [
    { uid: 'jax', marketId: 'm2', trades: 2, bought: 25, sold: 30.5 },
    { uid: 'vedant', marketId: 'm1', trades: 1, bought: 40, sold: 0 },
  ]);
});

test('computeFlags on a clean log reports nothing; flaggedUids collects every flagged account', () => {
  const clean = [ev('a', 'buy', 'm1', 'x', 0), ev('b', 'buy', 'm2', 'x', 100), ev('c', 'buy', 'm3', 'y', 200)];
  const flags = computeFlags(clean);
  for (const key of ['sharedIpAndUserAgent', 'sharedIp', 'sharedUserAgent', 'tradeBursts', 'exclusivePairs', 'pumpAndDump', 'creatorSelfTrading']) {
    assert.deepEqual(flags[key], [], key);
  }
  assert.deepEqual(flaggedUids(flags), []);

  const dirty = computeFlags([
    ev('jax', 'buy', 'm1', 'x', 0, { ip: '1.1.1.1', uaHash: 'u' }),
    ev('alt', 'buy', 'm1', 'x', 60, { ip: '1.1.1.1', uaHash: 'u' }),
    ev('jax', 'sell', 'm1', 'x', 120, { ip: '1.1.1.1', uaHash: 'u' }),
  ], { creatorsByMarket: { m1: 'jax' } });
  assert.equal(dirty.pumpAndDump.length, 1);
  assert.equal(dirty.creatorSelfTrading.length, 1);
  assert.deepEqual(flaggedUids(dirty), ['alt', 'jax']);
});

test('malformed events are ignored rather than crashing', () => {
  const flags = computeFlags([null, {}, { uid: 'x' }, { uid: 'y', atMs: 'soon' }, ev('ok', 'buy', 'm', 'x', 0)]);
  assert.equal(flags.eventCount, 1);
  assert.deepEqual(computeFlags(undefined).eventCount, 0);
});

test('admin allow-list fails closed and ignores wildcards', () => {
  assert.equal(isAdminEmail('joshua@example.com', undefined), false);
  assert.equal(isAdminEmail('joshua@example.com', ''), false);
  assert.equal(isAdminEmail('joshua@example.com', '*'), false);
  assert.equal(isAdminEmail('anyone@example.com', '*, joshua@example.com'), false);
  assert.equal(isAdminEmail(' Joshua@Example.com ', 'joshua@example.com'), true);
  assert.equal(isAdminEmail('joshua+x@example.com', 'joshua@example.com'), false);
  assert.equal(isAdminEmail(undefined, 'joshua@example.com'), false);
  assert.deepEqual(parseAdminEmails(' a@x.com, ,*,b@y.com,notanemail'), ['a@x.com', 'b@y.com']);
});

test('idempotency key parsing, request digest, and fingerprint', () => {
  assert.equal(readIdempotencyKey({ headers: {} }, {}), null);
  assert.equal(readIdempotencyKey({ headers: { 'idempotency-key': 'abcDEF12-_' } }, {}), 'abcDEF12-_');
  assert.equal(readIdempotencyKey({ headers: {} }, { idempotencyKey: 'body-key-123' }), 'body-key-123');
  assert.throws(() => readIdempotencyKey({ headers: { 'idempotency-key': 'short' } }, {}), (e) => e.status === 400);
  assert.throws(() => readIdempotencyKey({ headers: { 'idempotency-key': 'has space!!' } }, {}), (e) => e.status === 400);
  assert.notEqual(requestDigest('buy', { marketId: 'm', outcomeId: 'x', amount: 1 }), requestDigest('buy', { marketId: 'm', outcomeId: 'x', amount: 2 }));
  assert.equal(requestDigest('buy', { a: 1 }), requestDigest('buy', { a: 1 }));

  const fp = requestFingerprint({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'Mozilla/5.0' } });
  assert.equal(fp.ip, '203.0.113.9');
  assert.match(fp.uaHash, /^[0-9a-f]{16}$/);
  assert.deepEqual(requestFingerprint({ headers: {} }), { ip: 'unknown', uaHash: 'none' });
  const event = buildAuditEvent({ type: 'buy', uid: 'u', marketId: 'm', outcomeId: 'x', amount: 5, fingerprint: fp, nowMs: 1 });
  assert.deepEqual(Object.keys(event).sort(), ['amount', 'atMs', 'idempotencyKey', 'ip', 'marketId', 'outcomeId', 'shares', 'type', 'uaHash', 'uid']);
});

test('window limiter allows `limit` per key per window and resets after it', () => {
  const allow = createWindowLimiter({ limit: 3, windowMs: 1000, maxKeys: 2 });
  assert.deepEqual([allow('a', 0), allow('a', 1), allow('a', 2), allow('a', 3)], [true, true, true, false]);
  assert.equal(allow('b', 10), true, 'keys are independent');
  assert.equal(allow('a', 1000), true, 'window resets');
  assert.equal(allow('c', 1001), true, 'evicts when full instead of growing');
});
