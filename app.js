import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { auth, firebaseConfigured } from './firebase.js';
import { appendPriceHistory, floorPoints, MARKET_LIQUIDITY, marketProbabilities, proceedsForSale } from './marketMath.js';
import { renderPriceChart as buildPriceChart, freshestHistory, historyStamp, seriesColor } from './priceChart.js';

const INITIAL_POINTS = 500;
const PREVIEW_KEY = 'philomarket.preview.v2';
const previewMode = import.meta.env.DEV && !firebaseConfigured;
const setupMissing = !firebaseConfigured && !previewMode;

const initialNames = [
  'Isai Medina', 'Rowan Liddell', 'Emily Tacey', 'Emylee Perkins', 'Betsy Barnard',
  'Qaira Saldivar', 'Omer Alp Danis', 'Grace Burke', 'David Li', 'Nicholas Ingram', 'Bobby McCann',
];

const el = {
  accountSummary: document.querySelector('#account-summary'),
  headerPoints: document.querySelector('#header-points'),
  accountButton: document.querySelector('#account-button'),
  signOutButton: document.querySelector('#sign-out-button'),
  signInButton: document.querySelector('#sign-in-button'),
  environmentBanner: document.querySelector('#environment-banner'),
  marketList: document.querySelector('#market-list'),
  marketCount: document.querySelector('#market-count'),
  emptyMarkets: document.querySelector('#empty-markets'),
  marketDetail: document.querySelector('#market-detail'),
  search: document.querySelector('#market-search'),
  sort: document.querySelector('#market-sort'),
  authDialog: document.querySelector('#auth-dialog'),
  authForm: document.querySelector('#auth-form'),
  authTitle: document.querySelector('#auth-title'),
  authCopy: document.querySelector('#auth-copy'),
  authFields: document.querySelector('#auth-fields'),
  authEmail: document.querySelector('#auth-email'),
  authPassword: document.querySelector('#auth-password'),
  authError: document.querySelector('#auth-error'),
  authSubmit: document.querySelector('#auth-submit'),
  authToggle: document.querySelector('#auth-mode-toggle'),
  authToggleCopy: document.querySelector('#mode-switch-copy'),
  verifyPanel: document.querySelector('#verify-panel'),
  setupHint: document.querySelector('#setup-hint'),
  createDialog: document.querySelector('#create-dialog'),
  createForm: document.querySelector('#create-form'),
  question: document.querySelector('#market-question'),
  outcomes: document.querySelector('#market-outcomes'),
  createError: document.querySelector('#create-error'),
  createSubmit: document.querySelector('#create-submit'),
  createSetupHint: document.querySelector('#create-setup-hint'),
  toast: document.querySelector('#toast'),
};

function makeOutcomeId(label, index) {
  const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'outcome';
  return `${slug}-${index + 1}`;
}

function makeInitialMarket() {
  const outcomes = initialNames.map((label, index) => ({ id: makeOutcomeId(label, index), label, shares: 0 }));
  return {
    id: 'scriba-first',
    question: 'Which baby will become a Scriba?',
    outcomes,
    liquidity: MARKET_LIQUIDITY,
    pointPool: 0,
    backCount: 0,
    sellCount: 0,
    priceHistory: appendPriceHistory([], outcomes),
    status: 'open',
    creatorUid: null,
    createdAt: new Date('2026-10-29T12:00:00.000Z').toISOString(),
  };
}

function readPreview() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREVIEW_KEY));
    if (
      saved && Array.isArray(saved.markets) && saved.markets.every((market) =>
        typeof market.id === 'string' && typeof market.question === 'string' && Array.isArray(market.outcomes)) &&
      Number.isInteger(saved.balance) && saved.balance >= 0
    ) return saved;
  } catch { /* Local preview still works when browser storage is unavailable. */ }
  return { markets: [makeInitialMarket()], balance: INITIAL_POINTS };
}

const preview = readPreview();
const state = {
  markets: [],
  selectedId: '',
  profile: null,
  user: null,
  position: {},
  costBasis: {},
  priceHistory: [],
  priceHistoryMarketId: '',
  authMode: 'signin',
  marketFilter: 'all',
  search: '',
  sort: 'active',
  stake: 10,
  marketError: '',
  lastSynced: null,
};
let toastTimer;

function marketChance(market, outcome) {
  const index = market.outcomes.indexOf(outcome);
  return (marketProbabilities(market.outcomes, market.liquidity || MARKET_LIQUIDITY)[index] || 0) * 100;
}

