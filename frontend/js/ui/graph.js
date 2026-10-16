// Relationship graph model + deterministic force layout + SVG rendering.
import { h } from './dom.js';

export const NODE_STYLE = {
  MANIFEST: { color: '#6ea8fe', letter: 'M', label: 'Cargo manifest' },
  SHIPMENT: { color: '#44b97a', letter: 'S', label: 'Shipment' },
  INVOICE: { color: '#e2a336', letter: 'I', label: 'Invoice' },
  TRANSACTION: { color: '#a48cf2', letter: 'T', label: 'Transaction' },
  COMPANY: { color: '#8494a5', letter: 'C', label: 'Company (fictional)' },
  CARRIER: { color: '#5fb3c4', letter: 'A', label: 'Carrier (fictional)' },
  MISSING: { color: '#33465a', letter: '?', label: 'Referenced but not in dataset' },
};

const FIELD_REASON = {
  shipmentIds: 'manifest lists this shipment',
  carrierId: 'manifest operated by carrier',
  manifestId: 'shipment carried on manifest',
  invoiceId: { SHIPMENT: "shipment's invoice", TRANSACTION: 'payment for invoice' },
  consignorId: 'shipment consignor',
  consigneeId: 'shipment consignee',
  shipmentId: 'invoice issued for shipment',
  sellerId: 'invoice seller',
  buyerId: 'invoice buyer',
  payerId: 'payment payer',
  payeeId: 'payment payee',
};

/** Builds nodes/edges from records + entity list. Every edge cites the field or rule evidence behind it. */
export function buildGraph(records, entities) {
  const nodes = new Map();
  const edges = new Map();
  for (const r of records) {
    nodes.set(r.recordId, { id: r.recordId, kind: r.recordType, record: r, flagged: Boolean(r.flagged), level: r.riskLevel });
  }
  for (const e of entities || []) nodes.set(e.entityId, { id: e.entityId, kind: e.kind, name: e.name });
  const addEdge = (a, b, reason, derived) => {
    if (!a || !b || a === b) return;
    if (!nodes.has(b)) nodes.set(b, { id: b, kind: 'MISSING' });
    const key = (a < b ? a + '|' + b : b + '|' + a) + (derived ? '|d' : '');
    if (!edges.has(key)) edges.set(key, { a, b, derived, reasons: [] });
    const ed = edges.get(key);
    if (!ed.reasons.includes(reason)) ed.reasons.push(reason);
  };
  for (const r of records) {
    const f = r.fields || {};
    for (const [field, why] of Object.entries(FIELD_REASON)) {
      const reason = typeof why === 'string' ? why : why[r.recordType];
      if (!reason) continue;
      const v = f[field];
      const targets = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : [];
      for (const t of targets) addEdge(r.recordId, t, `${r.recordId}.${field} = ${t} (${reason})`, false);
    }
    for (const fd of r.findings || []) {
      if (fd.ruleId !== 'R02' && fd.ruleId !== 'R07') continue;
      for (const ev of fd.evidence) {
        for (const other of ev.relatedRecordIds || []) {
          const what = fd.ruleId === 'R02' ? `same ${ev.field} "${ev.value}"` : `both claim invoice ${ev.value}`;
          addEdge(r.recordId, other, `${what} — evidence for ${fd.ruleId} ${fd.title}`, true);
        }
      }
    }
  }
  const adj = new Map();
  for (const ed of edges.values()) {
    for (const [x, y] of [[ed.a, ed.b], [ed.b, ed.a]]) {
      if (!adj.has(x)) adj.set(x, []);
      adj.get(x).push({ other: y, edge: ed });
    }
  }
  return { nodes, edges: [...edges.values()], adj };
}

/** Neighbourhood of `focus` up to `depth` hops. Entity hubs are leaves unless expandEntities. */
export function neighbourhood(graph, focus, depth, expandEntities) {
  const seen = new Map([[focus, 0]]);
  const queue = [focus];
  while (queue.length) {
    const cur = queue.shift();
    const d = seen.get(cur);
    if (d >= depth) continue;
    const node = graph.nodes.get(cur);
    const isHub = node && (node.kind === 'COMPANY' || node.kind === 'CARRIER');
    if (isHub && cur !== focus && !expandEntities) continue;
    for (const { other } of graph.adj.get(cur) || []) {
      if (!seen.has(other)) {
        seen.set(other, d + 1);
        queue.push(other);
      }
    }
  }
  const ids = new Set(seen.keys());
  return { ids, edges: graph.edges.filter((e) => ids.has(e.a) && ids.has(e.b)), depthOf: seen };
}

