import test from 'node:test';
import assert from 'node:assert/strict';
import * as marketMath from '../marketMath.js';
import {
  MARKET_LIQUIDITY,
  floorPoints,
  marketProbabilities,
  roundPoints,
  proceedsForSale,
  roundShares,
  sharesForSaleAmount,
  sharesForSpend,
} from '../marketMath.js';

const cents = (value) => Math.round(value * 100);

function freshMarket(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `o${index}`, shares: 0 }));
}

// Mirrors api/markets/[id]/back.js: the buy mutates the outcome share count.
function buy(outcomes, index, amount) {
  const shares = sharesForSpend(outcomes, index, amount);
  assert.ok(Number.isFinite(shares) && shares > 0, `buy of ${amount} returned ${shares}`);
  outcomes[index] = { ...outcomes[index], shares: roundShares(outcomes[index].shares + shares) };
  return shares;
}

// Mirrors api/markets/[id]/sell.js: the sell removes the shares sharesForSaleAmount picked.
function sell(outcomes, index, sold) {
  outcomes[index] = { ...outcomes[index], shares: Math.max(0, roundShares(outcomes[index].shares - sold)) };
}

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('profit: A sells for more than 50 after B pushes the price up (2 outcomes)', () => {
  const outcomes = freshMarket(2);
  const aShares = buy(outcomes, 0, 50);
  const before = marketProbabilities(outcomes)[0];
  buy(outcomes, 0, 200);
  assert.ok(marketProbabilities(outcomes)[0] > before);
  const proceeds = proceedsForSale(outcomes, 0, aShares);
  assert.ok(proceeds > 50, `proceeds ${proceeds} should exceed 50`);
  assert.equal(floorPoints(proceeds), 50.98);
});

test('profit: amount above buy-in but below the true quote is sellable', () => {
  const outcomes = freshMarket(2);
  const aShares = buy(outcomes, 0, 50);
  buy(outcomes, 0, 200);
  const max = floorPoints(proceedsForSale(outcomes, 0, aShares));
  for (const amount of [50.01, 50.5, max - 0.01]) {
    const sold = sharesForSaleAmount(outcomes, 0, amount, aShares);
    assert.ok(sold > 0 && sold < aShares, `amount ${amount} sold ${sold}`);
    assert.ok(cents(floorPoints(proceedsForSale(outcomes, 0, sold))) >= cents(amount));
  }
  assert.equal(sharesForSaleAmount(outcomes, 0, max + 0.01, aShares), 0, 'above the quote is refused');
});

test('selling for the full quote sells the whole position (no unsellable dust)', () => {
  const outcomes = freshMarket(2);
  const aShares = buy(outcomes, 0, 50);
  buy(outcomes, 0, 200);
  const max = floorPoints(proceedsForSale(outcomes, 0, aShares));
  const sold = sharesForSaleAmount(outcomes, 0, max, aShares);
  assert.equal(sold, aShares, `left ${roundShares(aShares - sold)} shares behind`);
});

test('profit: multi-outcome market (11 outcomes) pays A more than the buy-in', () => {
  const outcomes = freshMarket(11);
  const aShares = buy(outcomes, 3, 50);
  buy(outcomes, 3, 200);
  const proceeds = proceedsForSale(outcomes, 3, aShares);
  assert.ok(proceeds > 59, `proceeds ${proceeds}`);
  const sold = sharesForSaleAmount(outcomes, 3, floorPoints(proceeds), aShares);
  assert.equal(sold, aShares);
});

test('loss: A sells for less than 50 after B backs the other outcome', () => {
  const outcomes = freshMarket(2);
  const aShares = buy(outcomes, 0, 50);
  buy(outcomes, 1, 200);
  assert.ok(proceedsForSale(outcomes, 0, aShares) < 50);
});

test('immediate round trip breaks even at best and never loses a cent', () => {
  const random = rng(42);
  for (let i = 0; i < 5000; i += 1) {
    const count = 2 + Math.floor(random() * 10);
    const outcomes = freshMarket(count).map((outcome) => ({
      ...outcome,
      shares: random() < 0.5 ? 0 : roundShares(random() * 20000),
    }));
    const index = Math.floor(random() * count);
    const amount = (1 + Math.floor(random() * 100000)) / 100;
    const shares = buy(outcomes, index, amount);
    const back = floorPoints(proceedsForSale(outcomes, index, shares));
    assert.equal(cents(back), cents(amount), `case ${i}: spent ${amount}, round trip ${back}`);
    assert.equal(sharesForSaleAmount(outcomes, index, back, shares), shares, `case ${i}: full exit`);
  }
});

