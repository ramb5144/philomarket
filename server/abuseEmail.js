// Canonical email form used for the one-account-per-mailbox binding.
// Pure (no Firebase) so it can be unit tested.
//
// - Case and surrounding whitespace never distinguish mailboxes here.
// - "+tag" subaddressing is stripped for every domain: mail to
//   name+anything@domain lands in the same inbox as name@domain at Gmail,
//   Google Workspace, Outlook, iCloud, Fastmail, and most school systems.
// - Dots are only ignored for consumer Gmail (gmail.com / googlemail.com).
//   Google Workspace and other providers treat dots as significant.

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export function canonicalEmail(email) {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return trimmed;

  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1).replace(/\.+$/, '');

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);

  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }
  if (!local) return trimmed;
  return `${local}@${domain}`;
}
