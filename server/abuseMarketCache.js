// Instance-local cache of market documents for GET /api/markets.
//
// Without it, every CDN miss (and a random query string forces one) scanned up
// to 200 market docs, so a few hundred anonymous requests could exhaust the
// Firestore free read quota. A warm instance now does one full scan, then
// refreshes with a delta query on updatedAt: an idle refresh costs one read,
// and each changed market costs one more.
const REFRESH_MS = 5_000;

const millis = (value) => (typeof value?.toMillis === 'function' ? value.toMillis() : null);

export function createMarketCache({ refreshMs = REFRESH_MS } = {}) {
  let markets = null; // Map<id, data>
  let watermark = null; // Firestore Timestamp of the newest updatedAt seen
  let fetchedAt = 0;
  let inflight = null;

  function absorb(docs) {
    for (const doc of docs) {
      const data = doc.data();
      markets.set(doc.id, data);
      if (millis(data.updatedAt) !== null && (watermark === null || millis(data.updatedAt) > millis(watermark))) {
        watermark = data.updatedAt;
      }
    }
  }

  async function refresh(db) {
    const collection = db.collection('markets');
    if (markets === null || watermark === null) {
      const snapshot = await collection.get();
      markets = new Map();
      absorb(snapshot.docs);
    } else {
      // >= re-reads the boundary doc(s) so an equal-timestamp commit is not missed.
      const snapshot = await collection.where('updatedAt', '>=', watermark).get();
      absorb(snapshot.docs);
    }
    fetchedAt = Date.now();
  }

  return {
    async list(db) {
      if (markets === null || Date.now() - fetchedAt >= refreshMs) {
        inflight = inflight || refresh(db).finally(() => { inflight = null; });
        await inflight;
      }
      return [...markets.entries()].map(([id, data]) => ({ id, data }));
    },
    invalidate() { fetchedAt = 0; },
  };
}
