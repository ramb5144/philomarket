// Fixed-window, per-key counter held in function-instance memory. Best effort
// only: each warm Vercel instance has its own counters and a cold start resets
// them. It caps a single hammering client cheaply; it is not a global limit.
export function createWindowLimiter({ limit, windowMs, maxKeys = 5000 }) {
  const windows = new Map();
  return function allow(key, now = Date.now()) {
    const id = key || 'unknown';
    let entry = windows.get(id);
    if (!entry || now - entry.start >= windowMs) {
      if (!entry && windows.size >= maxKeys) {
        for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
        if (windows.size >= maxKeys) windows.delete(windows.keys().next().value);
      }
      entry = { start: now, count: 0 };
      windows.set(id, entry);
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}
