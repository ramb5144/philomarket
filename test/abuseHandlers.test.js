// Handler-level tests against an in-memory Firestore fake (no live Firebase).
// Proves the wiring: idempotent replay, audit append, email-variant binding,
// and admin fail-closed. Firestore contention semantics are NOT modelled.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let clock = 1_700_000_000_000;
// Server timestamps follow Date.now(); `skew` advances time past the cooldown.
let skew = 0;
const systemNow = Date.now;
Date.now = () => systemNow() + skew;
const stamp = () => { const at = Date.now(); return { toMillis: () => at, toDate: () => new Date(at) }; };
const FieldValue = { serverTimestamp: stamp };
// Shallow-ish clone that keeps Timestamp-like objects (with methods) intact.
const clone = (v) => (v === undefined ? v : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? x.map((e) => (e && typeof e === 'object' ? { ...e } : e)) : x])));

class FakeDb {
  constructor() { this.docs = new Map(); this.auto = 0; this.reads = 0; }
  collection(name, prefix = '') {
    const db = this;
    const path = prefix ? `${prefix}/${name}` : name;
    const query = { filters: [], order: null, max: Infinity };
    const api = {
      doc(id) { return db.ref(`${path}/${id ?? `auto${++db.auto}`}`); },
      where(field, op, value) { query.filters.push([field, op, value]); return api; },
      orderBy(field, dir) { query.order = [field, dir]; return api; },
      limit(n) { query.max = n; return api; },
      select() { return api; },
      async get() {
        let docs = [...db.docs.entries()]
          .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
          .map(([p]) => db.snap(db.ref(p)));
        for (const [field, op, value] of query.filters) {
          assert.equal(op, '>=');
          const ms = (x) => (typeof x?.toMillis === 'function' ? x.toMillis() : x);
          docs = docs.filter((d) => ms(d.get(field)) >= ms(value));
        }
        if (query.order) docs.sort((a, b) => (a.get(query.order[0]) - b.get(query.order[0])) * (query.order[1] === 'desc' ? -1 : 1));
        docs = docs.slice(0, query.max);
        db.reads += Math.max(1, docs.length);
        return { docs, size: docs.length };
      },
    };
    return api;
  }
  ref(path) {
    const db = this;
    return { path, id: path.split('/').pop(), collection: (n) => db.collection(n, path), get: async () => { db.reads += 1; return db.snap({ path }); } };
  }
  snap(ref) {
    const data = this.docs.get(ref.path);
    return { id: ref.path.split('/').pop(), exists: data !== undefined, data: () => clone(data), get: (f) => data?.[f] };
  }
  async runTransaction(fn) {
    const writes = [];
    const tx = {
      get: async (ref) => { this.reads += 1; return this.snap(ref); },
      create: (ref, data) => writes.push(() => {
        if (this.docs.has(ref.path)) throw Object.assign(new Error(`ALREADY_EXISTS ${ref.path}`), { status: 500 });
        this.docs.set(ref.path, data);
      }),
      update: (ref, data) => writes.push(() => this.docs.set(ref.path, { ...this.docs.get(ref.path), ...data })),
      set: (ref, data, opts) => writes.push(() => this.docs.set(ref.path, opts?.merge ? { ...this.docs.get(ref.path), ...data } : data)),
    };
    const result = await fn(tx);
    for (const w of writes) w();
    return result;
  }
  count(prefix) { return [...this.docs.keys()].filter((k) => k.startsWith(`${prefix}/`)).length; }
}

