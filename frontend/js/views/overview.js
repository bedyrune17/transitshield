import { h, mount } from '../ui/dom.js';
import {
  pageHead, kpi, card, button, emptyState, fmtPct, fmtNum, fmtRelative, fmtDate, sourceTag, badge, callout, errorState,
} from '../ui/components.js';
import { riskDistribution, activityTimeline } from '../ui/charts.js';
import { describeEvent, eventTone } from './audit.js';

// First match wins, so failures are listed before the generic job category.
const CATEGORIES = [
  { key: 'fail', label: 'Failures', color: '#ec5f59', match: (e) => /FAILED|DEAD|DENIED/.test(e.action) },
  { key: 'case', label: 'Case activity', color: '#a48cf2', match: (e) => e.action.startsWith('CASE_') },
  { key: 'job', label: 'Processing', color: '#6ea8fe', match: (e) => e.action.startsWith('JOB_') || e.action === 'SCORING_COMPLETED' },
  { key: 'other', label: 'Data & security', color: '#8494a5', match: () => true },
];

export function opsPanel(ops, mode) {
  if (!ops) return h('p', { class: 'muted' }, 'Operational data unavailable.');
  const tag = mode === 'aws' && ops.source === 'aws' ? sourceTag('aws') : sourceTag('sim');
  const q = ops.queue || {};
  const d = ops.deadLetterQueue || {};
  const alarm = ops.dlqAlarm;
  const w = ops.workerLambdaLastHour;
  return h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('span', { class: 'small muted' }, mode === 'aws' ? 'Read from SQS and CloudWatch APIs' : 'In-browser queue simulation'), tag),
    h('dl', { class: 'kv' },
      h('dt', null, 'Queue: waiting'), h('dd', null, ops.queueError ? 'error: ' + ops.queueError : fmtNum(q.visible)),
      h('dt', null, 'Queue: in flight'), h('dd', null, fmtNum(q.inFlight)),
      h('dt', null, 'Dead-letter queue'), h('dd', null, fmtNum(d.visible), d.visible ? badge('needs attention', 'red') : null),
      h('dt', null, 'DLQ alarm'), h('dd', null, alarm ? badge(alarm.state, alarm.state === 'OK' ? 'green' : alarm.state === 'ALARM' ? 'red' : 'slate') : (ops.alarmError ? 'error: ' + ops.alarmError : '—')),
      w ? [h('dt', null, 'Worker invocations (1h)'), h('dd', null, fmtNum(w.Invocations)),
        h('dt', null, 'Worker errors (1h)'), h('dd', null, fmtNum(w.Errors)),
        h('dt', null, 'Worker avg duration (1h)'), h('dd', null, w.Duration ? w.Duration + ' ms' : '—'),
        h('dt', null, 'Worker throttles (1h)'), h('dd', null, fmtNum(w.Throttles))] : null,
      ops.workers ? [h('dt', null, 'Simulated workers'), h('dd', null, ops.busyWorkers + ' busy of ' + ops.workers)] : null),
    h('div', { class: 'small muted' }, 'Fetched ' + fmtDate(ops.fetchedAt) + (ops.cached ? ' (cached ≤30 s)' : '')));
}