function formatPoints(value) {
  return `${Number(value || 0).toLocaleString()} pts`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEnvironment() {
  const message = previewMode
    ? 'Local preview · 500 sample points and market creation stay on this device. A verified email is required to trade; configure Firebase to enable accounts and shared markets.'
    : setupMissing
      ? 'Setup needed · connect the Firebase web configuration to enable email accounts and shared markets.'
      : state.marketError || '';
  el.environmentBanner.hidden = !message;
  el.environmentBanner.textContent = message;
  el.environmentBanner.classList.toggle('is-warning', !previewMode && Boolean(message));
}

function renderHeader() {
  if (previewMode) {
    el.accountSummary.hidden = false;
    el.signOutButton.hidden = true;
    el.signInButton.hidden = false;
    el.headerPoints.textContent = String(preview.balance);
    el.accountButton.textContent = 'Local demo';
    el.accountButton.title = 'Local preview account';
    el.signInButton.textContent = 'Sign in';
    el.signInButton.classList.add('preview-sign-in');
    return;
  }
  el.signInButton.classList.remove('preview-sign-in');
  if (state.profile) {
    el.accountSummary.hidden = false;
    el.signOutButton.hidden = false;
    el.signInButton.hidden = true;
    el.headerPoints.textContent = String(state.profile.points);
    el.accountButton.textContent = state.profile.email || 'Account';
    el.accountButton.title = `Signed in as ${state.profile.email || 'account'}`;
  } else {
    el.accountSummary.hidden = true;
    el.signOutButton.hidden = true;
    el.signInButton.hidden = false;
    el.signInButton.textContent = state.user?.emailVerified ? 'Finish sign-in' : state.user ? 'Verify email' : 'Sign in';
  }
}

function marketIsMine(market) {
  if (previewMode) return market.creatorUid === 'preview-user';
  return Boolean(state.profile && market.isMine);
}

function filteredMarkets() {
  const query = state.search.trim().toLocaleLowerCase();
  let results = state.markets.filter((market) => {
    if (state.marketFilter === 'mine' && !marketIsMine(market)) return false;
    if (!query) return true;
    return `${market.question} ${market.outcomes.map((outcome) => outcome.label).join(' ')}`.toLocaleLowerCase().includes(query);
  });

  if (state.sort === 'newest') results = results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  else if (state.sort === 'alphabetical') results = results.sort((a, b) => a.question.localeCompare(b.question));
  else results = results.sort((a, b) =>
    (Number(b.liquidityReserve) || 0) - (Number(a.liquidityReserve) || 0) ||
    (Number(b.pointPool) || 0) - (Number(a.pointPool) || 0) ||
    b.createdAt.localeCompare(a.createdAt));
  return results;
}

function renderMarketList() {
  const markets = filteredMarkets();
  const fragment = document.createDocumentFragment();
  el.marketCount.textContent = String(markets.length);
  el.emptyMarkets.hidden = markets.length > 0;

  markets.forEach((market) => {
    const button = element('button', `market-list-item${market.id === state.selectedId ? ' is-selected' : ''}`);
    button.type = 'button';
    button.dataset.marketId = market.id;
    button.setAttribute('aria-pressed', String(market.id === state.selectedId));
    const tag = element('span', 'market-list-tag', `${market.status === 'open' ? 'Open' : market.status}  ·  ${market.outcomes.length} outcomes`);
    const question = element('strong', 'market-list-question', market.question);
    const lead = market.outcomes.reduce((best, current) => marketChance(market, current) > marketChance(market, best) ? current : best, market.outcomes[0]);
    const details = element('span', 'market-list-details');
    details.append(
      element('span', 'market-leader', `${lead.label} · ${marketChance(market, lead).toFixed(1)}%`),
      element('span', 'market-pool-total', formatPoints(market.pointPool)),
    );
    const miniature = element('span', 'market-mini-bar');
    miniature.setAttribute('aria-hidden', 'true');
    const leaderFill = element('i', 'mini-segment');
    leaderFill.style.width = `${marketChance(market, lead)}%`;
    miniature.append(leaderFill);
    button.append(tag, question, details, miniature);
    fragment.append(button);
  });
  el.marketList.replaceChildren(fragment);
}

function currentBalance() {
  if (previewMode) return preview.balance;
  return state.profile?.points ?? null;
}

function actionLabel() {
  if (state.profile) return Number.isFinite(state.stake) ? `Back ${state.stake} pts` : 'Choose amount';
  if (state.user && !state.user.emailVerified) return 'Verify email';
  if (state.user?.emailVerified) return 'Loading account';
  if (setupMissing) return 'Setup needed';
  return 'Sign in';
}

function updateStakeControls() {
  const input = el.marketDetail.querySelector('#stake-input');
  if (!input) return;
  const raw = input.value.trim();
  const amount = Number(raw);
  const cents = Math.round(amount * 100);
  const max = Number(input.max);
  const valid = raw !== '' && Number.isFinite(amount) && cents > 0 && Math.abs(amount - cents / 100) < 1e-8 && amount <= max;
  state.stake = valid ? cents / 100 : null;
  const market = state.markets.find((item) => item.id === state.selectedId);
  const balance = currentBalance();
  el.marketDetail.querySelectorAll('.back-button').forEach((button) => {
    button.textContent = actionLabel();
    button.setAttribute('aria-label', `${actionLabel()} on ${button.dataset.outcomeLabel}`);
    button.disabled = !valid || setupMissing || market?.status !== 'open' || (state.profile && balance < state.stake);
  });
  el.marketDetail.querySelectorAll('.sell-button').forEach((button) => {
    const maxSellPoints = Number(button.dataset.maxSellPoints) || 0;
    const sellAmount = valid ? Math.min(state.stake, maxSellPoints) : 0;
    button.dataset.sellAmount = String(sellAmount);
    button.textContent = sellAmount > 0 ? `Sell ${formatPoints(sellAmount)}` : 'Choose amount';
    button.setAttribute('aria-label', `Sell ${formatPoints(sellAmount)} worth of ${button.dataset.outcomeLabel} at the current market price. Maximum available: ${formatPoints(maxSellPoints)}.`);
    button.disabled = !valid || market?.status !== 'open' || sellAmount < 0.01;
  });
}

function renderPriceChart(market) {
  const current = marketProbabilities(market.outcomes, market.liquidity || MARKET_LIQUIDITY);
  const history = freshestHistory(state.priceHistoryMarketId === market.id ? state.priceHistory : [], market.priceHistory);
  return buildPriceChart({ market, history, current });
}

function renderMarketDetail() {
  const market = state.markets.find((item) => item.id === state.selectedId);
  if (!market) {
    el.marketDetail.replaceChildren(element('div', 'detail-empty', 'Choose a market to see its outcomes.'));
    return;
  }

  const balance = currentBalance();
  const spendLimit = balance ?? INITIAL_POINTS;
  const maxSaleAmount = market.outcomes.reduce((max, outcome, index) => {
    const heldShares = Number(state.position[outcome.id]) || 0;
    if (heldShares <= 0) return max;
    const quote = proceedsForSale(market.outcomes, index, heldShares, market.liquidity || MARKET_LIQUIDITY);
    return Math.max(max, floorPoints(Math.min(quote, Number(market.pointPool) || 0)));
  }, 0);
  const amountLimit = Math.max(spendLimit || 0, maxSaleAmount);
  if (!Number.isFinite(state.stake) || state.stake <= 0) state.stake = amountLimit > 0 ? Math.min(10, amountLimit) : null;
  else if (amountLimit <= 0) state.stake = null;
  else state.stake = Math.min(state.stake, amountLimit);

  const wrapper = element('div', 'detail-content');
  const top = element('div', 'detail-topline');
  const marketLabel = element('span', 'detail-market-label');
  marketLabel.append(element('i', 'market-status-dot'), `${market.status === 'open' ? 'Open' : market.status}  ·  ${market.outcomes.length} outcomes`);
  const refreshedAt = state.lastSynced
    ? `Updated ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(state.lastSynced)}`
    : 'Not synced yet';
  const refreshTools = element('div', 'refresh-tools');
  refreshTools.append(element('span', 'refresh-label', refreshedAt));
  const refreshButton = element('button', 'refresh-button', 'Refresh');
  refreshButton.type = 'button';
  refreshButton.setAttribute('aria-label', 'Refresh shared market odds');
  refreshButton.addEventListener('click', () => refreshMarkets());
  refreshTools.append(refreshButton);
  top.append(marketLabel, refreshTools);

  const title = element('h2', 'detail-title', market.question);
  title.id = 'detail-title';
  const description = element('p', 'detail-description', 'Prices move as members buy and sell. You can sell a pick back at the current price at any time while the market is open.');

  const stats = element('div', 'detail-stats');
  const poolStat = element('div', 'detail-stat');
  poolStat.append(element('span', '', 'Points in play'), element('strong', '', formatPoints(market.pointPool)));
  const tradesStat = element('div', 'detail-stat');
  tradesStat.append(element('span', '', 'Backers'), element('strong', '', Number(market.backerCount || 0).toLocaleString()));
  const oddsStat = element('div', 'detail-stat');
  oddsStat.append(element('span', '', 'Outcomes'), element('strong', '', String(market.outcomes.length)));
  stats.append(poolStat, tradesStat, oddsStat);

  const outcomeSection = element('section', 'outcome-section');
  const sectionHeading = element('div', 'outcome-section-heading');
  sectionHeading.append(element('h3', '', 'Outcomes'), element('label', 'stake-picker-label'));
  const stakeLabel = sectionHeading.querySelector('label');
  stakeLabel.htmlFor = 'stake-input';
  stakeLabel.append(document.createTextNode('Points per pick '));
  const stakeInput = document.createElement('input');
  stakeInput.id = 'stake-input';
  stakeInput.className = 'stake-picker';
  stakeInput.type = 'number';
  stakeInput.min = '0.01';
  stakeInput.max = String(Math.max(0, amountLimit));
  stakeInput.step = '0.01';
  stakeInput.inputMode = 'decimal';
  stakeInput.value = Number.isFinite(state.stake) ? String(state.stake) : '';
  stakeInput.setAttribute('aria-label', 'Points to buy or sell per pick');
  stakeInput.addEventListener('input', updateStakeControls);
  stakeLabel.append(stakeInput);

  const list = element('ol', 'outcome-table');
  list.setAttribute('aria-label', 'Market prices and trading actions');
  const tableHeader = element('li', 'outcome-table-header');
  tableHeader.append(element('span', '', 'Outcome'), element('span', '', 'Market price'), element('span', '', 'Trade'));
  list.append(tableHeader);

  market.outcomes.forEach((outcome, index) => {
    const chance = marketChance(market, outcome);
    const heldShares = Number(state.position[outcome.id]) || 0;
    const row = element('li', 'outcome-row');
    const outcomeIdentity = element('div', 'outcome-identity');
    const badge = element('span', 'outcome-badge', String(index + 1).padStart(2, '0'));
    badge.style.setProperty('--badge-color', seriesColor(index));
    const name = element('span', 'outcome-name', outcome.label);
    const identityDetails = element('div', 'outcome-identity-details');
    identityDetails.append(name);
    if (state.profile && heldShares > 0) {
      const basis = state.costBasis[outcome.id];
      const buyIn = typeof basis === 'number' && Number.isFinite(basis)
        ? `Bought in for ${formatPoints(basis)}`
        : 'Buy-in unavailable for this older position';
      identityDetails.append(element('small', 'outcome-investment', buyIn));
    }
    outcomeIdentity.append(badge, identityDetails);

    const chanceCell = element('div', 'outcome-chance');
    chanceCell.append(element('strong', 'chance-pill', `$${(chance / 100).toFixed(2)}`));
    const track = element('span', 'chance-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = element('i', 'chance-fill');
    fill.style.width = `${chance}%`;
    track.append(fill);
    chanceCell.append(track, element('small', 'outcome-points', `${chance.toFixed(1)}% implied chance`));

    const actions = element('div', 'outcome-actions');
    const backButton = element('button', 'back-button', actionLabel());
    backButton.type = 'button';
    backButton.dataset.outcomeId = outcome.id;
    backButton.dataset.outcomeLabel = outcome.label;
    backButton.setAttribute('aria-label', `${actionLabel()} on ${outcome.label}`);
    const validStake = Number.isFinite(state.stake) && state.stake >= 0.01 && state.stake <= amountLimit;
    backButton.disabled = !validStake || setupMissing || market.status !== 'open' || (state.profile && balance < state.stake);
    actions.append(backButton);

    if (state.profile && heldShares > 0) {
      const quote = proceedsForSale(market.outcomes, index, heldShares, market.liquidity || MARKET_LIQUIDITY);
      const estimate = floorPoints(Math.min(quote, Number(market.pointPool) || 0));
      const sellAmount = Math.min(state.stake || 0, estimate);
      const sellButton = element('button', 'sell-button', `Sell ${formatPoints(sellAmount)}`);
      sellButton.type = 'button';
      sellButton.dataset.sellOutcomeId = outcome.id;
      sellButton.dataset.outcomeLabel = outcome.label;
      sellButton.dataset.maxSellPoints = String(estimate);
      sellButton.dataset.sellAmount = String(sellAmount);
      sellButton.setAttribute('aria-label', `Sell ${formatPoints(sellAmount)} worth of ${outcome.label} at the current market price. Maximum available: ${formatPoints(estimate)}.`);
      sellButton.title = `Maximum available: ${formatPoints(estimate)}`;
      sellButton.disabled = !validStake || market.status !== 'open' || sellAmount < 0.01;
      const sellAllButton = element('button', 'sell-all-button', 'Sell all');
      sellAllButton.type = 'button';
      sellAllButton.dataset.sellOutcomeId = outcome.id;
      sellAllButton.dataset.sellAll = 'true';
      sellAllButton.dataset.outcomeLabel = outcome.label;
      sellAllButton.setAttribute('aria-label', `Sell your whole ${outcome.label} position at the current market price, about ${formatPoints(estimate)}.`);
      sellAllButton.disabled = market.status !== 'open' || estimate < 0.01;
      const sellValue = element('small', 'sell-value', `Worth ${formatPoints(estimate)} now`);
      actions.append(sellButton, sellAllButton, sellValue);
    }

    row.append(outcomeIdentity, chanceCell, actions);
    list.append(row);
  });
  outcomeSection.append(sectionHeading, list);

  const explanation = element('p', 'detail-footnote');
  explanation.append(
    document.createTextNode('Prices use a simulated $1 contract scale. Points have no cash value; there are no real-money trades, prizes, or payouts.'),
  );

  wrapper.append(top, title, description, stats, renderPriceChart(market), outcomeSection, explanation);
  el.marketDetail.replaceChildren(wrapper);
}

function render() {
  renderEnvironment();
  renderHeader();
  renderMarketList();
  renderMarketDetail();
}

// One key per trade click: the server returns the original result for a
// replayed key instead of trading twice.
function tradeRequestKey() {
  return globalThis.crypto?.randomUUID?.() || `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function requestApi(path, options = {}) {
  const { auth = true, headers: requestHeaders, ...requestOptions } = options;
  const headers = { 'Content-Type': 'application/json', ...requestHeaders };
  if (auth && state.user) headers.Authorization = `Bearer ${await state.user.getIdToken()}`;
  const response = await fetch(path, { ...requestOptions, headers });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('The market API is not available.'); }
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

async function refreshSelectedMarketData() {
  const marketId = state.selectedId;
  const market = state.markets.find((item) => item.id === marketId);
  if (!marketId || !market) {
    state.position = {};
    state.costBasis = {};
    state.priceHistory = [];
    state.priceHistoryMarketId = '';
    renderMarketDetail();
    return;
  }
  const historyRequest = requestApi(`/api/markets/${encodeURIComponent(marketId)}/history`, { auth: false });
  const positionRequest = state.profile && !previewMode
    ? requestApi(`/api/markets/${encodeURIComponent(marketId)}/position`)
    : Promise.resolve({ position: {}, costBasis: {} });
  const [historyResult, positionResult] = await Promise.allSettled([historyRequest, positionRequest]);
  if (marketId !== state.selectedId) return;
  // The history endpoint is CDN-cached, so a fetch made right after our own trade can return
  // an older copy than the one the trade response gave us. Never replace newer with older.
  const heldHistory = state.priceHistoryMarketId === marketId ? state.priceHistory : [];
  const latestMarket = state.markets.find((item) => item.id === marketId) || market;
  state.priceHistoryMarketId = marketId;
  state.priceHistory = freshestHistory(
    historyResult.status === 'fulfilled' ? historyResult.value.priceHistory || [] : [],
    heldHistory,
    latestMarket.priceHistory || [],
  );
  state.position = positionResult.status === 'fulfilled' ? positionResult.value.position || {} : {};
  state.costBasis = positionResult.status === 'fulfilled' ? positionResult.value.costBasis || {} : {};
  if (positionResult.status === 'rejected' && state.profile) state.marketError = positionResult.reason.message;
  renderMarketDetail();
}

function writePreview() {
  try {
    localStorage.setItem(PREVIEW_KEY, JSON.stringify({ markets: preview.markets, balance: preview.balance }));
  } catch { /* The local preview still works until the page is closed. */ }
}

let marketsRefreshing = null;
function refreshMarkets() {
  if (!marketsRefreshing) marketsRefreshing = loadMarkets().finally(() => { marketsRefreshing = null; });
  return marketsRefreshing;
}

async function loadMarkets() {
  try {
    const result = await requestApi('/api/markets', { method: 'GET' });
    if (!Array.isArray(result.markets)) throw new Error('Market response is incomplete.');
    // Keep a market we already hold when the fetched copy is older (cached list after a trade).
    state.markets = result.markets.map((fetched) => {
      const held = state.markets.find((item) => item.id === fetched.id);
      return held && historyStamp(held.priceHistory) > historyStamp(fetched.priceHistory) ? held : fetched;
    });
    state.marketError = '';
  } catch (error) {
    if (previewMode) {
      if (!preview.markets.length) preview.markets.push(makeInitialMarket());
      state.markets = preview.markets;
    } else {
      if (!state.markets.length) state.markets = [makeInitialMarket()];
      state.marketError = error.message;
    }
  }
  if (!state.selectedId || !state.markets.some((market) => market.id === state.selectedId)) {
    state.selectedId = state.markets[0]?.id || '';
  }
  state.lastSynced = new Date();
  render();
  await refreshSelectedMarketData();
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => el.toast.classList.remove('is-visible'), 2600);
}

function showFormError(node, message) {
  node.hidden = !message;
  node.textContent = message;
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === 'signup';
  el.authTitle.textContent = signup ? 'Create your account' : 'Sign in to Philomarket';
  el.authCopy.textContent = signup
    ? 'Verify your email to activate your account and receive 500 practice points.'
    : 'Your verified email account keeps your 500 practice points and market picks together.';
  el.authSubmit.textContent = signup ? 'Create account & send link' : 'Continue with email';
  el.authToggleCopy.textContent = signup ? 'Already have an account?' : 'New to Philomarket?';
  el.authToggle.textContent = signup ? 'Sign in' : 'Create account';
  el.authPassword.autocomplete = signup ? 'new-password' : 'current-password';
  showFormError(el.authError, '');
}

function showVerification(user) {
  el.authFields.hidden = true;
  el.authSubmit.hidden = true;
  el.authToggle.closest('.mode-switch').hidden = true;
  el.verifyPanel.hidden = false;
  el.authTitle.textContent = 'Verify your email';
  el.authCopy.textContent = `We sent a verification link to ${user?.email || 'your email address'}. Your 500 points activate after verification.`;
  el.authDialog.showModal();
}

function resetAuthDialog() {
  el.authFields.hidden = false;
  el.authSubmit.hidden = false;
  el.authToggle.closest('.mode-switch').hidden = false;
  el.verifyPanel.hidden = true;
  el.setupHint.hidden = !setupMissing && !previewMode;
  el.authForm.reset();
  setAuthMode('signin');
}

async function loadProfile(user) {
  state.user = user;
  state.position = {};
  state.costBasis = {};
  if (!user || !user.emailVerified) {
    state.profile = null;
    state.position = {};
    state.costBasis = {};
    render();
    return;
  }
  try {
    await user.getIdToken(true);
    const result = await requestApi('/api/profile');
    state.profile = result.profile;
    state.marketError = '';
    render();
    await refreshMarkets();
  } catch (error) {
    state.profile = null;
    state.marketError = error.message;
    render();
    showToast(error.message);
  }
}

function openAuthDialog() {
  resetAuthDialog();
  if (previewMode) {
    el.setupHint.hidden = false;
    el.setupHint.textContent = 'The local preview uses sample points on this device. Firebase configuration enables real verified accounts and shared balances.';
  }
  if (setupMissing) {
    el.setupHint.hidden = false;
    el.setupHint.textContent = 'Firebase is not configured for this deployment yet. Add the client configuration and server service account to enable email accounts.';
  }
  if (state.user && !state.user.emailVerified) showVerification(state.user);
  else el.authDialog.showModal();
}

async function submitAuth(event) {
  event.preventDefault();
  showFormError(el.authError, '');
  if (!firebaseConfigured) {
    showFormError(el.authError, previewMode
      ? 'Email sign-in is unavailable in this local preview. The 500-point sample account remains on this device.'
      : 'Connect Firebase to enable email sign-in.');
    return;
  }

  const email = el.authEmail.value.trim();
  const password = el.authPassword.value;
  el.authSubmit.disabled = true;
  try {
    if (state.authMode === 'signup') {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      state.user = credential.user;
      await sendEmailVerification(credential.user);
      renderHeader();
      showVerification(credential.user);
      return;
    }

    const credential = await signInWithEmailAndPassword(auth, email, password);
    await credential.user.reload();
    state.user = auth.currentUser;
    if (!state.user.emailVerified) {
      renderHeader();
      showVerification(state.user);
      return;
    }
    await loadProfile(state.user);
    if (state.profile) {
      el.authDialog.close();
      showToast(`Welcome back. ${state.profile.points} points are ready.`);
    }
  } catch (error) {
    const message = error.code === 'auth/email-already-in-use'
      ? 'That email already has an account. Sign in instead.'
      : error.code === 'auth/weak-password'
        ? 'Choose a password with at least 8 characters.'
        : error.code === 'auth/invalid-credential'
          ? 'That email and password did not match.'
          : error.code === 'auth/too-many-requests'
            ? 'Too many attempts. Wait a moment and try again.'
            : error.message || 'Sign-in could not be completed.';
    showFormError(el.authError, message);
  } finally {
    el.authSubmit.disabled = false;
  }
}

async function checkVerification() {
  if (!auth?.currentUser) return showFormError(el.authError, 'Sign in again to check your verification status.');
  try {
    await auth.currentUser.reload();
    state.user = auth.currentUser;
    if (!state.user.emailVerified) {
      return showFormError(el.authError, 'Your email is not verified yet. Open the email link, then try again.');
    }
    await loadProfile(state.user);
    if (state.profile) {
      el.authDialog.close();
      showToast('Email verified. Your 500 practice points are ready.');
    }
  } catch (error) {
    showFormError(el.authError, error.message || 'Could not check verification status.');
  }
}

async function resendVerification() {
  if (!auth?.currentUser) return showFormError(el.authError, 'Sign in again to resend the verification email.');
  try {
    await sendEmailVerification(auth.currentUser);
    showFormError(el.authError, 'Another verification link is on its way.');
  } catch (error) {
    showFormError(el.authError, error.code === 'auth/too-many-requests' ? 'Please wait before requesting another email.' : 'Could not send the email right now.');
  }
}

function openCreateDialog() {
  showFormError(el.createError, '');
  el.createForm.reset();
  const atMarketLimit = !previewMode && Number(state.profile?.marketsCreated || 0) >= 10;
  el.createSubmit.disabled = atMarketLimit;
  el.createSetupHint.hidden = !previewMode && !setupMissing && Boolean(state.profile);
  if (previewMode) {
    el.createSetupHint.hidden = false;
    el.createSetupHint.textContent = 'Local preview markets are stored on this device and are not shared.';
  } else if (setupMissing) {
    el.createSetupHint.hidden = false;
    el.createSetupHint.textContent = 'Connect Firebase before publishing a shared market.';
  } else if (!state.profile) {
    el.createSetupHint.hidden = false;
    el.createSetupHint.textContent = 'Sign in with a verified email to publish this market.';
  }
  if (atMarketLimit) {
    el.createSetupHint.hidden = false;
    el.createSetupHint.textContent = 'This account cannot create more markets right now.';
  }
  el.createDialog.showModal();
}

function validateMarketInput(question, labels) {
  if (question.length < 8 || question.length > 140) return 'Write a market question between 8 and 140 characters.';
  if (labels.length < 2 || labels.length > 12) return 'Add between 2 and 12 outcomes, one per line.';
  if (labels.some((label) => label.length < 1 || label.length > 50)) return 'Each outcome must be 1 to 50 characters.';
  if (new Set(labels.map((label) => label.toLocaleLowerCase())).size !== labels.length) return 'Outcome names must be unique.';
  return '';
}

async function submitMarket(event) {
  event.preventDefault();
  showFormError(el.createError, '');
  const question = el.question.value.trim();
  const labels = el.outcomes.value.split(/\r?\n/).map((label) => label.trim()).filter(Boolean);
  const validationError = validateMarketInput(question, labels);
  if (validationError) return showFormError(el.createError, validationError);
  if (!previewMode && !state.profile) {
    el.createDialog.close();
    openAuthDialog();
    showFormError(el.authError, state.user ? 'Verify your email before publishing a market.' : 'Sign in with a verified email to publish a market.');
    return;
  }

  el.createSubmit.disabled = true;
  try {
    let market;
    if (previewMode) {
      market = {
        id: `local-${crypto.randomUUID()}`,
        question,
        outcomes: labels.map((label, index) => ({ id: makeOutcomeId(label, index), label, shares: 0 })),
        liquidity: MARKET_LIQUIDITY,
        pointPool: 0,
        backCount: 0,
        sellCount: 0,
        priceHistory: appendPriceHistory([], labels.map(() => ({ shares: 0 }))),
        status: 'open',
        creatorUid: 'preview-user',
        createdAt: new Date().toISOString(),
      };
      preview.markets.unshift(market);
      writePreview();
    } else {
      const result = await requestApi('/api/markets', {
        method: 'POST',
        body: JSON.stringify({ question, outcomes: labels }),
      });
      market = result.market;
      state.profile = result.profile;
      state.markets.unshift(market);
      state.position = result.position || {};
    }
    state.position = {};
    state.costBasis = {};
    state.selectedId = market.id;
    state.priceHistoryMarketId = market.id;
    state.priceHistory = market.priceHistory || [];
    state.marketFilter = 'all';
    document.querySelector('[data-filter="all"]').click();
    el.createDialog.close();
    render();
    showToast('Market created. Every outcome starts evenly.');
  } catch (error) {
    showFormError(el.createError, error.message);
  } finally {
    el.createSubmit.disabled = false;
  }
}

async function backOutcome(outcomeId) {
  const market = state.markets.find((item) => item.id === state.selectedId);
  if (!market) return;
  if (!state.profile) {
    openAuthDialog();
    showFormError(el.authError, state.user && !state.user.emailVerified
      ? 'Verify your email before using points.'
      : 'Sign in with a verified email before backing a market.');
    return;
  }
  if (!Number.isFinite(state.stake) || state.stake < 0.01) return showToast('Enter a point amount to use for this pick.');
  if (currentBalance() < state.stake) return showToast('You do not have enough points for that pick.');

  try {
    const result = await requestApi(`/api/markets/${encodeURIComponent(market.id)}/back`, {
      method: 'POST',
      headers: { 'Idempotency-Key': tradeRequestKey() },
      body: JSON.stringify({ outcomeId, amount: state.stake }),
    });
    state.profile = result.profile;
    state.markets = state.markets.map((item) => item.id === market.id ? result.market : item);
    state.position = result.position || {};
    state.costBasis = result.costBasis || {};
    state.priceHistoryMarketId = market.id;
    state.priceHistory = result.market.priceHistory || [];
    render();
    showToast(`Position added for ${formatPoints(state.stake)}. No money involved.`);
  } catch (error) {
    showToast(error.message);
  }
}

async function sellOutcome(outcomeId, amount, all = false) {
  const market = state.markets.find((item) => item.id === state.selectedId);
  if (!market) return;
  if (!state.profile) {
    openAuthDialog();
    showFormError(el.authError, 'Sign in with a verified email before selling a position.');
    return;
  }
  try {
    const result = await requestApi(`/api/markets/${encodeURIComponent(market.id)}/sell`, {
      method: 'POST',
      headers: { 'Idempotency-Key': tradeRequestKey() },
      body: JSON.stringify(all ? { outcomeId, all: true } : { outcomeId, amount }),
    });
    state.profile = result.profile;
    state.markets = state.markets.map((item) => item.id === market.id ? result.market : item);
    state.position = result.position || {};
    state.costBasis = result.costBasis || {};
    state.priceHistoryMarketId = market.id;
    state.priceHistory = result.market.priceHistory || [];
    render();
    showToast(`Sold ${formatPoints(result.proceeds)} worth of this pick.`);
  } catch (error) {
    showToast(error.message);
  }
}

el.marketList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-market-id]');
  if (!button) return;
  state.selectedId = button.dataset.marketId;
  state.position = {};
  state.costBasis = {};
  state.priceHistory = [];
  state.priceHistoryMarketId = state.selectedId;
  render();
  // Re-fetch the markets themselves (not just history/position) so prices and the
  // sell quote reflect trades made since the page first loaded.
  refreshMarkets();
});

el.marketDetail.addEventListener('click', (event) => {
  const sellButton = event.target.closest('button[data-sell-outcome-id]');
  if (sellButton) {
    if (sellButton.dataset.sellAll === 'true') sellOutcome(sellButton.dataset.sellOutcomeId, 0, true);
    else sellOutcome(sellButton.dataset.sellOutcomeId, Number(sellButton.dataset.sellAmount));
    return;
  }
  const button = event.target.closest('button[data-outcome-id]');
  if (button) backOutcome(button.dataset.outcomeId);
});

document.querySelectorAll('.market-tab').forEach((button) => {
  button.addEventListener('click', () => {
    state.marketFilter = button.dataset.filter;
    document.querySelectorAll('.market-tab').forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle('is-selected', selected);
      tab.setAttribute('aria-pressed', String(selected));
    });
    renderMarketList();
  });
});

el.search.addEventListener('input', () => {
  state.search = el.search.value;
  renderMarketList();
});
el.sort.addEventListener('change', () => {
  state.sort = el.sort.value;
  renderMarketList();
});

el.signInButton.addEventListener('click', openAuthDialog);
el.signOutButton.addEventListener('click', async () => {
  if (previewMode) return showToast('This is a local sample account. It is not email-verified.');
  if (!auth) return openAuthDialog();
  try {
    await signOut(auth);
    state.user = null;
    state.profile = null;
    state.position = {};
    state.costBasis = {};
    render();
    showToast('Signed out.');
  } catch { showToast('Could not sign out right now.'); }
});
document.querySelector('#nav-create').addEventListener('click', openCreateDialog);
document.querySelector('#create-market-button').addEventListener('click', openCreateDialog);
el.authForm.addEventListener('submit', submitAuth);
el.authToggle.addEventListener('click', () => setAuthMode(state.authMode === 'signin' ? 'signup' : 'signin'));
document.querySelector('#check-verification').addEventListener('click', checkVerification);
document.querySelector('#resend-verification').addEventListener('click', resendVerification);
el.createForm.addEventListener('submit', submitMarket);
document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close());
});
document.querySelectorAll('.modal-dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
});
window.addEventListener('keydown', (event) => {
  if (event.key === '/' && !event.metaKey && !event.ctrlKey && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    el.search.focus();
  }
});

if (auth) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      state.user = null;
      state.profile = null;
      state.position = {};
      state.costBasis = {};
      render();
      return;
    }
    state.user = user;
    if (!user.emailVerified) {
      state.profile = null;
      state.position = {};
      state.costBasis = {};
      render();
      return;
    }
    await loadProfile(user);
  });
}

// Keep the open market's prices and sell quotes current. Skip a tick while the person is
// typing in the market panel, hovering the chart, or using a dialog, so nothing jumps.
const MARKET_POLL_MS = 10000;
window.setInterval(() => {
  if (document.visibilityState !== 'visible' || !state.selectedId) return;
  if (document.querySelector('dialog[open]')) return;
  if (el.marketDetail.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) return;
  if (el.marketDetail.querySelector('.price-chart-frame:hover')) return;
  refreshMarkets();
}, MARKET_POLL_MS);

setAuthMode('signin');
render();
refreshMarkets();
