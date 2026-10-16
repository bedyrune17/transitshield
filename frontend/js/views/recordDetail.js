// Record detail drawer (shared by Records, Relationships, Investigations, Evaluation).
import { h } from '../ui/dom.js';
import {
  openDrawer, closeDrawer, loading, errorState, riskBadge, processingBadge, caseBadge, badge, button, card, callout,
  fmtDate, fmtAmount, chip, toast, toastError, RISK_MEANING, RISK_HEX,
} from '../ui/components.js';
import { icon } from '../ui/icons.js';

const TYPE_LABEL = { MANIFEST: 'Cargo manifest', SHIPMENT: 'Shipment', INVOICE: 'Invoice', TRANSACTION: 'Financial transaction' };
export const typeLabel = (t) => TYPE_LABEL[t] || t;

const FIELD_ORDER = {
  MANIFEST: ['manifestNo', 'flightRef', 'carrierId', 'originAirport', 'destinationAirport', 'departureAt', 'arrivalAt', 'shipmentIds'],
  SHIPMENT: ['awbNumber', 'manifestId', 'consignorId', 'consigneeId', 'commodity', 'pieces', 'weightKg', 'declaredValueMinor', 'currency', 'invoiceId'],
  INVOICE: ['invoiceNo', 'shipmentId', 'sellerId', 'buyerId', 'amountMinor', 'currency', 'issuedAt'],
  TRANSACTION: ['txnRef', 'invoiceId', 'payerId', 'payeeId', 'amountMinor', 'currency', 'valueDate'],
};

function fieldValue(name, value, fields) {
  if (value === undefined) return h('span', { class: 'badge red' }, 'absent');
  if (value === '') return h('span', { class: 'badge red' }, 'empty');
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (name === 'declaredValueMinor' || name === 'amountMinor') return fmtAmount(value, fields.currency);
  return String(value);
}

function scoreGauge(rec) {
  const ring = h('svg', { viewBox: '0 0 64 64', width: 64, height: 64, 'aria-hidden': 'true' },
    h('circle', { cx: 32, cy: 32, r: 27, fill: 'none', stroke: '#1f2c39', 'stroke-width': 7 }),
    h('circle', { cx: 32, cy: 32, r: 27, fill: 'none', stroke: RISK_HEX[rec.riskLevel] || '#6b7c8f', 'stroke-width': 7,
      'stroke-dasharray': `${(rec.riskScore / 100) * 169.6} 169.6`, transform: 'rotate(-90 32 32)', 'stroke-linecap': 'round' }));
  return h('div', { class: 'gauge' }, ring,
    h('div', null, h('div', { class: 'gauge-num' }, String(rec.riskScore), h('span', { class: 'muted small' }, ' / 100')),
      h('div', { class: 'row mt-8' }, riskBadge(rec.riskLevel), rec.flagged ? badge('Flagged for review', 'amber') : badge('Not flagged', 'slate'))));
}

export function findingsList(findings) {
  if (!findings || !findings.length) return h('p', { class: 'muted' }, 'No rules fired for this record.');
  return h('div', null, findings.map((f) => h('div', { class: 'finding' },
    h('div', { class: 'finding-head' }, h('strong', null, f.ruleId + ' · ' + f.title), badge('+' + f.weight, 'outline')),
    h('ul', null, f.explanations.map((e) => h('li', null, e))))));
}

