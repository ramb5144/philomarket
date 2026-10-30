import { getAdminServices } from '../server/firebaseAdmin.js';
import { handleApiError, methodNotAllowed, profileFrom, readJson, requireVerifiedUser, sendJson } from '../server/http.js';
import { appendPriceHistory, MARKET_LIQUIDITY } from '../marketMath.js';
import { readAccountContext, writeAccountContext } from '../server/accounts.js';
import { buildAuditEvent, clientIp, requestFingerprint, writeAuditEvent } from '../server/abuseAudit.js';
import { createMarketCache } from '../server/abuseMarketCache.js';
import { createWindowLimiter } from '../server/abuseRateLimit.js';

const DEFAULT_MARKET_ID = 'scriba-first';
const MAX_MARKETS_PER_USER = 10;
const MAX_MARKETS_RETURNED = 200;
const marketCache = createMarketCache();
const allowListRead = createWindowLimiter({ limit: 60, windowMs: 60_000 });
const SCRIBA_NAMES = [
  'Isai Medina', 'Rowan Liddell', 'Emily Tacey', 'Emylee Perkins', 'Betsy Barnard',
  'Qaira Saldivar', 'Omer Alp Danis', 'Grace Burke', 'David Li', 'Nicholas Ingram', 'Bobby McCann',
];

function outcomeId(label, index) {
  const stem = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'outcome';
  return `${stem}-${index + 1}`;
}

function presentMarket({ id, data }, currentUid = null) {
  return {
    id,
    question: data.question,
    outcomes: data.outcomes,
    liquidity: data.liquidity || MARKET_LIQUIDITY,
    liquidityReserve: Number(data.liquidityReserve) || 0,
    pointPool: data.pointPool || 0,
    backCount: data.backCount || 0,
    sellCount: data.sellCount || 0,
    backerCount: data.backerCount || 0,
    status: data.status || 'open',
    isMine: Boolean(currentUid && data.creatorUid === currentUid),
    createdAt: data.createdAt?.toDate?.().toISOString() || new Date(0).toISOString(),
  };
}

