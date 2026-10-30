// Pure heuristics over audit-log events. No Firebase; unit tested.
// Event shape (see server/abuseAudit.js buildAuditEvent):
//   { type: 'buy' | 'sell' | 'market_create', uid, marketId, outcomeId,
//     amount, ip, uaHash, atMs }
// These are signals for a human to review, not proof. Campus Wi-Fi NAT puts
// many honest members behind one IP; identical browsers share a UA hash.

export const DEFAULT_FLAG_OPTIONS = Object.freeze({
  burstCount: 10,
  burstWindowMs: 60_000,
  pumpWindowMs: 30 * 60_000,
  minExclusiveTrades: 4,
});

const isTrade = (event) => event?.type === 'buy' || event?.type === 'sell';

function validEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => event && typeof event.uid === 'string' && event.uid && Number.isFinite(event.atMs))
    .slice()
    .sort((a, b) => a.atMs - b.atMs);
}

function groupUidsBy(events, keyOf) {
  const groups = new Map();
  for (const event of events) {
    const key = keyOf(event);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { uids: new Set(), events: 0 });
    const group = groups.get(key);
    group.uids.add(event.uid);
    group.events += 1;
  }
  return [...groups.entries()]
    .filter(([, group]) => group.uids.size >= 2)
    .map(([key, group]) => ({ key, uids: [...group.uids].sort(), events: group.events }))
    .sort((a, b) => b.uids.length - a.uids.length || b.events - a.events || a.key.localeCompare(b.key));
}

export function sharedFingerprints(events) {
  const list = validEvents(events);
  const usable = (value) => value && value !== 'unknown' && value !== 'none';
  return {
    sharedIpAndUserAgent: groupUidsBy(list, (e) => (usable(e.ip) && usable(e.uaHash) ? `${e.ip}|${e.uaHash}` : null))
      .map(({ key, ...rest }) => { const [ip, uaHash] = key.split('|'); return { ip, uaHash, ...rest }; }),
    sharedIp: groupUidsBy(list, (e) => (usable(e.ip) ? e.ip : null))
      .map(({ key, ...rest }) => ({ ip: key, ...rest })),
    sharedUserAgent: groupUidsBy(list, (e) => (usable(e.uaHash) ? e.uaHash : null))
      .map(({ key, ...rest }) => ({ uaHash: key, ...rest })),
  };
}

export function tradeBursts(events, { burstCount, burstWindowMs } = DEFAULT_FLAG_OPTIONS) {
  const byUid = new Map();
  for (const event of validEvents(events).filter(isTrade)) {
    if (!byUid.has(event.uid)) byUid.set(event.uid, []);
    byUid.get(event.uid).push(event.atMs);
  }
  const bursts = [];
  for (const [uid, times] of byUid) {
    let best = null;
    let start = 0;
    for (let end = 0; end < times.length; end += 1) {
      while (times[end] - times[start] > burstWindowMs) start += 1;
      const count = end - start + 1;
      if (count >= burstCount && (!best || count > best.count)) {
        best = { uid, count, startMs: times[start], endMs: times[end] };
      }
    }
    if (best) bursts.push(best);
  }
  return bursts.sort((a, b) => b.count - a.count || a.uid.localeCompare(b.uid));
}

// Markets where exactly two accounts traded and they traded a lot: the
// classic alt-account wash pattern, since nobody else is on the other side.
export function exclusivePairs(events, { minExclusiveTrades } = DEFAULT_FLAG_OPTIONS) {
  const byMarket = new Map();
  for (const event of validEvents(events).filter(isTrade)) {
    if (!byMarket.has(event.marketId)) byMarket.set(event.marketId, []);
    byMarket.get(event.marketId).push(event);
  }
  const pairs = new Map();
  for (const [marketId, trades] of byMarket) {
    const uids = [...new Set(trades.map((t) => t.uid))].sort();
    if (uids.length !== 2) continue;
    const key = uids.join('|');
    if (!pairs.has(key)) pairs.set(key, { uids, markets: [], trades: 0 });
    const pair = pairs.get(key);
    pair.markets.push(marketId);
    pair.trades += trades.length;
  }
  return [...pairs.values()]
    .filter((pair) => pair.markets.length >= 2 || pair.trades >= minExclusiveTrades)
    .map((pair) => ({ ...pair, markets: pair.markets.sort() }))
    .sort((a, b) => b.trades - a.trades || a.uids[0].localeCompare(b.uids[0]));
}

