// Price chart rendering for a market's priceHistory.
//
// The server appends one snapshot per trade (marketMath.appendPriceHistory), so a market's
// price is a step function: it holds still between trades and jumps at each trade. Drawing
// straight segments between those irregular snapshots turns every hold into a fake ramp and
// every burst of trades into vertical zigzags. Instead this module:
//   1. resamples the snapshots onto an even time grid from the first snapshot to "now",
//      holding the last known price at each grid time (what the market really showed), and
//   2. draws each outcome through that grid with a monotone cubic curve, which is smooth but
//      never overshoots its neighbours, so a line can never leave the 0–100% band.

const SVG_NS = 'http://www.w3.org/2000/svg';

export const CHART_COLORS = [
  '#000000', '#9b3b2f', '#2f5d8a', '#5b7a3a', '#a07a1f', '#6b4c8a',
  '#2f7a78', '#a0522d', '#6e6e6e', '#7a2f5b', '#3d5a40', '#b0a089',
];

export function seriesColor(index) {
  return CHART_COLORS[index % CHART_COLORS.length];
}

function toMillis(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && Number.isFinite(value._seconds)) return value._seconds * 1000 + (value._nanoseconds || 0) / 1e6;
  if (value && Number.isFinite(value.seconds)) return value.seconds * 1000 + (value.nanoseconds || 0) / 1e6;
  return NaN;
}

/** Timestamp of the newest snapshot in a priceHistory array (-Infinity when empty). */
export function historyStamp(history) {
  if (!Array.isArray(history)) return -Infinity;
  return history.reduce((latest, point) => {
    const at = toMillis(point?.at);
    return Number.isFinite(at) && at > latest ? at : latest;
  }, -Infinity);
}

/**
 * Picks the freshest of several priceHistory arrays. Earlier arguments win ties, so pass the
 * just-fetched copy first. A cached (older) response can therefore never replace a newer
 * history we already hold, e.g. the one returned by our own trade.
 */
