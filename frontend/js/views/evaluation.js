import { h, mount } from '../ui/dom.js';
import { pageHead, card, button, kpi, fmtPct, callout, emptyState, chip, badge, sourceTag } from '../ui/components.js';
import { confusionMatrix } from '../ui/charts.js';
import { scoreDataset } from '../core/scoring.js';
import { evaluate } from '../core/evaluation.js';
import { openRecordDrawer } from './recordDetail.js';

export async function render(app, main, ctx) {
  const ds = app.currentDataset();
  if (!ds) {
    mount(main, pageHead('Risk Evaluation'), card(null, emptyState('No dataset', 'Generate a synthetic dataset first.')));
    return;
  }
  const [stored, records, labels, meta] = await Promise.all([
    app.provider.getEvaluation(ds.datasetId),
    app.provider.listRecords(ds.datasetId),
    app.provider.getLabels(ds.datasetId),
    app.provider.getDataset(ds.datasetId),
  ]);
  if (!ctx.isCurrent()) return;

  const open = (rid) => openRecordDrawer(app, ds.datasetId, rid);
  const ids = (list) => (list.length ? h('div', { class: 'row mt-8' }, list.map((r) => chip(r, () => open(r)))) : h('div', { class: 'muted mt-8' }, 'none'));

  // What-if comparison: re-run the SAME deterministic engine in the browser over the same records.
  const inputs = records.map((r) => ({ recordId: r.recordId, recordType: r.recordType, fields: r.fields }));
  const profiles = Object.keys(app.rules.profiles);
  const compare = profiles.map((p) => ({ p, ev: evaluate(scoreDataset(inputs, app.rules, p), labels) }));

  const storedBlock = stored.total
    ? h('div', { class: 'stack' },
      h('div', { class: 'kpis' },
        kpi('Records evaluated', String(stored.total), { hint: stored.unscoredRecords ? stored.unscoredRecords + ' not yet scored (excluded)' : 'all scored' }),
        kpi('True positives', String(stored.truePositives), { tone: 'good' }),
        kpi('False positives', String(stored.falsePositives), { tone: stored.falsePositives ? 'warn' : null }),
        kpi('True negatives', String(stored.trueNegatives)),
        kpi('False negatives', String(stored.falseNegatives), { tone: stored.falseNegatives ? 'bad' : null }),
        kpi('Precision', fmtPct(stored.precision), { hint: 'TP / (TP + FP)' }),
        kpi('Recall', fmtPct(stored.recall), { hint: 'TP / (TP + FN)' }),
        kpi('False-positive rate', fmtPct(stored.falsePositiveRate), { hint: 'FP / (FP + TN)' })),
      h('div', { class: 'grid cols-2' },
        confusionMatrix(stored),
        h('div', { class: 'stack' },
          h('div', null, h('strong', null, 'Missed planted records (FN)'), ids(stored.falseNegativeIds)),
          h('div', null, h('strong', null, 'Flagged but not planted (FP)'), ids(stored.falsePositiveIds)),
          h('p', { class: 'small muted' }, 'Scores used: ', stored.profilesInStoredScores.length ? stored.profilesInStoredScores.join(', ') : '—',
            '. Zero denominators are shown as n/a.'))))
    : emptyState('Nothing scored yet', 'Process the dataset first; evaluation compares stored scores with the planted labels.',
      [button('Process entire dataset', async () => { await app.provider.submitJob({ datasetId: ds.datasetId }); app.navigate('#/queue'); }, { kind: 'primary', disabled: !app.can('analyst') })]);

  const compareTable = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('caption', { class: 'sr-only' }, 'Profile comparison'),
    h('thead', null, h('tr', null, ['Profile', 'Flag threshold', 'TP', 'FP', 'TN', 'FN', 'Precision', 'Recall', 'FP rate', 'F1'].map((t, i) => h('th', { scope: 'col', class: i > 1 ? 'num' : null }, t)))),
    h('tbody', null, compare.map(({ p, ev }) => {
      const prof = app.rules.profiles[p];
      return h('tr', null,
        h('td', null, prof.label, p === app.rules.defaultProfile ? badge('default', 'outline') : null),
        h('td', null, '≥ ' + (prof.flagMinScore ?? app.rules.flagMinScore)),
        ...[ev.truePositives, ev.falsePositives, ev.trueNegatives, ev.falseNegatives].map((v) => h('td', { class: 'num' }, String(v))),
        ...[ev.precision, ev.recall, ev.falsePositiveRate, ev.f1].map((v) => h('td', { class: 'num' }, fmtPct(v))));
    }))));

  const def = compare.find((c) => c.p === app.rules.defaultProfile).ev;
  const patternTable = def.byPattern.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('caption', { class: 'sr-only' }, 'Recall by planted pattern'),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Planted pattern'), ...profiles.map((p) => h('th', { scope: 'col', class: 'num' }, app.rules.profiles[p].label)))),
      h('tbody', null, def.byPattern.map((row) => h('tr', null, h('td', null, row.pattern),
        ...compare.map(({ ev }) => {
          const s = ev.byPattern.find((x) => x.pattern === row.pattern);
          return h('td', { class: 'num' }, s ? `${s.detected}/${s.records} (${fmtPct(s.recall, 0)})` : '—');
        }))))))
    : h('p', { class: 'muted' }, 'This scenario plants no anomalies, so recall is undefined; any flag is a false positive.');

  const planted = h('ul', { class: 'list-plain' }, meta.plantedPatterns.length
    ? meta.plantedPatterns.map((p) => h('li', null, h('div', { class: 'row' }, badge(p.pattern, 'violet'), h('span', { class: 'small muted' }, p.description)),
      h('div', { class: 'row mt-8' }, p.recordIds.map((r) => chip(r, () => open(r))))))
    : h('li', { class: 'muted' }, 'No anomalies planted (normal scenario).'));

  mount(main,
    pageHead('Risk Evaluation', 'Measures how well the illustrative rules recover anomalies that were deliberately planted in this synthetic dataset.',
      [sourceTag(app.mode === 'aws' ? 'app' : 'sim')]),
    callout([h('strong', null, 'What these numbers mean: '), 'they evaluate recovery of patterns we planted ourselves in fictional data. They do ',
      h('strong', null, 'not'), ' measure real-world crime-detection performance, and the rules and thresholds have not been validated for any operational use. Ground-truth labels are stored separately and are never an input to scoring.']),
    card('Stored scores vs. planted labels', storedBlock, { sub: app.mode === 'aws' ? 'scores computed by the AWS worker' : 'scores computed by the simulated worker' }),
    h('div', { class: 'grid split mt-12' },
      card('Compare scoring profiles', h('div', { class: 'stack' }, compareTable,
        h('p', { class: 'small muted' }, 'Computed in your browser by re-running the same deterministic engine (identical to the Python worker — verified by cross-language tests) over the same records. Nothing is written back.')),
      { sub: 'same dataset, same labels' }),
      card('Known planted anomalies', planted, { sub: meta.anomalousRecordCount + ' labelled records' })),
    card('Recall by planted pattern', patternTable, { cls: 'mt-12' }));
}