export async function openRecordDrawer(app, datasetId, recordId, { onChanged } = {}) {
  const drawer = openDrawer('Record ' + recordId, loading());
  async function load() {
    drawer.setBody(loading());
    try {
      const { record, case: kase } = await app.provider.getRecord(datasetId, recordId);
      drawer.setTitle(h('span', null, typeLabel(record.recordType) + ' ', h('code', null, record.recordId)));
      drawer.setBody(body(record, kase));
    } catch (err) {
      drawer.setBody(errorState(err, load));
    }
  }

  function body(rec, kase) {
    const f = rec.fields || {};
    const evidenceFields = new Set((rec.findings || []).flatMap((fd) => fd.evidence.map((e) => e.field)).filter(Boolean));
    const order = FIELD_ORDER[rec.recordType] || Object.keys(f);
    const names = [...order, ...Object.keys(f).filter((k) => !order.includes(k))];
    const scored = rec.riskScore !== undefined && rec.riskScore !== null;

    const actions = h('div', { class: 'row' },
      kase
        ? button('Open case', () => { closeDrawer(); app.navigate('#/investigations/' + encodeURIComponent(kase.caseId)); }, { kind: 'primary', iconName: 'cases' })
        : button('Open investigation case', async () => {
          try {
            const res = await app.provider.openCase(datasetId, rec.recordId);
            toast(res.created ? 'Case opened' : 'Case already exists', res.case.caseId, 'good');
            closeDrawer();
            app.navigate('#/investigations/' + encodeURIComponent(res.case.caseId));
          } catch (err) { toastError(err, 'Could not open case'); }
        }, { kind: 'primary', iconName: 'plus', disabled: !app.can('analyst'), title: app.can('analyst') ? null : 'Requires analyst role' }),
      button('Re-process this record', async () => {
        try {
          const job = await app.provider.submitJob({ datasetId, recordIds: [rec.recordId] });
          toast('Job accepted', job.jobId + ' is queued. Accepted is not completed: watch the Processing Queue.', 'good');
          if (onChanged) onChanged();
          load();
        } catch (err) { toastError(err, 'Could not submit job'); }
      }, { iconName: 'play', disabled: !app.can('analyst'), title: app.can('analyst') ? null : 'Requires analyst role' }),
      button('Show in graph', () => { closeDrawer(); app.navigate('#/relationships?focus=' + encodeURIComponent(rec.recordId)); }, { iconName: 'graph', kind: 'ghost' }));

    const riskCard = scored
      ? card('Risk assessment', h('div', { class: 'stack' },
        scoreGauge(rec),
        h('p', { class: 'small muted' }, RISK_MEANING[rec.riskLevel] || ''),
        h('div', { class: 'breakdown' }, 'Score = ' + ((rec.findings || []).map((x) => x.ruleId + ' (' + x.weight + ')').join(' + ') || '0')
          + (rec.findings && rec.findings.reduce((n, x) => n + x.weight, 0) > 100 ? ' → capped at 100' : '') + ' = ' + rec.riskScore),
        findingsList(rec.findings),
        h('div', { class: 'small muted' }, 'Scoring version ', h('code', null, rec.scoringVersion || '—'), ' · processed ', fmtDate(rec.processedAt), ' · job ', h('code', null, rec.lastJobId || '—'))),
      { sub: 'illustrative demo rules' })
      : card('Risk assessment', h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'This record has not been scored yet. Submit it to the processing queue; the worker computes the score asynchronously.'),
        processingBadge(rec.processingStatus)));

    const fieldsCard = card('Synthetic source record', h('dl', { class: 'kv' },
      ['recordId', 'recordType', 'datasetId', 'groupId', 'source', 'createdAt'].flatMap((k) => [h('dt', null, k), h('dd', null, String(rec[k] ?? '—'))]),
      names.flatMap((name) => [h('dt', null, name), h('dd', { class: evidenceFields.has(name) ? 'evidence' : null, title: evidenceFields.has(name) ? 'Used as evidence by a fired rule' : null },
        fieldValue(name, f[name], f))])),
    { sub: evidenceFields.size ? 'amber = evidence for a fired rule' : 'fictional data' });

    const links = (rec.linkedEntityIds || []);
    const linkCard = card('Linked entities', links.length
      ? h('div', { class: 'row' }, links.map((id) => (/^(MAN|SHP|INV|TXN)-/.test(id)
        ? chip(id, () => openRecordDrawer(app, datasetId, id, { onChanged }), 'Open linked record ' + id)
        : chip(id, () => { closeDrawer(); app.navigate('#/relationships?focus=' + encodeURIComponent(id)); }, 'Show entity ' + id + ' in graph'))))
      : h('p', { class: 'muted' }, 'No outgoing links (possibly missing link fields).'),
    { sub: 'from this record\'s reference fields' });

    const hist = rec.processingHistory || [];
    const histCard = card('Processing history', hist.length
      ? h('ul', { class: 'timeline' }, hist.slice().reverse().map((p) => h('li', { class: 'good' },
        h('div', { class: 't-head' }, h('code', null, p.jobId), h('span', { class: 't-time' }, fmtDate(p.processedAt))),
        h('div', { class: 't-body' }, 'Score ' + p.score + ' (' + p.riskLevel + ') · ' + p.scoringVersion))))
      : h('p', { class: 'muted' }, 'No completed processing runs.'),
    { sub: 'last 10 runs' });

    return h('div', { class: 'stack' },
      h('div', { class: 'row' }, processingBadge(rec.processingStatus), kase ? caseBadge(kase.caseStatus) : badge('No case', 'outline'),
        h('span', { class: 'muted small' }, 'version ' + (rec.version ?? '—'))),
      actions,
      callout([icon('info'), ' A score reflects inconsistencies in fictional records under illustrative rules. It is ', h('strong', null, 'not'), ' evidence that any person or organisation did anything wrong.'], 'info'),
      riskCard, fieldsCard, linkCard, histCard);
  }

  await load();
  return drawer;
}
