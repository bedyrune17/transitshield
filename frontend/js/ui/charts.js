// Small, dependency-free SVG charts.
import { h } from './dom.js';
import { RISK_HEX } from './components.js';

/** Horizontal distribution bars for risk levels. */
export function riskDistribution(dist) {
  const order = ['HIGH', 'MEDIUM', 'LOW', 'NONE'];
  const total = order.reduce((n, k) => n + (dist[k] || 0), 0);
  const labels = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', NONE: 'None' };
  return h('div', { role: 'img', 'aria-label': 'Risk level distribution: ' + order.map((k) => labels[k] + ' ' + (dist[k] || 0)).join(', ') },
    order.map((k) => {
      const n = dist[k] || 0;
      const fill = h('div', { class: 'bar-fill' });
      fill.style.width = total ? (n / total) * 100 + '%' : '0%';
      fill.style.background = RISK_HEX[k];
      return h('div', { class: 'dist-row' }, h('span', null, labels[k]), h('div', { class: 'bar-track' }, fill),
        h('span', { class: 'num' }, String(n)));
    }));
}

/** Column chart of event counts per time bucket, stacked by category. */
export function activityTimeline(events, { buckets = 12, categories }) {
  const W = 640;
  const H = 180;
  const pad = { l: 28, r: 8, t: 10, b: 26 };
  const times = events.map((e) => Date.parse(e.timestamp)).filter((t) => !Number.isNaN(t));
  if (!times.length) return h('p', { class: 'muted small' }, 'No activity recorded yet.');
  const end = Math.max(...times, Date.now());
  const span = Math.max(end - Math.min(...times), 60 * 60 * 1000);
  const size = Math.ceil(span / buckets);
  const start = end - size * buckets;
  const counts = Array.from({ length: buckets }, () => ({}));
  for (const e of events) {
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t) || t < start) continue;
    const i = Math.min(buckets - 1, Math.floor((t - start) / size));
    const cat = categories.find((c) => c.match(e)) || categories[categories.length - 1];
    counts[i][cat.key] = (counts[i][cat.key] || 0) + 1;
  }
  const max = Math.max(1, ...counts.map((c) => Object.values(c).reduce((a, b) => a + b, 0)));
  const bw = (W - pad.l - pad.r) / buckets;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const bars = [];
  counts.forEach((c, i) => {
    let acc = 0;
    for (const cat of categories) {
      const v = c[cat.key] || 0;
      if (!v) continue;
      const y0 = y(acc);
      const y1 = y(acc + v);
      bars.push(h('rect', { x: pad.l + i * bw + 3, y: y1, width: Math.max(2, bw - 6), height: Math.max(1, y0 - y1), fill: cat.color, rx: 2 },
        h('title', null, cat.label + ': ' + v)));
      acc += v;
    }
  });
  const fmt = (t) => {
    const d = new Date(t);
    return span > 2 * 86400000 ? d.toISOString().slice(5, 10) : d.toISOString().slice(11, 16);
  };
  return h('div', null,
    h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Recent activity over time' },
      h('line', { class: 'axis', x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b }),
      h('text', { x: 4, y: pad.t + 8 }, String(max)),
      h('text', { x: 4, y: H - pad.b }, '0'),
      bars,
      [0, Math.floor(buckets / 2), buckets - 1].map((i) => h('text', { x: pad.l + i * bw + 2, y: H - 8 }, fmt(start + i * size)))),
    h('div', { class: 'legend mt-8' }, h('span', { class: 'muted' }, 'Times in UTC ·'), categories.map((c) => {
      const sw = h('span', { class: 'sw' });
      sw.style.background = c.color;
      return h('span', null, sw, c.label);
    })));
}

export function confusionMatrix(ev) {
  return h('div', { class: 'matrix', role: 'table', 'aria-label': 'Confusion matrix' },
    h('div'), h('div', { class: 'head' }, 'Planted anomaly'), h('div', { class: 'head' }, 'Not planted'),
    h('div', { class: 'head' }, 'Flagged'),
    h('div', { class: 'cell tp' }, h('b', null, String(ev.truePositives)), 'True positives'),
    h('div', { class: 'cell fp' }, h('b', null, String(ev.falsePositives)), 'False positives'),
    h('div', { class: 'head' }, 'Not flagged'),
    h('div', { class: 'cell fn' }, h('b', null, String(ev.falseNegatives)), 'False negatives'),
    h('div', { class: 'cell tn' }, h('b', null, String(ev.trueNegatives)), 'True negatives'));
}
