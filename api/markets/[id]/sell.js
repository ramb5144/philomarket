import { getAdminServices } from '../../../server/firebaseAdmin.js';
import { handleApiError, methodNotAllowed, profileFrom, readJson, requireVerifiedUser, sendJson } from '../../../server/http.js';
import { appendPriceHistory, floorPoints, MARKET_LIQUIDITY, parsePointAmount, proceedsForSale, roundPoints, roundShares, sharesForSaleAmount } from '../../../marketMath.js';
import { enforceTradeCooldown, readAccountContext, writeAccountContext } from '../../../server/accounts.js';
import {
  buildAuditEvent, idempotencyRef, readIdempotencyKey, readIdempotentReplay, requestDigest,
  requestFingerprint, writeAuditEvent, writeIdempotency,
} from '../../../server/abuseAudit.js';

function validMarketId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function presentMarket(id, data, currentUid) {
  return {
    id,
    question: data.question,
    outcomes: data.outcomes,
    liquidity: data.liquidity || MARKET_LIQUIDITY,
    pointPool: data.pointPool || 0,
    backCount: data.backCount || 0,
    sellCount: data.sellCount || 0,
    backerCount: data.backerCount || 0,
    status: data.status || 'open',
    isMine: Boolean(currentUid && data.creatorUid === currentUid),
    priceHistory: Array.isArray(data.priceHistory) ? data.priceHistory : [],
    createdAt: data.createdAt?.toDate?.().toISOString() || new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const decoded = await requireVerifiedUser(req);
    const body = await readJson(req);
    // `all: true` sells the whole position at the server's current quote, so a
    // client holding a stale market snapshot can still exit at today's price.
    const sellAll = body?.all === true;
    const requestedAmount = parsePointAmount(body?.amount);
    const marketId = req.query?.id;
    const outcomeId = typeof body?.outcomeId === 'string' ? body.outcomeId : '';
    if (!sellAll && requestedAmount === null) {
      throw Object.assign(new Error('Enter the point amount you want to sell from this pick.'), { status: 400 });
    }
    if (!validMarketId(marketId)) throw Object.assign(new Error('Market not found.'), { status: 404 });
    if (!outcomeId || outcomeId.length > 80) {
      throw Object.assign(new Error('Choose an outcome before selling it.'), { status: 400 });
    }

    const idempotencyKey = readIdempotencyKey(req, body);
    const fingerprint = requestFingerprint(req);

    const { db, FieldValue } = getAdminServices();
    const marketRef = db.collection('markets').doc(marketId);
    const positionRef = marketRef.collection('positions').doc(decoded.uid);
    const replayRef = idempotencyKey ? idempotencyRef(db, decoded.uid, idempotencyKey) : null;
    const digest = requestDigest('sell', { marketId, outcomeId, amount: sellAll ? null : requestedAmount, all: sellAll });

    const result = await db.runTransaction(async (transaction) => {
      // A replayed key returns the original result without trading again.
      const replay = await readIdempotentReplay(transaction, replayRef, decoded.uid, digest);
      if (replay) return replay;
      const account = await readAccountContext(transaction, db, decoded);
      const [marketSnapshot, positionSnapshot] = await Promise.all([
        transaction.get(marketRef),
        transaction.get(positionRef),
      ]);
      if (!marketSnapshot.exists) throw Object.assign(new Error('Market not found.'), { status: 404 });
      if (account.isNew || !positionSnapshot.exists) {
        throw Object.assign(new Error('You do not have a position to sell.'), { status: 409 });
      }

      const userData = account.userData;
      enforceTradeCooldown(userData);
      const marketData = marketSnapshot.data();
      if ((marketData.status || 'open') !== 'open') {
        throw Object.assign(new Error('This market is closed.'), { status: 409 });
      }
      if (!Number.isFinite(userData.points) || userData.points < 0) {
        throw Object.assign(new Error('Your account points are unavailable.'), { status: 409 });
      }

      const outcomes = marketData.outcomes.map((outcome) => ({
        ...outcome,
        shares: Math.max(0, Number(outcome.shares) || 0),
      }));
      const positionData = positionSnapshot.data();
      const position = positionData.sharesByOutcome || {};
      const costBasis = { ...(positionData.costBasisByOutcome || {}) };
      const liquidity = marketData.liquidity || MARKET_LIQUIDITY;
      const pointPool = roundPoints(Math.max(0, Number(marketData.pointPool) || 0));
      const updatedPosition = { ...position };
      const outcomeIndex = outcomes.findIndex((outcome) => outcome.id === outcomeId);
      const availableShares = Number(position[outcomeId]) || 0;
      if (outcomeIndex < 0) throw Object.assign(new Error('That outcome is not in this market.'), { status: 400 });
      if (availableShares <= 0) throw Object.assign(new Error('You do not have a position to sell.'), { status: 409 });
      if (availableShares > outcomes[outcomeIndex].shares + 1e-7) {
        throw Object.assign(new Error('Your position needs a refresh before it can be sold.'), { status: 409 });
      }
      const maxProceeds = floorPoints(Math.min(
        proceedsForSale(outcomes, outcomeIndex, availableShares, liquidity),
        pointPool,
      ));
      // A sell-all whose quote floors below one cent closes the leftover dust
      // for 0 points instead of leaving an unsellable position behind.
      const closeDust = sellAll && maxProceeds < 0.01;
      const amount = sellAll ? maxProceeds : requestedAmount;
      if (amount > maxProceeds) {
        throw Object.assign(new Error(`This pick can currently sell for at most ${maxProceeds} points.`), { status: 409 });
      }
      const soldShares = closeDust
        ? availableShares
        : sharesForSaleAmount(outcomes, outcomeIndex, amount, availableShares, liquidity);
      if (soldShares <= 0) throw Object.assign(new Error('This position is too small to sell for that amount.'), { status: 409 });
      const proceeds = closeDust
        ? 0
        : Math.min(amount, floorPoints(proceedsForSale(outcomes, outcomeIndex, soldShares, liquidity)));
      if (proceeds < amount) throw Object.assign(new Error('The quote changed. Refresh and try again.'), { status: 409 });

      outcomes[outcomeIndex] = {
        ...outcomes[outcomeIndex],
        shares: Math.max(0, roundShares(outcomes[outcomeIndex].shares - soldShares)),
      };
      const remainingShares = Math.max(0, roundShares(availableShares - soldShares));
      if (remainingShares < 1e-8) {
        updatedPosition[outcomeId] = 0;
        costBasis[outcomeId] = 0;
      } else {
        updatedPosition[outcomeId] = remainingShares;
        const priorCostBasis = costBasis[outcomeId];
        costBasis[outcomeId] = typeof priorCostBasis === 'number' && Number.isFinite(priorCostBasis) && priorCostBasis >= 0
          ? roundPoints(priorCostBasis * remainingShares / availableShares)
          : null;
      }

      const updatedUser = { ...userData, points: roundPoints(userData.points + proceeds) };
      const updatedMarket = {
        ...marketData,
        outcomes,
        liquidity,
        pointPool: Math.max(0, roundPoints(pointPool - proceeds)),
        sellCount: (marketData.sellCount || 0) + 1,
        priceHistory: appendPriceHistory(marketData.priceHistory, outcomes, liquidity),
        updatedAt: FieldValue.serverTimestamp(),
      };

      writeAccountContext(transaction, account, FieldValue, {
        points: updatedUser.points,
        lastTradeAt: FieldValue.serverTimestamp(),
      });
      transaction.update(marketRef, {
        outcomes,
        liquidity,
        pointPool: updatedMarket.pointPool,
        sellCount: updatedMarket.sellCount,
        priceHistory: updatedMarket.priceHistory,
        updatedAt: updatedMarket.updatedAt,
      });
      transaction.set(positionRef, {
        sharesByOutcome: updatedPosition,
        costBasisByOutcome: costBasis,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      const response = {
        profile: profileFrom(decoded.uid, decoded.email || '', updatedUser),
        market: presentMarket(marketId, updatedMarket, decoded.uid),
        position: updatedPosition,
        costBasis,
        proceeds,
        soldShares: roundShares(soldShares),
        outcomeId,
      };
      const nowMs = Date.now();
      writeAuditEvent(transaction, db, buildAuditEvent({
        type: 'sell', uid: decoded.uid, marketId, outcomeId, amount: proceeds, shares: response.soldShares ?? null, fingerprint, idempotencyKey, nowMs,
      }), FieldValue);
      writeIdempotency(transaction, replayRef, { uid: decoded.uid, route: 'sell', digest, response, nowMs }, FieldValue);
      return response;
    });

    return sendJson(res, 200, result);
  } catch (error) {
    return handleApiError(res, error);
  }
}
