import { getAdminServices } from '../../server/firebaseAdmin.js';
import { handleApiError, methodNotAllowed, requireVerifiedUser, sendJson } from '../../server/http.js';
import { AUDIT_COLLECTION } from '../../server/abuseAudit.js';
import { isAdminEmail, parseAdminEmails } from '../../server/abuseAdmin.js';
import { computeFlags, flaggedUids } from '../../server/abuseFlags.js';

const DEFAULT_HOURS = 168;
const MAX_HOURS = 720;
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

// Non-admins and an unconfigured allow-list both get the same 404 so the
// endpoint's existence is not advertised.
function notFound() {
  return Object.assign(new Error('Not found.'), { status: 404 });
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    if (parseAdminEmails(process.env.PHILOMARKET_ADMIN_EMAILS).length === 0) throw notFound();
    let decoded;
    try { decoded = await requireVerifiedUser(req); } catch { throw notFound(); }
    if (!isAdminEmail(decoded.email)) throw notFound();

    const hours = boundedInt(req.query?.hours, DEFAULT_HOURS, 1, MAX_HOURS);
    const limit = boundedInt(req.query?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const sinceMs = Date.now() - hours * 60 * 60 * 1000;

    const { db, auth } = getAdminServices();
    const [auditSnapshot, marketSnapshot] = await Promise.all([
      db.collection(AUDIT_COLLECTION)
        .where('atMs', '>=', sinceMs)
        .orderBy('atMs', 'desc')
        .limit(limit)
        .get(),
      db.collection('markets').select('creatorUid').get(),
    ]);

    const events = auditSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        type: data.type,
        uid: data.uid,
        marketId: data.marketId,
        outcomeId: data.outcomeId ?? null,
        amount: data.amount ?? null,
        ip: data.ip,
        uaHash: data.uaHash,
        atMs: data.atMs,
      };
    });
    const creatorsByMarket = Object.fromEntries(marketSnapshot.docs
      .map((doc) => [doc.id, doc.get('creatorUid')])
      .filter(([, uid]) => typeof uid === 'string' && uid));

    const flags = computeFlags(events, { creatorsByMarket });
    const uids = flaggedUids(flags);
    const accounts = {};
    for (let i = 0; i < uids.length; i += 100) {
      const result = await auth.getUsers(uids.slice(i, i + 100).map((uid) => ({ uid })));
      for (const user of result.users) accounts[user.uid] = { email: user.email || null, disabled: user.disabled === true };
      for (const missing of result.notFound) accounts[missing.uid] = { email: null, deleted: true };
    }

    return sendJson(res, 200, {
      query: { hours, limit, truncated: auditSnapshot.size >= limit },
      accounts,
      flags,
    });
  } catch (error) {
    return handleApiError(res, error);
  }
}