export async function render(app, main, ctx) {
  const ds = app.currentDataset();
  if (!ds) {
    mount(main, pageHead('Overview', 'Investigation dashboard for synthetic cargo and financial records.'),
      card(null, emptyState('No synthetic dataset yet', 'Generate a deterministic synthetic dataset to begin. Every record and company is fictional; anomalies are planted deliberately so the rules can be evaluated.',
        [button('Generate dataset', () => app.navigate('#/settings'), { kind: 'primary', iconName: 'plus' })])));
    return;
  }
  const [metrics, auditRes, ops] = await Promise.all([
    app.provider.getMetrics(ds.datasetId),
    app.provider.listAudit({ limit: 300 }),
    app.provider.getOps().catch((err) => ({ error: err })),
  ]);
  if (!ctx.isCurrent()) return;
  const m = metrics;
  const events = auditRes.events;
  const live = app.mode === 'aws';
  const tagKind = live ? 'app' : 'sim';

  const unprocessed = m.totalRecords - m.processedRecords;
  const kpis = h('div', { class: 'kpis' },
    kpi('Synthetic records', fmtNum(m.totalRecords), { iconName: 'database', hint: ds.anomalousRecordCount + ' with planted anomalies' }),
    kpi('Processed', fmtNum(m.processedRecords), { iconName: 'check', hint: unprocessed ? unprocessed + ' not yet scored' : 'all records scored', tone: unprocessed ? 'warn' : 'good' }),
    kpi('Pending jobs', fmtNum(m.pendingJobs), { iconName: 'queue', hint: 'queued, processing or retrying', tone: m.pendingJobs ? 'warn' : null }),
    kpi('Flagged records', fmtNum(m.flaggedRecords), { iconName: 'alert', hint: 'score ≥ flag threshold', tone: m.flaggedRecords ? 'bad' : null }),
    kpi('High-priority cases', fmtNum(m.highPriorityCases), { iconName: 'target', hint: 'open HIGH-risk cases', tone: m.highPriorityCases ? 'bad' : null }),
    kpi('Awaiting review', fmtNum(m.casesAwaitingReview), { iconName: 'cases', hint: 'new, under review or escalated', tone: m.casesAwaitingReview ? 'warn' : null }),
    kpi('Resolved / dismissed', fmtNum(m.casesResolved) + ' / ' + fmtNum(m.casesDismissed), { iconName: 'check', tone: 'good' }),
    kpi('Processing failures', fmtNum(m.failedJobs), { iconName: 'alert', hint: m.failedAttempts + ' failed attempts in total', tone: m.failedJobs ? 'bad' : null }),
    kpi('Job success rate', fmtPct(m.jobSuccessRate, 0), { iconName: 'evaluation', hint: m.finishedJobs + ' finished jobs', tone: m.jobSuccessRate === 1 ? 'good' : m.jobSuccessRate === null ? null : 'warn' }));

  const recent = events.slice(0, 8);
  const recentList = recent.length
    ? h('ul', { class: 'timeline' }, recent.map((e) => h('li', { class: eventTone(e) },
      h('div', { class: 't-head' }, h('strong', null, e.action.replace(/_/g, ' ').toLowerCase()), h('span', { class: 't-time' }, fmtRelative(e.timestamp))),
      h('div', { class: 't-body' }, describeEvent(e)))))
    : h('p', { class: 'muted' }, 'No activity yet.');

  const datasetCard = card('Active dataset', h('div', { class: 'stack' },
    h('dl', { class: 'kv' },
      h('dt', null, 'Scenario'), h('dd', null, ds.scenarioLabel),
      h('dt', null, 'Seed / size'), h('dd', null, ds.seed + ' / ' + ds.recordCount + ' records'),
      h('dt', null, 'Planted anomalies'), h('dd', null, ds.anomalousRecordCount + ' records'),
      h('dt', null, 'Dataset ID'), h('dd', null, h('code', null, ds.datasetId)),
      h('dt', null, 'Generated'), h('dd', null, fmtDate(ds.createdAt))),
    h('p', { class: 'small muted' }, ds.scenarioDescription),
    h('div', { class: 'row' },
      button('Process entire dataset', async () => {
        try {
          const job = await app.provider.submitJob({ datasetId: ds.datasetId });
          app.navigate('#/queue?highlight=' + job.jobId);
        } catch (err) { mount(main.querySelector('#ov-err'), errorState(err)); }
      }, { kind: 'primary', iconName: 'play', disabled: !app.can('analyst') }),
      button('Explore records', () => app.navigate('#/records'), { iconName: 'records' }))), { sub: 'deterministic' });

  mount(main,
    pageHead('Overview', 'Live state of the selected synthetic dataset, its processing jobs and investigation cases.',
      [sourceTag(tagKind), button('Refresh', () => app.navigate('#/overview'), { iconName: 'refresh', kind: 'ghost' })]),
    h('div', { id: 'ov-err' }),
    kpis,
    h('div', { class: 'grid split' },
      h('div', { class: 'stack' },
        card('Recent activity timeline', activityTimeline(events, { buckets: 12, categories: CATEGORIES }), { sub: 'audit events, all datasets' }),
        card('Recent investigation activity', recentList, { actions: button('Audit history', () => app.navigate('#/audit'), { kind: 'ghost', sm: true }) })),
      h('div', { class: 'stack' },
        card('Risk distribution', h('div', null, riskDistribution(m.riskDistribution),
          h('p', { class: 'small muted mt-8' }, 'Processed records by demo risk level. Thresholds are illustrative (see Settings → Rules).')),
        { actions: button('View flagged', () => app.navigate('#/records?flagged=1'), { kind: 'ghost', sm: true }) }),
        card('Queue & worker health', ops.error ? errorState(ops.error) : opsPanel(ops, app.mode), { sub: live ? 'AWS' : 'simulated' }),
        datasetCard)),
    m.pendingJobs ? callout(['Jobs are still running: these numbers change as the worker completes them. ', button('Open queue', () => app.navigate('#/queue'), { sm: true })], 'info') : null);

  if (m.pendingJobs) {
    const t = setTimeout(() => { if (ctx.isCurrent()) render(app, main, ctx).catch(() => {}); }, 4000);
    app.onLeave(() => clearTimeout(t));
  }
}