export function freshestHistory(...candidates) {
  let best = null;
  let bestStamp = -Infinity;
  candidates.forEach((history) => {
    const stamp = historyStamp(history);
    if (Array.isArray(history) && (best === null || stamp > bestStamp)) { best = history; bestStamp = stamp; }
  });
  return best || [];
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

/** Valid snapshots sorted by time, each with exactly `outcomeCount` prices in [0, 1]. */
export function cleanHistory(history, outcomeCount) {
  if (!Array.isArray(history)) return [];
  return history
    .map((point) => ({ at: toMillis(point?.at), prices: point?.prices }))
    .filter((point) => Number.isFinite(point.at) && Array.isArray(point.prices))
    .map((point) => ({ at: point.at, prices: Array.from({ length: outcomeCount }, (_, index) => clamp01(point.prices[index])) }))
    .sort((a, b) => a.at - b.at);
}

/**
 * Step-hold resample: the value at grid time t is the latest snapshot at or before t.
 * The final grid point is pinned to `current` (the live market price) when provided.
 */
export function resampleHistory(snapshots, { start, end, samples, current }) {
  const count = Math.max(2, Math.floor(samples));
  const outcomeCount = current?.length ?? snapshots[0]?.prices.length ?? 0;
  const times = Array.from({ length: count }, (_, index) => start + ((end - start) * index) / (count - 1));
  const series = Array.from({ length: outcomeCount }, () => new Array(count));
  let cursor = 0;
  times.forEach((time, index) => {
    while (cursor + 1 < snapshots.length && snapshots[cursor + 1].at <= time) cursor += 1;
    const source = index === count - 1 && current ? current : snapshots[cursor]?.prices || current || [];
    for (let outcome = 0; outcome < outcomeCount; outcome += 1) series[outcome][index] = clamp01(source[outcome]);
  });
  return { times, series };
}

/**
 * Monotone cubic interpolation (Fritsch–Carlson / Steffen style, same as d3.curveMonotoneX).
 * Points must have strictly increasing x. Returns an SVG path "d" string.
 */
export function monotonePath(points) {
  const n = points.length;
  if (n === 0) return '';
  const f = (value) => value.toFixed(2);
  if (n === 1) return `M${f(points[0].x)},${f(points[0].y)}`;
  if (n === 2) return `M${f(points[0].x)},${f(points[0].y)}L${f(points[1].x)},${f(points[1].y)}`;

  const h = [];
  const secant = [];
  for (let i = 0; i < n - 1; i += 1) {
    h[i] = points[i + 1].x - points[i].x;
    secant[i] = h[i] === 0 ? 0 : (points[i + 1].y - points[i].y) / h[i];
  }
  const tangent = new Array(n);
  for (let i = 1; i < n - 1; i += 1) {
    const s0 = secant[i - 1];
    const s1 = secant[i];
    if (s0 * s1 <= 0) { tangent[i] = 0; continue; }
    const p = (s0 * h[i] + s1 * h[i - 1]) / (h[i - 1] + h[i]);
    tangent[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p));
  }
  tangent[0] = (3 * secant[0] - tangent[1]) / 2;
  tangent[n - 1] = (3 * secant[n - 2] - tangent[n - 2]) / 2;
  // Endpoint tangents must not push the curve past its neighbour either.
  if (Math.sign(tangent[0]) !== Math.sign(secant[0])) tangent[0] = 0;
  else if (Math.abs(tangent[0]) > 3 * Math.abs(secant[0])) tangent[0] = 3 * secant[0];
  if (Math.sign(tangent[n - 1]) !== Math.sign(secant[n - 2])) tangent[n - 1] = 0;
  else if (Math.abs(tangent[n - 1]) > 3 * Math.abs(secant[n - 2])) tangent[n - 1] = 3 * secant[n - 2];

  let d = `M${f(points[0].x)},${f(points[0].y)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const dx = h[i] / 3;
    d += `C${f(points[i].x + dx)},${f(points[i].y + dx * tangent[i])},${f(points[i + 1].x - dx)},${f(points[i + 1].y - dx * tangent[i + 1])},${f(points[i + 1].x)},${f(points[i + 1].y)}`;
  }
  return d;
}

/** Spreads label y positions so that no two are closer than `gap`, staying within [top, bottom]. */
export function spreadLabels(items, gap, top, bottom) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  sorted.forEach((item, index) => {
    item.labelY = Math.max(item.y, index ? sorted[index - 1].labelY + gap : top);
  });
  const overflow = sorted.length ? sorted[sorted.length - 1].labelY - bottom : 0;
  if (overflow > 0) {
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const limit = index === sorted.length - 1 ? bottom : sorted[index + 1].labelY - gap;
      sorted[index].labelY = Math.min(sorted[index].labelY, limit);
    }
  }
  return sorted;
}

function svgNode(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

function percent(value) {
  const pct = value * 100;
  if (pct > 0 && pct < 1) return '<1%';
  if (pct < 100 && pct > 99) return '>99%';
  return `${Math.round(pct)}%`;
}

function timeFormatter(span) {
  if (span > 6 * 86400e3) return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  if (span > 6 * 3600e3) return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
}

const tooltipTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

let activeObserver = null;

/**
 * Builds the price chart section. `history` is the raw priceHistory array, `current` the live
 * probabilities (0–1) for each outcome, `now` the right edge of the time axis.
 */
export function renderPriceChart({ market, history, current, now = Date.now() }) {
  const outcomes = market.outcomes;
  const section = document.createElement('section');
  section.className = 'price-chart-section';

  const heading = document.createElement('div');
  heading.className = 'price-chart-heading';
  const title = document.createElement('h3');
  title.textContent = 'Price history';
  const note = document.createElement('span');
  note.textContent = 'Chance, by time';
  heading.append(title, note);

  const frame = document.createElement('div');
  frame.className = 'price-chart-frame';
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  frame.append(tooltip);

  const snapshots = cleanHistory(history, outcomes.length);
  const createdAt = toMillis(market.createdAt);
  // Start at the oldest snapshot we actually have. History is capped server-side, so for older
  // markets this is later than createdAt; extending the line back would invent prices.
  let start = snapshots.length ? snapshots[0].at : Number.isFinite(createdAt) ? createdAt : now;
  const end = Math.max(now, snapshots.length ? snapshots[snapshots.length - 1].at : now);
  if (end - start < 60e3) start = end - 3600e3;
  if (!snapshots.length) snapshots.push({ at: start, prices: current.map(clamp01) });

  const order = outcomes.map((_, index) => index).sort((a, b) => (current[b] || 0) - (current[a] || 0));

  function draw(width) {
    const compact = width < 560;
    const height = compact ? 220 : 280;
    const labelCount = compact ? 3 : 5;
    const margin = { top: 12, right: compact ? 44 : 150, bottom: 26, left: 36 };
    const plotWidth = Math.max(40, width - margin.left - margin.right);
    const plotHeight = height - margin.top - margin.bottom;
    const samples = Math.max(24, Math.min(240, Math.round(plotWidth / 3)));
    const { times, series } = resampleHistory(snapshots, { start, end, samples, current });
    const xAt = (index) => margin.left + (plotWidth * index) / (times.length - 1);
    const yFor = (price) => margin.top + plotHeight * (1 - price);

    const svg = svgNode('svg', {
      class: 'price-chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img',
      'aria-label': `Price history for ${market.question}. Current: ${order.slice(0, 4).map((index) => `${outcomes[index].label} ${percent(current[index] || 0)}`).join(', ')}.`,
    });

    [0, 0.25, 0.5, 0.75, 1].forEach((level) => {
      const y = yFor(level);
      svg.append(svgNode('line', { class: 'chart-grid-line', x1: margin.left, x2: margin.left + plotWidth, y1: y, y2: y }));
      const label = svgNode('text', { class: 'chart-axis-label', x: margin.left - 8, y: y + 4, 'text-anchor': 'end' });
      label.textContent = `${level * 100}%`;
      svg.append(label);
    });

    const format = timeFormatter(end - start);
    const tickCount = compact ? 3 : 5;
    for (let tick = 0; tick < tickCount; tick += 1) {
      const fraction = tick / (tickCount - 1);
      const label = svgNode('text', {
        class: 'chart-axis-label', x: margin.left + plotWidth * fraction, y: height - 6,
        'text-anchor': tick === 0 ? 'start' : tick === tickCount - 1 ? 'end' : 'middle',
      });
      label.textContent = tick === tickCount - 1 ? 'Now' : format.format(new Date(start + (end - start) * fraction));
      svg.append(label);
    }

    // Draw the leaders last so they sit on top.
    [...order].reverse().forEach((outcomeIndex) => {
      const points = series[outcomeIndex].map((price, index) => ({ x: xAt(index), y: yFor(price) }));
      svg.append(svgNode('path', {
        class: 'chart-series', d: monotonePath(points), stroke: seriesColor(outcomeIndex),
        'data-outcome-index': outcomeIndex,
      }));
    });

    const lastX = xAt(times.length - 1);
    const endItems = order.map((outcomeIndex) => ({ outcomeIndex, y: yFor(series[outcomeIndex][times.length - 1]) }));
    endItems.forEach(({ outcomeIndex, y }) => {
      svg.append(svgNode('circle', { class: 'chart-end-dot', cx: lastX, cy: y, r: 3, fill: seriesColor(outcomeIndex) }));
    });
    spreadLabels(endItems.slice(0, labelCount), 15, margin.top + 4, margin.top + plotHeight + 4).forEach(({ outcomeIndex, labelY }) => {
      const label = svgNode('text', { class: 'chart-end-label', x: lastX + 8, y: labelY + 4, fill: seriesColor(outcomeIndex) });
      const name = outcomes[outcomeIndex].label;
      const short = name.length > 13 ? `${name.slice(0, 12)}…` : name;
      label.textContent = compact ? percent(current[outcomeIndex] || 0) : `${short} ${percent(current[outcomeIndex] || 0)}`;
      svg.append(label);
    });

    const crosshair = svgNode('line', { class: 'chart-crosshair', y1: margin.top, y2: margin.top + plotHeight, visibility: 'hidden' });
    svg.append(crosshair);
    const hoverDots = outcomes.map((_, index) => {
      const dot = svgNode('circle', { class: 'chart-hover-dot', r: 3.5, fill: '#fff', stroke: seriesColor(index), visibility: 'hidden' });
      svg.append(dot);
      return dot;
    });
    const hitArea = svgNode('rect', { class: 'chart-hit-area', x: margin.left, y: 0, width: plotWidth, height, fill: 'transparent' });
    svg.append(hitArea);

    function hide() {
      crosshair.setAttribute('visibility', 'hidden');
      hoverDots.forEach((dot) => dot.setAttribute('visibility', 'hidden'));
      tooltip.hidden = true;
    }
    function show(event) {
      const box = svg.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * width;
      const index = Math.max(0, Math.min(times.length - 1, Math.round(((x - margin.left) / plotWidth) * (times.length - 1))));
      const cx = xAt(index);
      crosshair.setAttribute('x1', cx);
      crosshair.setAttribute('x2', cx);
      crosshair.setAttribute('visibility', 'visible');
      hoverDots.forEach((dot, outcomeIndex) => {
        dot.setAttribute('cx', cx);
        dot.setAttribute('cy', yFor(series[outcomeIndex][index]));
        dot.setAttribute('visibility', 'visible');
      });
      const rows = outcomes.map((outcome, outcomeIndex) => ({ outcome, outcomeIndex, price: series[outcomeIndex][index] }))
        .sort((a, b) => b.price - a.price);
      const time = document.createElement('div');
      time.className = 'chart-tooltip-time';
      time.textContent = index === times.length - 1 ? 'Now' : tooltipTime.format(new Date(times[index]));
      const list = document.createElement('ul');
      rows.slice(0, 8).forEach(({ outcome, outcomeIndex, price }) => {
        const item = document.createElement('li');
        const swatch = document.createElement('i');
        swatch.style.backgroundColor = seriesColor(outcomeIndex);
        const name = document.createElement('span');
        name.textContent = outcome.label;
        const value = document.createElement('strong');
        value.textContent = percent(price);
        item.append(swatch, name, value);
        list.append(item);
      });
      if (rows.length > 8) {
        const more = document.createElement('li');
        more.className = 'chart-tooltip-more';
        more.textContent = `+${rows.length - 8} more`;
        list.append(more);
      }
      tooltip.replaceChildren(time, list);
      tooltip.hidden = false;
      const left = (cx / width) * box.width;
      const tipWidth = tooltip.offsetWidth;
      tooltip.style.left = `${left + 14 + tipWidth > box.width ? Math.max(0, left - 14 - tipWidth) : left + 14}px`;
      tooltip.style.top = `${margin.top}px`;
    }
    hitArea.addEventListener('pointermove', show);
    hitArea.addEventListener('pointerdown', show);
    hitArea.addEventListener('pointerleave', hide);

    frame.querySelector('svg')?.remove();
    frame.prepend(svg);
    hide();
  }

  const legend = document.createElement('div');
  legend.className = 'price-chart-legend';
  order.forEach((index) => {
    const item = document.createElement('span');
    item.className = 'chart-legend-item';
    const swatch = document.createElement('i');
    swatch.className = 'chart-legend-dot';
    swatch.style.backgroundColor = seriesColor(index);
    const name = document.createElement('span');
    name.className = 'chart-legend-name';
    name.textContent = outcomes[index].label;
    const price = document.createElement('strong');
    price.textContent = percent(current[index] || 0);
    item.append(swatch, name, price);
    legend.append(item);
  });

  section.append(heading, frame, legend);

  let lastWidth = 0;
  activeObserver?.disconnect();
  const observer = new ResizeObserver((entries) => {
    if (!frame.isConnected) { observer.disconnect(); return; }
    const width = Math.floor(entries[0].contentRect.width);
    if (width > 0 && width !== lastWidth) {
      lastWidth = width;
      draw(width);
    }
  });
  observer.observe(frame);
  activeObserver = observer;
  return section;
}
