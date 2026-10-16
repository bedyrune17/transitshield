import { h, mount } from '../ui/dom.js';
import { pageHead, card, button, select, field, callout, emptyState, riskBadge, chip, badge, sourceTag } from '../ui/components.js';
import { buildGraph, neighbourhood, layout, renderGraph, NODE_STYLE } from '../ui/graph.js';
import { openRecordDrawer, typeLabel } from './recordDetail.js';

const state = { depth: 2, expandEntities: false, highlightFlagged: true };

export async function render(app, main, ctx) {
  const ds = app.currentDataset();
  if (!ds) {
    mount(main, pageHead('Relationship Explorer'), card(null, emptyState('No dataset', 'Generate a synthetic dataset first.')));
    return;
  }
  const [records, meta] = await Promise.all([app.provider.listRecords(ds.datasetId), app.provider.getDataset(ds.datasetId)]);
  if (!ctx.isCurrent()) return;
  const graph = buildGraph(records, meta.entities);

  const requested = ctx.query.get('focus');
  const flagged = records.filter((r) => r.flagged).sort((a, b) => b.riskScore - a.riskScore);
  let focus = requested && graph.nodes.has(requested) ? requested : (flagged[0] || records[0]).recordId;
  let selected = focus;

  const graphBox = h('div', { class: 'graph-wrap' });
  const side = h('div');
  const info = h('span', { class: 'small muted' });
  const searchInput = h('input', { class: 'input', list: 'node-ids', placeholder: 'SHP-0004, CO-007…', value: focus });
  const datalist = h('datalist', { id: 'node-ids' }, [...graph.nodes.keys()].sort().map((id) => h('option', { value: id })));

  function draw() {
    const view = neighbourhood(graph, focus, state.depth, state.expandEntities);
    const pos = layout(view.ids, view.edges, focus);
    mount(graphBox, renderGraph(graph, view, pos, { selected, highlightFlagged: state.highlightFlagged, onSelect: (id) => { selected = id; draw(); } }));
    info.textContent = `${view.ids.size} nodes · ${view.edges.length} links shown (of ${graph.nodes.size} nodes / ${graph.edges.length} links)`;
    drawSide();
  }

  function drawSide() {
    const n = graph.nodes.get(selected);
    if (!n) { mount(side, h('p', { class: 'muted' }, 'Select a node.')); return; }
    const st = NODE_STYLE[n.kind] || NODE_STYLE.MISSING;
    const links = (graph.adj.get(selected) || []).slice().sort((a, b) => Number(b.edge.derived) - Number(a.edge.derived) || a.other.localeCompare(b.other));
    mount(side, card(h('span', null, st.label, ' ', h('code', null, selected)), h('div', { class: 'stack' },
      n.name ? h('div', null, n.name) : null,
      n.kind === 'MISSING' ? callout('This ID is referenced by a record but does not exist in the dataset (a broken link).', 'bad') : null,
      n.record ? h('div', { class: 'row' }, riskBadge(n.record.riskLevel), n.record.riskScore !== undefined && n.record.riskScore !== null ? badge('score ' + n.record.riskScore, 'outline') : null,
        n.flagged ? badge('flagged', 'amber') : null) : null,
      h('div', { class: 'row' },
        n.record ? button('Open record', () => openRecordDrawer(app, ds.datasetId, selected), { sm: true, kind: 'primary', iconName: 'records' }) : null,
        selected !== focus ? button('Focus here', () => { focus = selected; searchInput.value = focus; draw(); }, { sm: true, iconName: 'target' }) : null,
        n.kind === 'COMPANY' || n.kind === 'CARRIER' ? button('Records naming it', () => app.navigate('#/records?entity=' + encodeURIComponent(selected)), { sm: true, kind: 'ghost' }) : null),
      h('h3', null, 'Why it is connected (' + links.length + ')'),
      links.length ? h('ul', { class: 'list-plain' }, links.map(({ other, edge }) => h('li', null,
        h('div', { class: 'row' }, chip(other, () => { selected = other; if (!neighbourhood(graph, focus, state.depth, state.expandEntities).ids.has(other)) focus = other; draw(); }, 'Follow connection to ' + other),
          edge.derived ? badge('derived from rule evidence', 'red') : badge('explicit field reference', 'slate')),
        h('ul', { class: 'small muted' }, edge.reasons.map((r) => h('li', null, r))))))
        : h('p', { class: 'muted' }, 'No connections.'),
      callout('A connection only shows that two synthetic documents reference each other or share a value. It does not, on its own, indicate wrongdoing.', 'info')),
    { sub: n.record ? typeLabel(n.record.recordType) : '' }));
  }

  const legend = h('div', { class: 'legend' },
    Object.entries(NODE_STYLE).map(([, st]) => {
      const sw = h('span', { class: 'sw' });
      sw.style.background = st.color;
      return h('span', null, sw, st.label);
    }),
    h('span', null, h('svg', { width: 26, height: 10, 'aria-hidden': 'true' }, h('line', { x1: 0, y1: 5, x2: 26, y2: 5, stroke: '#3a4f66', 'stroke-width': 2 })), ' explicit field reference'),
    h('span', null, h('svg', { width: 26, height: 10, 'aria-hidden': 'true' }, h('line', { x1: 0, y1: 5, x2: 26, y2: 5, stroke: '#ec5f59', 'stroke-width': 2, 'stroke-dasharray': '5 4' })), ' shared value found by a rule (R02/R07)'),
    h('span', null, h('svg', { width: 14, height: 14, 'aria-hidden': 'true' }, h('circle', { cx: 7, cy: 7, r: 5.5, fill: 'none', stroke: '#ec5f59', 'stroke-width': 2 })), ' flagged record'));

  const controls = h('div', { class: 'toolbar' },
    h('form', { class: 'row', onsubmit: (e) => {
      e.preventDefault();
      const id = searchInput.value.trim().toUpperCase();
      if (graph.nodes.has(id)) { focus = id; selected = id; draw(); searchInput.removeAttribute('aria-invalid'); } else searchInput.setAttribute('aria-invalid', 'true');
    } }, h('div', { class: 'field wide' }, h('label', { for: 'g-search' }, 'Focus on node'), Object.assign(searchInput, { id: 'g-search' })), datalist,
    button('Focus', null, { type: 'submit', sm: true, iconName: 'target' })),
    field('Depth', select([['1', '1 hop'], ['2', '2 hops'], ['3', '3 hops']], String(state.depth), (v) => { state.depth = Number(v); draw(); })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.expandEntities, onchange: (e) => { state.expandEntities = e.target.checked; draw(); } }), 'Expand through companies'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.highlightFlagged, onchange: (e) => { state.highlightFlagged = e.target.checked; draw(); } }), 'Highlight flagged'),
    flagged.length ? field('Jump to flagged', select([['', 'Choose…'], ...flagged.slice(0, 40).map((r) => [r.recordId, r.recordId + ' · ' + r.riskLevel + ' ' + r.riskScore])], '', (v) => { if (v) { focus = v; selected = v; searchInput.value = v; draw(); } })) : null);

  mount(main,
    pageHead('Relationship Explorer', 'How fictional manifests, shipments, invoices, transactions and companies reference one another. Select a node to see each connection and the exact field or rule evidence behind it.',
      [sourceTag(app.mode === 'aws' ? 'app' : 'sim'), info]),
    h('div', { class: 'grid split' },
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, legend), controls, graphBox,
        h('p', { class: 'small muted', style: { padding: '8px 14px' } }, 'Every link is derived from synthetic record data (no hypothetical or illustrative links). Companies are shown as leaves unless "Expand through companies" is on. Keyboard: Tab to a node, Enter to select.')),
      side));
  draw();
}
