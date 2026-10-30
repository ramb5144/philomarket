// Admin allow-list for audit/flag endpoints. Pure; unit tested.
// Fails closed: an unset or empty PHILOMARKET_ADMIN_EMAILS grants nobody, and
// a "*" entry is ignored rather than treated as a wildcard.

export function parseAdminEmails(value) {
  return String(value || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email && email !== '*' && email.includes('@'));
}

export function isAdminEmail(email, value = process.env.PHILOMARKET_ADMIN_EMAILS) {
  const admins = parseAdminEmails(value);
  if (admins.length === 0) return false;
  const candidate = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return Boolean(candidate) && admins.includes(candidate);
}
