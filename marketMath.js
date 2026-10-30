export const MARKET_LIQUIDITY = 10000;
// Upper bound on a single trade request; far above any reachable balance.
export const MAX_TRADE_POINTS = 1_000_000;

export function roundPoints(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function floorPoints(value) {
  return Math.floor((value + 1e-7) * 100) / 100;
}

export function roundShares(value) {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

// Parses a request's point amount. Only a JSON number in whole cents from 0.01
// to MAX_TRADE_POINTS is accepted: Number(true) === 1 and Number('0x10') === 16
// must not turn into trades. Returns null when invalid.
export function parsePointAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0.01 || value > MAX_TRADE_POINTS) return null;
  const amount = roundPoints(value);
  return Math.abs(value - amount) > 1e-8 ? null : amount;
}

export function marketProbabilities(outcomes, liquidity = MARKET_LIQUIDITY) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return [];
  const scaled = outcomes.map((outcome) => Math.max(0, Number(outcome.shares) || 0) / liquidity);
  const max = Math.max(...scaled);
  const weights = scaled.map((value) => Math.exp(value - max));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((weight) => weight / total);
}

export function appendPriceHistory(history, outcomes, liquidity = MARKET_LIQUIDITY, at = Date.now()) {
  const previous = Array.isArray(history) ? history.slice(-199) : [];
  return [...previous, { at, prices: marketProbabilities(outcomes, liquidity) }];
}

function marketCost(outcomes, liquidity = MARKET_LIQUIDITY) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return 0;
  const scaled = outcomes.map((outcome) => Math.max(0, Number(outcome.shares) || 0) / liquidity);
  const max = Math.max(...scaled);
  return liquidity * (max + Math.log(scaled.reduce((sum, value) => sum + Math.exp(value - max), 0)));
}

function validOutcomeIndex(outcomes, outcomeIndex) {
  return Array.isArray(outcomes)
    && Number.isInteger(outcomeIndex)
    && outcomeIndex >= 0
    && outcomeIndex < outcomes.length
    && Boolean(outcomes[outcomeIndex]);
}

function validLiquidity(liquidity) {
  return typeof liquidity === 'number' && Number.isFinite(liquidity) && liquidity > 0;
}

function validPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function sharesForSpend(outcomes, outcomeIndex, amount, liquidity = MARKET_LIQUIDITY) {
  if (!validPositive(amount) || !validLiquidity(liquidity) || !validOutcomeIndex(outcomes, outcomeIndex)) return 0;

  const scaled = outcomes.map((outcome) => Math.max(0, Number(outcome.shares) || 0) / liquidity);
  const max = Math.max(...scaled);
  const logTotal = max + Math.log(scaled.reduce((sum, value) => sum + Math.exp(value - max), 0));
  const logProbability = scaled[outcomeIndex] - logTotal;
  // log(e^x - 1), computed without overflowing to Infinity for large x.
  const x = amount / liquidity;
  const logSpendIncrement = x > 30 ? x + Math.log1p(-Math.exp(-x)) : Math.log(Math.expm1(x));
  const logFactor = logSpendIncrement - logProbability;
  const logOnePlusFactor = logFactor > 36 ? logFactor : Math.log1p(Math.exp(logFactor));
  return roundShares(liquidity * logOnePlusFactor);
}

export function proceedsForSale(outcomes, outcomeIndex, shares, liquidity = MARKET_LIQUIDITY) {
  if (!validPositive(shares) || !validLiquidity(liquidity) || !validOutcomeIndex(outcomes, outcomeIndex)) return 0;
  const reduced = outcomes.map((outcome, index) => ({
    ...outcome,
    shares: index === outcomeIndex ? Math.max(0, (Number(outcome.shares) || 0) - shares) : outcome.shares,
  }));
  return Math.max(0, marketCost(outcomes, liquidity) - marketCost(reduced, liquidity));
}

// Shares to sell so the floored quote covers `amount` points. When `amount`
// is the floored quote for the whole position (the most the position can sell
// for), the whole position is sold: otherwise the binary search stops a hair
// short and leaves shares worth less than a cent that can never be sold.
export function sharesForSaleAmount(outcomes, outcomeIndex, amount, availableShares, liquidity = MARKET_LIQUIDITY) {
  if (!validPositive(amount) || !validPositive(availableShares)) return 0;
  if (!validLiquidity(liquidity) || !validOutcomeIndex(outcomes, outcomeIndex)) return 0;

  const maxShares = Math.min(availableShares, Math.max(0, Number(outcomes[outcomeIndex].shares) || 0));
  if (maxShares <= 0) return 0;
  const fullQuoteCents = Math.round(floorPoints(proceedsForSale(outcomes, outcomeIndex, maxShares, liquidity)) * 100);
  const amountCents = Math.round(amount * 100);
  if (fullQuoteCents < amountCents) return 0;
  if (fullQuoteCents === amountCents) return maxShares;

  let low = 0;
  let high = maxShares;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (low + high) / 2;
    const quote = floorPoints(proceedsForSale(outcomes, outcomeIndex, midpoint, liquidity));
    if (quote >= amount) high = midpoint;
    else low = midpoint;
  }

  // Round upward by one share tick so rounding cannot leave the quote a cent short.
  return Math.min(maxShares, roundShares(high + 1e-8));
}
