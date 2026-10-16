import { h, mount } from '../ui/dom.js';
import {
  pageHead, card, button, dataTable, riskBadge, processingBadge, caseBadge, scoreCell, select, field, emptyState,
  toast, toastError, fmtDate, badge, sourceTag,
} from '../ui/components.js';
import { openRecordDrawer, typeLabel } from './recordDetail.js';

const filters = { q: '', level: '', proc: '', inv: '', type: '', from: '', to: '', rule: '', entity: '', flagged: false };

function matches(r, caseByRecord) {
  const q = filters.q.trim().toLowerCase();
  if (q) {
    const hay = [r.recordId, ...Object.values(r.fields || {}).map((v) => (Array.isArray(v) ? v.join(' ') : String(v)))].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (filters.level === 'UNSCORED' ? r.riskLevel : filters.level && r.riskLevel !== filters.level) return false;
  if (filters.proc && r.processingStatus !== filters.proc) return false;
  if (filters.type && r.recordType !== filters.type) return false;
  if (filters.rule && !(r.triggeredRules || []).includes(filters.rule)) return false;
  if (filters.flagged && !r.flagged) return false;
  if (filters.entity) {
    const e = filters.entity.trim().toUpperCase();
    if (!(r.linkedEntityIds || []).some((x) => x.toUpperCase() === e) && r.recordId !== e) return false;
  }
  const day = (r.createdAt || '').slice(0, 10);
  if (filters.from && day < filters.from) return false;
  if (filters.to && day > filters.to) return false;
  if (filters.inv) {
    const c = caseByRecord.get(r.recordId);
    if (filters.inv === 'NONE' ? c : !c || c.caseStatus !== filters.inv) return false;
  }
  return true;
}

export async function render(app, main, ctx) {
  const ds = app.currentDataset();
  if (!ds) {
    mount(main, pageHead('Records'), card(null, emptyState('No dataset', 'Generate a synthetic dataset first.',
      [button('Generate dataset', () => app.navigate('#/settings'), { kind: 'primary' })])));
    return;
  }
  for (const k of ['rule', 'entity', 'level']) if (ctx.query.get(k)) filters[k] = ctx.query.get(k);
  if (ctx.query.get('flagged')) filters.flagged = true;

  let records = [];
  let caseByRecord = new Map();
  let selection = [];

  const table = dataTable([
    { key: 'recordId', label: 'Record', render: (r) => h('code', null, r.recordId) },
    { key: 'recordType', label: 'Type', render: (r) => typeLabel(r.recordType) },
    { key: 'ref', label: 'Document ref.', sort: (r) => refOf(r), render: (r) => h('span', { class: 'mono small' }, refOf(r) || '—') },
    { key: 'createdAt', label: 'Record date', render: (r) => h('span', { class: 'nowrap' }, fmtDate(r.createdAt).slice(0, 10)) },
    { key: 'processingStatus', label: 'Processing', render: (r) => processingBadge(r.processingStatus) },
    { key: 'riskScore', label: 'Score', num: true, render: (r) => scoreCell(r.riskScore, r.riskLevel) },
    { key: 'riskLevel', label: 'Risk', sort: (r) => ['NONE', 'LOW', 'MEDIUM', 'HIGH'].indexOf(r.riskLevel), render: (r) => riskBadge(r.riskLevel) },
    { key: 'triggeredRules', label: 'Rules', sortable: false, render: (r) => (r.triggeredRules && r.triggeredRules.length ? h('span', { class: 'mono small' }, r.triggeredRules.join(' ')) : h('span', { class: 'muted' }, '—')) },
    { key: 'case', label: 'Case', sort: (r) => (caseByRecord.get(r.recordId) || {}).caseStatus || '', render: (r) => (caseByRecord.get(r.recordId) ? caseBadge(caseByRecord.get(r.recordId).caseStatus) : h('span', { class: 'muted' }, '—')) },
  ], {
    pageSize: 25,
    onRowClick: (r) => openRecordDrawer(app, ds.datasetId, r.recordId, { onChanged: () => load() }),
    initialSort: { key: 'riskScore', dir: 'desc' },
    emptyText: 'No records match these filters',
    selectable: true,
    getId: (r) => r.recordId,
    onSelect: (ids) => { selection = ids; updateBulk(); },
  });

  const bulk = h('div', { class: 'row' });
  function updateBulk() {
    mount(bulk,
      button(selection.length ? `Process ${selection.length} selected` : 'Process selected', async () => {
        try {
          const job = await app.provider.submitJob({ datasetId: ds.datasetId, recordIds: selection });
          toast('Job accepted (not yet completed)', job.jobId + ' queued for ' + selection.length + ' record(s).', 'good');
          table.clearSelection();
          load();
        } catch (err) { toastError(err, 'Could not submit job'); }
      }, { iconName: 'play', disabled: !selection.length || !app.can('analyst') }),
      button('Process entire dataset', async () => {
        try {
          const job = await app.provider.submitJob({ datasetId: ds.datasetId });
          toast('Job accepted (not yet completed)', job.jobId + ' queued for the whole dataset.', 'good');
          load();
        } catch (err) { toastError(err, 'Could not submit job'); }
      }, { kind: 'primary', iconName: 'play', disabled: !app.can('analyst') }));
  }

  const countLabel = h('span', { class: 'muted small' });
  function apply() {
    const rows = records.filter((r) => matches(r, caseByRecord));
    countLabel.textContent = rows.length + ' of ' + records.length + ' records';
    table.update(rows, { resetPage: true });
  }
  const set = (k) => (v) => { filters[k] = v; apply(); };
  const ruleOptions = [['', 'Any rule'], ...app.rules.rules.map((r) => [r.id, r.id + ' · ' + r.title])];
  const input = (k, attrs) => h('input', { class: 'input', value: filters[k], oninput: (e) => set(k)(e.target.value), ...attrs });

  const toolbar = h('div', { class: 'toolbar', role: 'search' },
    h('div', { class: 'field wide' }, h('label', { for: 'f-q' }, 'Search'), input('q', { id: 'f-q', type: 'search', placeholder: 'ID, reference, company…' })),
    field('Risk level', select([['', 'Any'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low'], ['NONE', 'None'], ['UNSCORED', 'Not scored']], filters.level, set('level'))),
    field('Processing', select([['', 'Any'], ['UNPROCESSED', 'Unprocessed'], ['QUEUED', 'Queued'], ['PROCESSING', 'Processing'], ['PROCESSED', 'Processed']], filters.proc, set('proc'))),
    field('Investigation', select([['', 'Any'], ['NONE', 'No case'], ['NEW', 'New'], ['UNDER_REVIEW', 'Under review'], ['ESCALATED', 'Escalated'], ['DISMISSED', 'Dismissed'], ['RESOLVED', 'Resolved']], filters.inv, set('inv'))),
    field('Record type', select([['', 'Any'], ['MANIFEST', 'Cargo manifest'], ['SHIPMENT', 'Shipment'], ['INVOICE', 'Invoice'], ['TRANSACTION', 'Transaction']], filters.type, set('type'))),
    h('div', { class: 'field wide' }, h('label', { for: 'f-rule' }, 'Applied rule'), select(ruleOptions, filters.rule, set('rule'), { id: 'f-rule' })),
    field('Entity / linked ID', input('entity', { placeholder: 'CO-004, INV-0012…' })),
    field('From (record date)', input('from', { type: 'date' })),
    field('To', input('to', { type: 'date' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: filters.flagged, onchange: (e) => set('flagged')(e.target.checked) }), 'Flagged only'),
    button('Clear filters', () => { Object.assign(filters, { q: '', level: '', proc: '', inv: '', type: '', from: '', to: '', rule: '', entity: '', flagged: false }); app.navigate('#/records'); }, { kind: 'ghost', sm: true }));

  async function load() {
    try {
      const [recs, cases] = await Promise.all([app.provider.listRecords(ds.datasetId), app.provider.listCases(ds.datasetId)]);
      if (!ctx.isCurrent()) return;
      records = recs;
      caseByRecord = new Map(cases.map((c) => [c.recordId, c]));
      apply();
      if (recs.some((r) => r.processingStatus === 'QUEUED' || r.processingStatus === 'PROCESSING')) schedule();
    } catch (err) {
      toastError(err, 'Could not load records');
    }
  }
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (ctx.isCurrent()) load(); }, 3000);
  }
  app.onLeave(() => clearTimeout(timer));

  updateBulk();
  mount(main,
    pageHead('Records', 'Search and filter every synthetic record. Click a row for the source fields, score explanation, evidence and processing history.',
      [sourceTag(app.mode === 'aws' ? 'app' : 'sim'), button('Refresh', () => load(), { kind: 'ghost', iconName: 'refresh' })]),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, ds.scenarioLabel, h('span', { class: 'sub' }, 'seed ' + ds.seed)), h('div', { class: 'row' }, countLabel, bulk)),
      toolbar, table.el),
    h('p', { class: 'small muted mt-8' }, badge('Tip', 'outline'), ' Accepting a job (202) is not the same as completing it: rows show Queued → Processing → Processed as the worker runs.'));
  table.setCaption('Synthetic records in dataset ' + ds.datasetId);
  await load();
}

function refOf(r) {
  const f = r.fields || {};
  return f.manifestNo || f.awbNumber || f.invoiceNo || f.txnRef || '';
}