function hash(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619) >>> 0;
  return x;
}

/** Deterministic force-directed layout (same input -> same picture). */
export function layout(ids, edges, focus) {
  const list = [...ids];
  const pos = new Map();
  list.forEach((id) => {
    const a = (hash(id) % 6283) / 1000;
    const r = id === focus ? 0 : 120 + (hash(id + 'r') % 200);
    pos.set(id, { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 });
  });
  const iterations = list.length > 120 ? 160 : 260;
  for (let it = 0; it < iterations; it++) {
    const t = 1 - it / iterations;
    for (let i = 0; i < list.length; i++) {
      const p = pos.get(list[i]);
      for (let j = i + 1; j < list.length; j++) {
        const q = pos.get(list[j]);
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = 1; dy = 0; d2 = 1; }
        const f = 2600 / d2;
        const d = Math.sqrt(d2);
        p.vx += (dx / d) * f; p.vy += (dy / d) * f;
        q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
      }
    }
    for (const e of edges) {
      const p = pos.get(e.a);
      const q = pos.get(e.b);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 90) * 0.04;
      p.vx += (dx / d) * f; p.vy += (dy / d) * f;
      q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
    }
    for (const id of list) {
      const p = pos.get(id);
      p.vx -= p.x * 0.01;
      p.vy -= p.y * 0.01;
      const max = 30 * t + 1;
      p.x += Math.max(-max, Math.min(max, p.vx * 0.5));
      p.y += Math.max(-max, Math.min(max, p.vy * 0.5));
      p.vx *= 0.5;
      p.vy *= 0.5;
      if (id === focus) { p.x *= 0.8; p.y *= 0.8; }
    }
  }
  return pos;
}

export function renderGraph(graph, view, pos, { selected, highlightFlagged, onSelect }) {
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const minX = Math.min(...xs) - 60;
  const minY = Math.min(...ys) - 50;
  const w = Math.max(300, Math.max(...xs) - minX + 60);
  const hgt = Math.max(240, Math.max(...ys) - minY + 50);
  const connected = new Set();
  if (selected) (graph.adj.get(selected) || []).forEach(({ other }) => connected.add(other));

  const edgeEls = view.edges.map((e) => {
    const p = pos.get(e.a);
    const q = pos.get(e.b);
    const active = selected && (e.a === selected || e.b === selected);
    return h('line', { class: ['edge', e.derived && 'derived', active && 'active'], x1: p.x, y1: p.y, x2: q.x, y2: q.y },
      h('title', null, e.reasons.join('\n')));
  });
  const nodeEls = [...view.ids].map((id) => {
    const n = graph.nodes.get(id);
    const st = NODE_STYLE[n.kind] || NODE_STYLE.MISSING;
    const p = pos.get(id);
    const isEntity = n.kind === 'COMPANY' || n.kind === 'CARRIER';
    const r = isEntity ? 11 : 13;
    const shape = isEntity
      ? h('rect', { class: 'shape', x: -r, y: -r, width: r * 2, height: r * 2, rx: 3, fill: st.color })
      : h('circle', { class: 'shape', r, fill: st.color, 'stroke-dasharray': n.kind === 'MISSING' ? '3 3' : null, stroke: n.kind === 'MISSING' ? '#8494a5' : null });
    const dim = selected && id !== selected && !connected.has(id);
    const label = n.kind === 'MISSING' ? id + ' (missing)' : id;
    return h('g', {
      class: ['node', id === selected && 'selected', dim && 'dim'],
      transform: `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`,
      tabindex: '0', role: 'button',
      'aria-label': `${st.label} ${id}${n.flagged ? ', flagged' : ''}`,
      onclick: () => onSelect(id),
      onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(id); } },
    },
    highlightFlagged && n.flagged ? h('circle', { class: 'ring', r: r + 5 }) : null,
    shape,
    h('text', { 'text-anchor': 'middle', y: 4, fill: '#0d131a', 'font-weight': '700' }, st.letter),
    h('text', { 'text-anchor': 'middle', y: r + 14 }, label),
    h('title', null, `${st.label}: ${id}${n.name ? ' — ' + n.name : ''}${n.level ? ' — risk ' + n.level : ''}`));
  });
  return h('svg', { class: 'graph-svg', viewBox: `${minX} ${minY} ${w} ${hgt}`, role: 'group', 'aria-label': 'Relationship graph' },
    h('g', null, edgeEls), h('g', null, nodeEls));
}