// mock.module needs `node --test --experimental-test-module-mocks`. Without the
// flag these tests are reported as SKIPPED (visible in the summary), not passed.
const canMockModules = typeof mock.module === 'function';
if (!canMockModules) {
  test('handler wiring tests (need --experimental-test-module-mocks)', { skip: 'run: node --test --experimental-test-module-mocks test/' }, () => {});
} else {
  const users = {
    'tok-jax': { uid: 'jax', email: 'jax.smith@gmail.com', email_verified: true },
    'tok-jaxalt': { uid: 'jaxalt', email: 'J.A.X.Smith+alt@gmail.com', email_verified: true },
    'tok-admin': { uid: 'admin', email: 'boss@club.org', email_verified: true },
  };
  let db;
  // The hardening branch makes an empty allow-list fail closed (503) outside
  // `vercel dev`, so the handler fixtures declare the three test mailboxes
  // explicitly, the way production should.
  process.env.PHILOMARKET_ALLOWED_EMAILS = Object.values(users).map((u) => u.email).join(',');
  const auth = {
    verifyIdToken: async (token) => { if (!users[token]) throw new Error('bad'); return users[token]; },
    getUsers: async (ids) => ({
      users: ids.map(({ uid }) => Object.values(users).find((u) => u.uid === uid)).filter(Boolean).map((u) => ({ uid: u.uid, email: u.email })),
      notFound: ids.filter(({ uid }) => !Object.values(users).some((u) => u.uid === uid)),
    }),
  };
  mock.module(new URL('../server/firebaseAdmin.js', import.meta.url).href, {
    exports: { getAdminServices: () => ({ db, auth, FieldValue }) },
  });
  const back = (await import('../api/markets/[id]/back.js')).default;
  const sell = (await import('../api/markets/[id]/sell.js')).default;
  const profile = (await import('../api/profile.js')).default;
  const flagsHandler = (await import('../api/admin/flags.js')).default;
  const marketsHandler = (await import('../api/markets.js')).default;

  async function call(handler, { token, body, id = 'm1', key, method = 'POST', query = {} }) {
    const headers = { 'user-agent': 'TestUA/1.0', 'x-forwarded-for': '198.51.100.7' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } };
    await handler({ method, headers, body, query: { id, ...query } }, res);
    return res;
  }

  function seed() {
    db = new FakeDb();
    db.docs.set('markets/m1', {
      question: 'Will it rain?', outcomes: [{ id: 'yes-1', label: 'Yes', shares: 0 }, { id: 'no-2', label: 'No', shares: 0 }],
      liquidity: 10000, pointPool: 0, status: 'open', creatorUid: 'jax', priceHistory: [],
    });
  }

  test('buy with an idempotency key: replay returns the original result, trades once, audits once', async () => {
    seed();
    const first = await call(back, { token: 'tok-jax', key: 'key-aaaa-0001', body: { amount: 50, outcomeId: 'yes-1' } });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(first.body.profile.points, 450);
    const replay = await call(back, { token: 'tok-jax', key: 'key-aaaa-0001', body: { amount: 50, outcomeId: 'yes-1' } });
    assert.equal(replay.statusCode, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, first.body);
    assert.equal(db.docs.get('users/jax').points, 450, 'points deducted once');
    assert.equal(db.count('auditLog'), 1);
    const audit = [...db.docs.entries()].find(([k]) => k.startsWith('auditLog/'))[1];
    assert.equal(audit.type, 'buy');
    assert.equal(audit.uid, 'jax');
    assert.equal(audit.ip, '198.51.100.7');
    assert.match(audit.uaHash, /^[0-9a-f]{16}$/);
    assert.equal(audit.idempotencyKey, 'key-aaaa-0001');

    const reused = await call(back, { token: 'tok-jax', key: 'key-aaaa-0001', body: { amount: 60, outcomeId: 'yes-1' } });
    assert.equal(reused.statusCode, 422);
    const fresh = await call(back, { token: 'tok-jax', key: 'key-aaaa-0002', body: { amount: 10, outcomeId: 'yes-1' } });
    assert.equal(fresh.statusCode, 429, 'a new key is still subject to the cooldown');
    const noKey = await call(back, { token: 'tok-jax', body: { amount: 10, outcomeId: 'yes-1' } });
    assert.equal(noKey.statusCode, 429);
  });

  test('sell is audited and idempotent, including the all flag in the key digest', async () => {
    seed();
    assert.equal((await call(back, { token: 'tok-jax', body: { amount: 100, outcomeId: 'yes-1' } })).statusCode, 200);
    skew += 5_000;
    const s1 = await call(sell, { token: 'tok-jax', key: 'sell-key-001', body: { all: true, outcomeId: 'yes-1' } });
    assert.equal(s1.statusCode, 200, JSON.stringify(s1.body));
    const s2 = await call(sell, { token: 'tok-jax', key: 'sell-key-001', body: { all: true, outcomeId: 'yes-1' } });
    assert.deepEqual(s2.body, s1.body);
    const s3 = await call(sell, { token: 'tok-jax', key: 'sell-key-001', body: { amount: 1, outcomeId: 'yes-1' } });
    assert.equal(s3.statusCode, 422);
    const types = [...db.docs.entries()].filter(([k]) => k.startsWith('auditLog/')).map(([, v]) => v.type).sort();
    assert.deepEqual(types, ['buy', 'sell']);
  });

  test('a dot/plus Gmail variant cannot bind a second account to the same mailbox', async () => {
    seed();
    assert.equal((await call(profile, { token: 'tok-jax', method: 'GET' })).statusCode, 200);
    const alt = await call(profile, { token: 'tok-jaxalt', method: 'GET' });
    assert.equal(alt.statusCode, 403, JSON.stringify(alt.body));
    assert.equal(db.docs.has('users/jaxalt'), false);
  });

  test('admin flags: fails closed when unset, hides from non-admins, reports for admins', async () => {
    seed();
    // jax buys, jaxalt (simulated pre-existing alt, same fingerprint) pumps, jax sells
    const base = { marketId: 'm1', outcomeId: 'yes-1', ip: '198.51.100.7', uaHash: 'abc', amount: 10 };
    db.docs.set('auditLog/a1', { ...base, type: 'buy', uid: 'jax', atMs: clock - 300_000 });
    db.docs.set('auditLog/a2', { ...base, type: 'buy', uid: 'jaxalt', atMs: clock - 200_000 });
    db.docs.set('auditLog/a3', { ...base, type: 'sell', uid: 'jax', atMs: clock - 100_000 });
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      delete process.env.PHILOMARKET_ADMIN_EMAILS;
      assert.equal((await call(flagsHandler, { token: 'tok-admin', method: 'GET' })).statusCode, 404);
      process.env.PHILOMARKET_ADMIN_EMAILS = '*';
      assert.equal((await call(flagsHandler, { token: 'tok-admin', method: 'GET' })).statusCode, 404);
      process.env.PHILOMARKET_ADMIN_EMAILS = 'boss@club.org';
      assert.equal((await call(flagsHandler, { token: 'tok-jax', method: 'GET' })).statusCode, 404);
      assert.equal((await call(flagsHandler, { method: 'GET' })).statusCode, 404);
      const ok = await call(flagsHandler, { token: 'tok-admin', method: 'GET' });
      assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
      assert.equal(ok.headers['Cache-Control'], 'no-store');
      assert.deepEqual(ok.body.flags.pumpAndDump.map((r) => [r.beneficiary, r.pumper]), [['jax', 'jaxalt']]);
      assert.deepEqual(ok.body.flags.sharedIpAndUserAgent[0].uids, ['jax', 'jaxalt']);
      assert.deepEqual(ok.body.flags.creatorSelfTrading.map((r) => r.uid), ['jax']);
      assert.equal(ok.body.accounts.jax.email, 'jax.smith@gmail.com');
    } finally {
      Date.now = realNow;
      delete process.env.PHILOMARKET_ADMIN_EMAILS;
    }
  });

  test('buy rejects non-number amounts that Number() would coerce', async () => {
    seed();
    for (const amount of [true, '0x10', '16', null, 1e12, Infinity]) {
      const res = await call(back, { token: 'tok-jax', body: { amount, outcomeId: 'yes-1' } });
      assert.equal(res.statusCode, 400, `amount ${String(amount)} -> ${res.statusCode}`);
    }
    assert.equal(db.docs.has('users/jax'), false, 'no account write on rejected input');
  });

  test('GET /api/markets: repeat and cache-busting requests do not rescan every market', async () => {
    seed();
    const ts = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) });
    for (let i = 0; i < 150; i += 1) {
      db.docs.set(`markets/x${i}`, { question: `Q${i}?`, outcomes: [], status: 'open', createdAt: ts(1000 + i), updatedAt: ts(1000 + i) });
    }
    db.docs.set('markets/scriba-first', { question: 'Seed', outcomes: [], status: 'open', createdAt: ts(1), updatedAt: ts(1) });
    const get = (q) => call(marketsHandler, { method: 'GET', query: { bust: q } });
    const first = await get('a');
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(first.body.markets.length, 152);
    skew += 6_000; // past the 5s refresh
    const before = db.reads;
    for (let i = 0; i < 20; i += 1) { assert.equal((await get(`r${i}`)).statusCode, 200); }
    skew += 6_000;
    assert.equal((await get('later')).statusCode, 200);
    const delta = db.reads - before;
    assert.ok(delta <= 6, `21 GETs after warm-up cost ${delta} reads (a full scan is 152)`);

    db.docs.set('markets/x3', { ...db.docs.get('markets/x3'), question: 'Changed?', updatedAt: ts(5000) });
    skew += 6_000;
    const changed = await get('changed');
    assert.equal(changed.body.markets.find((m) => m.id === 'x3').question, 'Changed?');
  });

  test('GET /api/markets: per-IP limiter returns 429 after 60 requests in a minute', async () => {
    seed();
    skew += 120_000;
    const statuses = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await call(marketsHandler, { method: 'GET' })).statusCode);
    assert.equal(statuses.filter((code) => code === 200).length, 60);
    assert.equal(statuses[60], 429);
  });
}