test('partial sells sum to roughly a full sell', () => {
  const outcomes = freshMarket(3);
  const aShares = buy(outcomes, 1, 120);
  buy(outcomes, 1, 300);
  const fullQuote = floorPoints(proceedsForSale(outcomes, 1, aShares));
  let remaining = aShares;
  let received = 0;
  for (const amount of [20, 35.55, 40]) {
    const sold = sharesForSaleAmount(outcomes, 1, amount, remaining);
    assert.ok(sold > 0);
    received += amount;
    sell(outcomes, 1, sold);
    remaining = roundShares(remaining - sold);
  }
  const last = floorPoints(proceedsForSale(outcomes, 1, remaining));
  assert.equal(sharesForSaleAmount(outcomes, 1, last, remaining), remaining);
  received += last;
  // Each partial sale may forfeit up to a cent of rounding.
  assert.ok(Math.abs(cents(received) - cents(fullQuote)) <= 4, `partials ${received} vs full ${fullQuote}`);
  assert.ok(cents(received) <= cents(fullQuote) + 1, 'partials never beat a full sell by more than rounding');
});

test('rounding edge: 0.01 trades', () => {
  const outcomes = freshMarket(2);
  const shares = buy(outcomes, 0, 0.01);
  assert.ok(shares > 0);
  assert.equal(floorPoints(proceedsForSale(outcomes, 0, shares)), 0.01);
  assert.equal(sharesForSaleAmount(outcomes, 0, 0.01, shares), shares);
});

test('rounding edge: huge amounts stay finite', () => {
  for (const amount of [1e5, 1e6, 7e6, 1e7, 1e9, 1e15]) {
    const shares = sharesForSpend(freshMarket(2), 0, amount);
    assert.ok(Number.isFinite(shares) && shares > 0, `sharesForSpend(${amount}) = ${shares}`);
  }
  const outcomes = freshMarket(2);
  const shares = buy(outcomes, 0, 400);
  assert.ok(Number.isFinite(proceedsForSale(outcomes, 0, 1e300)));
  assert.equal(sharesForSaleAmount(outcomes, 0, 1e12, shares), 0);
});

test('invalid inputs return 0 instead of throwing', () => {
  const outcomes = freshMarket(2);
  const shares = buy(outcomes, 0, 25);
  for (const bad of [NaN, -1, 0, Infinity, -Infinity, '5', undefined, null]) {
    assert.equal(sharesForSpend(outcomes, 0, bad), 0, `spend ${String(bad)}`);
    assert.equal(proceedsForSale(outcomes, 0, bad), 0, `proceeds ${String(bad)}`);
    assert.equal(sharesForSaleAmount(outcomes, 0, bad, shares), 0, `amount ${String(bad)}`);
    assert.equal(sharesForSaleAmount(outcomes, 0, 1, bad), 0, `available ${String(bad)}`);
  }
  for (const index of [-1, 2, 99, 0.5, NaN, '0', undefined]) {
    assert.equal(sharesForSpend(outcomes, index, 10), 0, `spend index ${String(index)}`);
    assert.equal(proceedsForSale(outcomes, index, 1), 0, `proceeds index ${String(index)}`);
    assert.equal(sharesForSaleAmount(outcomes, index, 1, shares), 0, `sale index ${String(index)}`);
  }
  for (const badOutcomes of [undefined, null, [], {}]) {
    assert.equal(sharesForSpend(badOutcomes, 0, 10), 0);
    assert.equal(proceedsForSale(badOutcomes, 0, 1), 0);
    assert.equal(sharesForSaleAmount(badOutcomes, 0, 1, 1), 0);
  }
  for (const liquidity of [0, -5, NaN]) {
    assert.equal(sharesForSpend(outcomes, 0, 10, liquidity), 0);
    assert.equal(proceedsForSale(outcomes, 0, 1, liquidity), 0);
  }
});

test('selling more shares than the market holds is clamped, not negative', () => {
  const outcomes = freshMarket(2);
  const shares = buy(outcomes, 0, 30);
  assert.ok(cents(proceedsForSale(outcomes, 0, shares * 10)) <= 3000);
});

test('liquidity sanity: a 500-point account moves a 2-outcome price by ~2.4 points', () => {
  const outcomes = freshMarket(2);
  buy(outcomes, 0, 500);
  const price = marketProbabilities(outcomes, MARKET_LIQUIDITY)[0];
  assert.ok(price > 0.52 && price < 0.53, `price ${price}`);
});