// A holds outcome X, B buys X (price rises), A sells X shortly after: points
// flow from B to A. Reported per (beneficiary, pumper) pair.
export function pumpAndDump(events, { pumpWindowMs } = DEFAULT_FLAG_OPTIONS) {
  const byOutcome = new Map();
  for (const event of validEvents(events).filter(isTrade)) {
    const key = `${event.marketId}|${event.outcomeId}`;
    if (!byOutcome.has(key)) byOutcome.set(key, []);
    byOutcome.get(key).push(event);
  }
  const pairs = new Map();
  for (const trades of byOutcome.values()) {
    trades.forEach((sale, saleIndex) => {
      if (sale.type !== 'sell') return;
      const firstOwnBuy = trades.findIndex((t, i) => i < saleIndex && t.type === 'buy' && t.uid === sale.uid);
      if (firstOwnBuy < 0) return;
      const pumpers = new Set();
      for (let i = firstOwnBuy + 1; i < saleIndex; i += 1) {
        const t = trades[i];
        if (t.type === 'buy' && t.uid !== sale.uid && sale.atMs - t.atMs <= pumpWindowMs) pumpers.add(t.uid);
      }
      for (const pumper of pumpers) {
        const key = `${sale.uid}|${pumper}`;
        if (!pairs.has(key)) pairs.set(key, { beneficiary: sale.uid, pumper, occurrences: 0, markets: new Set() });
        const pair = pairs.get(key);
        pair.occurrences += 1;
        pair.markets.add(sale.marketId);
      }
    });
  }
  return [...pairs.values()]
    .map((pair) => ({ ...pair, markets: [...pair.markets].sort() }))
    .sort((a, b) => b.occurrences - a.occurrences || a.beneficiary.localeCompare(b.beneficiary));
}

export function creatorSelfTrading(events, creatorsByMarket = {}) {
  const list = validEvents(events);
  const creators = new Map(Object.entries(creatorsByMarket || {}).filter(([, uid]) => typeof uid === 'string' && uid));
  for (const event of list) {
    if (event.type === 'market_create' && event.marketId) creators.set(event.marketId, event.uid);
  }
  const rows = new Map();
  for (const event of list.filter(isTrade)) {
    if (creators.get(event.marketId) !== event.uid) continue;
    const key = `${event.uid}|${event.marketId}`;
    if (!rows.has(key)) rows.set(key, { uid: event.uid, marketId: event.marketId, trades: 0, bought: 0, sold: 0 });
    const row = rows.get(key);
    row.trades += 1;
    const amount = Number(event.amount) || 0;
    if (event.type === 'buy') row.bought += amount;
    else row.sold += amount;
  }
  return [...rows.values()]
    .map((row) => ({ ...row, bought: Math.round(row.bought * 100) / 100, sold: Math.round(row.sold * 100) / 100 }))
    .sort((a, b) => b.trades - a.trades || a.uid.localeCompare(b.uid));
}

export function computeFlags(events, { creatorsByMarket = {}, ...options } = {}) {
  const opts = { ...DEFAULT_FLAG_OPTIONS, ...options };
  const list = validEvents(events);
  return {
    eventCount: list.length,
    windowStartMs: list.length ? list[0].atMs : null,
    windowEndMs: list.length ? list[list.length - 1].atMs : null,
    options: opts,
    ...sharedFingerprints(list),
    tradeBursts: tradeBursts(list, opts),
    exclusivePairs: exclusivePairs(list, opts),
    pumpAndDump: pumpAndDump(list, opts),
    creatorSelfTrading: creatorSelfTrading(list, creatorsByMarket),
  };
}

// Every uid that appears in any flag, for email lookup by the admin endpoint.
export function flaggedUids(flags) {
  const uids = new Set();
  for (const key of ['sharedIpAndUserAgent', 'sharedIp', 'sharedUserAgent', 'exclusivePairs']) {
    for (const row of flags[key] || []) row.uids.forEach((uid) => uids.add(uid));
  }
  for (const row of flags.tradeBursts || []) uids.add(row.uid);
  for (const row of flags.creatorSelfTrading || []) uids.add(row.uid);
  for (const row of flags.pumpAndDump || []) { uids.add(row.beneficiary); uids.add(row.pumper); }
  return [...uids].sort();
}