async function seedDefaultMarket(db, FieldValue) {
  const marketRef = db.collection('markets').doc(DEFAULT_MARKET_ID);
  // Plain read first: a transaction here on every listing contended with
  // trades on the default market and caused aborted trades under load.
  if ((await marketRef.get()).exists) return;
  const outcomes = SCRIBA_NAMES.map((label, index) => ({ id: outcomeId(label, index), label, shares: 0 }));
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(marketRef);
    if (snapshot.exists) return;
    transaction.create(marketRef, {
      question: 'Which baby will become a Scriba?',
      outcomes,
      liquidity: MARKET_LIQUIDITY,
      pointPool: 0,
      backCount: 0,
      sellCount: 0,
      backerCount: 0,
      priceHistory: appendPriceHistory([], outcomes, MARKET_LIQUIDITY),
      status: 'open',
      creatorUid: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

function validateMarket(body) {
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (Array.isArray(body?.outcomes) && body.outcomes.length > 12) {
    throw Object.assign(new Error('Add between 2 and 12 outcomes.'), { status: 400 });
  }
  if (typeof body?.outcomes === 'string' && body.outcomes.length > 700) {
    throw Object.assign(new Error('Keep market outcomes under 700 characters.'), { status: 400 });
  }
  if (Array.isArray(body?.outcomes) && body.outcomes.some((label) => typeof label !== 'string')) {
    throw Object.assign(new Error('Every outcome must be text.'), { status: 400 });
  }
  const labels = typeof body?.outcomes === 'string'
    ? body.outcomes.split(/\r?\n/).map((label) => label.trim()).filter(Boolean)
    : Array.isArray(body?.outcomes) ? body.outcomes.map((label) => label.trim()).filter(Boolean) : [];
  const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

  if (question.length < 8 || question.length > 140) {
    throw Object.assign(new Error('Write a market question between 8 and 140 characters.'), { status: 400 });
  }
  if (unsafeText.test(question)) {
    throw Object.assign(new Error('Remove control or bidirectional formatting characters from the question.'), { status: 400 });
  }
  if (labels.length < 2 || labels.length > 12) {
    throw Object.assign(new Error('Add between 2 and 12 outcomes.'), { status: 400 });
  }
  if (labels.some((label) => label.length < 1 || label.length > 50)) {
    throw Object.assign(new Error('Each outcome must be 1 to 50 characters.'), { status: 400 });
  }
  if (labels.some((label) => unsafeText.test(label))) {
    throw Object.assign(new Error('Remove control or bidirectional formatting characters from outcomes.'), { status: 400 });
  }
  const normalized = labels.map((label) => label.toLocaleLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw Object.assign(new Error('Outcome names must be unique.'), { status: 400 });
  }
  return { question, labels };
}

export default async function handler(req, res) {
  try {
    const { db, FieldValue, auth } = getAdminServices();
    if (req.method === 'GET') {
      if (!allowListRead(clientIp(req))) {
        throw Object.assign(new Error('Too many requests. Try again in a minute.'), { status: 429 });
      }
      let currentUid = null;
      const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (bearer) {
        try {
          const decoded = await auth.verifyIdToken(bearer[1], true);
          if (decoded.email_verified === true) currentUid = decoded.uid;
        } catch { /* Browsing is public; a stale token only hides "My markets". */ }
      }
      let cached = await marketCache.list(db);
      if (!cached.some((doc) => doc.id === DEFAULT_MARKET_ID)) {
        await seedDefaultMarket(db, FieldValue);
        marketCache.invalidate();
        cached = await marketCache.list(db);
      }
      const createdMs = (doc) => doc.data.createdAt?.toMillis?.() ?? 0;
      const newestFirst = cached.slice().sort((a, b) => createdMs(b) - createdMs(a));
      let marketDocs = newestFirst.slice(0, MAX_MARKETS_RETURNED);
      if (!marketDocs.some((doc) => doc.id === DEFAULT_MARKET_ID)) {
        const defaultMarket = newestFirst.find((doc) => doc.id === DEFAULT_MARKET_ID);
        if (defaultMarket) marketDocs = [...marketDocs.slice(0, MAX_MARKETS_RETURNED - 1), defaultMarket];
      }
      const markets = marketDocs.map((doc) => presentMarket(doc, currentUid)).sort((a, b) => {
        const liquidity = (Number(b.liquidityReserve) || 0) - (Number(a.liquidityReserve) || 0);
        if (liquidity) return liquidity;
        const activity = b.pointPool - a.pointPool;
        return activity || b.createdAt.localeCompare(a.createdAt);
      });
      // Invalid or stale tokens produce the same anonymous payload, so they
      // should not let callers bypass the public CDN cache.
      const cacheControl = currentUid
        ? 'no-store'
        : 'public, s-maxage=15, stale-while-revalidate=60';
      return sendJson(res, 200, { markets }, { cacheControl });
    }

    if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
    const decoded = await requireVerifiedUser(req);
    const { question, labels } = validateMarket(await readJson(req));
    const marketRef = db.collection('markets').doc();
    const outcomes = labels.map((label, index) => ({ id: outcomeId(label, index), label, shares: 0 }));
    const marketData = {
      question,
      outcomes,
      liquidity: MARKET_LIQUIDITY,
      pointPool: 0,
      backCount: 0,
      sellCount: 0,
      priceHistory: appendPriceHistory([], outcomes, MARKET_LIQUIDITY),
      status: 'open',
      creatorUid: decoded.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const profile = await db.runTransaction(async (transaction) => {
      const account = await readAccountContext(transaction, db, decoded);
      const userData = account.userData;
      const marketsCreated = Number(userData.marketsCreated) || 0;
      if (marketsCreated >= MAX_MARKETS_PER_USER) {
        throw Object.assign(new Error('You have reached the market creation limit for this account.'), { status: 429 });
      }
      const updatedUser = { ...userData, marketsCreated: marketsCreated + 1 };
      transaction.create(marketRef, marketData);
      writeAccountContext(transaction, account, FieldValue, { marketsCreated: updatedUser.marketsCreated });
      writeAuditEvent(transaction, db, buildAuditEvent({
        type: 'market_create', uid: decoded.uid, marketId: marketRef.id, fingerprint: requestFingerprint(req),
      }), FieldValue);
      return profileFrom(decoded.uid, decoded.email || '', updatedUser);
    });

    marketCache.invalidate();
    return sendJson(res, 201, {
      market: {
        id: marketRef.id,
        question,
        outcomes: marketData.outcomes,
        liquidity: MARKET_LIQUIDITY,
        pointPool: 0,
        backCount: 0,
        sellCount: 0,
        backerCount: 0,
        priceHistory: marketData.priceHistory,
        status: 'open',
        isMine: true,
        createdAt: new Date().toISOString(),
      },
      profile,
      position: {},
    });
  } catch (error) {
    return handleApiError(res, error);
  }
}