// Server-faithful replay of api/markets/[id]/back.js + sell.js accounting:
// pointPool = sum of spends minus payouts (roundPoints), and a sale is capped
// at floorPoints(min(quote, pointPool)) exactly as sell.js does.
function simulateMarket(outcomeCount) {
  const outcomes = freshMarket(outcomeCount);
  let pointPool = 0;
  return {
    outcomes,
    get pointPool() { return pointPool; },
    back(index, amount) {
      const shares = buy(outcomes, index, amount);
      pointPool = roundPoints(pointPool + amount);
      return shares;
    },
    // Returns { quote, cap, paid, sold } for a request of `amount` (default: everything).
    sell(index, heldShares, amount) {
      const quote = floorPoints(proceedsForSale(outcomes, index, heldShares));
      const cap = floorPoints(Math.min(proceedsForSale(outcomes, index, heldShares), pointPool));
      const requested = amount ?? cap;
      if (requested > cap || requested < 0.01) return { quote, cap, paid: 0, sold: 0 };
      const sold = sharesForSaleAmount(outcomes, index, requested, heldShares);
      const paid = Math.min(requested, floorPoints(proceedsForSale(outcomes, index, sold)));
      sell(outcomes, index, sold);
      pointPool = Math.max(0, roundPoints(pointPool - paid));
      return { quote, cap, paid, sold };
    },
  };
}

test('pointPool cap never binds: B and C take profit before A exits', () => {
  const market = simulateMarket(2);
  const a = market.back(0, 50);
  const b = market.back(0, 200);
  const c = market.back(0, 200);
  assert.equal(market.pointPool, 450);
  const exits = [['B', b], ['C', c], ['A', a]].map(([name, shares]) => {
    const result = market.sell(0, shares);
    assert.equal(result.cap, result.quote, `${name}: pool cap ${result.cap} < quote ${result.quote}`);
    assert.equal(result.paid, result.quote, `${name} paid ${result.paid}, quote ${result.quote}`);
    assert.equal(result.sold, shares, `${name} left shares behind`);
    return result.paid;
  });
  // B entered after A and exits first at a profit; C and A get what is left of the curve.
  assert.deepEqual(exits, [203.8, 196.19, 50]);
  assert.ok(market.pointPool >= 0 && market.pointPool < 0.05, `pool residue ${market.pointPool}`);
  assert.equal(market.outcomes[0].shares, 0);
});

test('pointPool cap never binds: seeded random back/sell sequences', () => {
  const random = rng(7);
  let sales = 0;
  for (let trial = 0; trial < 1500; trial += 1) {
    const count = 2 + Math.floor(random() * 10);
    const market = simulateMarket(count);
    const holdings = [];
    const steps = 5 + Math.floor(random() * 40);
    const trySell = (holding, amount) => {
      const result = market.sell(holding.index, holding.shares, amount);
      assert.equal(result.cap, result.quote, `trial ${trial}: cap ${result.cap} < quote ${result.quote}`);
      holding.shares = roundShares(holding.shares - result.sold);
      sales += 1;
    };
    for (let step = 0; step < steps; step += 1) {
      const open = holdings.filter((holding) => holding.shares > 0);
      if (open.length && random() < 0.45) {
        const holding = open[Math.floor(random() * open.length)];
        const full = floorPoints(proceedsForSale(market.outcomes, holding.index, holding.shares));
        trySell(holding, random() < 0.6 ? undefined : Math.max(0.01, floorPoints(full * random())));
      } else {
        const index = Math.floor(random() * count);
        const amount = (1 + Math.floor(random() * 50000)) / 100;
        holdings.push({ index, shares: market.back(index, amount) });
      }
    }
    for (const holding of holdings.filter((item) => item.shares > 0)) trySell(holding);
    assert.ok(market.pointPool >= 0, `trial ${trial}: pool went negative`);
  }
  assert.ok(sales > 10000, `only ${sales} sales exercised`);
});

test('parsePointAmount: request amounts must be real numbers in cents within bounds', () => {
  const { parsePointAmount, MAX_TRADE_POINTS } = marketMath;
  assert.equal(typeof parsePointAmount, 'function', 'marketMath must export parsePointAmount');
  assert.ok(Number.isFinite(MAX_TRADE_POINTS) && MAX_TRADE_POINTS > 0);
  for (const good of [0.01, 1, 50.98, 500, MAX_TRADE_POINTS]) assert.equal(parsePointAmount(good), good);
  for (const bad of [true, false, '16', '0x10', '50', null, undefined, {}, [5], NaN, Infinity, -1, 0, 0.001, 1.005,
    MAX_TRADE_POINTS + 0.01, 1e300]) {
    assert.equal(parsePointAmount(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});
