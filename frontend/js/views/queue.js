import { h, mount } from '../ui/dom.js';
import {
  pageHead, card, button, dataTable, jobBadge, badge, fmtDate, fmtDuration, select, field, callout, toast, toastError,
  emptyState, sourceTag, openDrawer, errorState,
} from '../ui/components.js';
import { opsPanel } from './overview.js';

const form = { scope: 'dataset', recordIds: '', failureMode: 'none', profile: '' };
const ACTIVE = ['QUEUED', 'PROCESSING', 'RETRY_SCHEDULED', 'REDRIVEN'];

function attemptsView(job) {
  const atts = job.attempts || [];
  if (!atts.length) return h('p', { class: 'muted' }, 'No attempts yet: the job is waiting in the queue.');
  return h('ul', { class: 'timeline' }, atts.map((a) => h('li', { class: a.outcome === 'SUCCEEDED' ? 'good' : a.outcome === 'FAILED' ? 'bad' : '' },
    h('div', { class: 't-head' }, h('strong', null, 'Attempt ' + a.attempt), badge(a.outcome, a.outcome === 'SUCCEEDED' ? 'green' : a.outcome === 'FAILED' ? 'red' : 'blue'),
      h('span', { class: 't-time' }, fmtDate(a.startedAt))),
    h('div', { class: 't-body' }, 'SQS receive count ' + (a.receiveCount ?? '—') + (a.errorCode ? ' · error ' + a.errorCode : '') + (a.endedAt ? ' · ended ' + fmtDate(a.endedAt) : '')))));
}

export async function render(app, main, ctx) {
  const ds = app.currentDataset();
  const highlight = ctx.query.get('highlight');
  const opsBox = h('div');
  const tableBox = h('div');
  const statusLine = h('span', { class: 'muted small' });
  let jobs = [];
  let timer = null;

  const table = dataTable([
    { key: 'jobId', label: 'Job ID', render: (j) => h('code', { class: 'nowrap' }, j.jobId) },
    { key: 'jobType', label: 'Scope', render: (j) => h('span', { class: 'nowrap' }, (j.jobType === 'SCORE_DATASET' ? 'Dataset' : 'Records') + ' (' + j.recordCount + ')') },
    { key: 'createdAtEpochMs', label: 'Submitted', render: (j) => h('span', { class: 'nowrap' }, fmtDate(j.createdAt)) },
    { key: 'jobStatus', label: 'Status', render: (j) => h('div', { class: 'row' }, jobBadge(j.jobStatus), ['DEAD_LETTERED', 'FAILED'].includes(j.jobStatus)
      ? button('Recover', () => recover(j), { sm: true, kind: 'primary', iconName: 'reset', disabled: !app.can('analyst') }) : null) },
    { key: 'durationMs', label: 'Submit → done', num: true, render: (j) => fmtDuration(j.durationMs) },
    { key: 'processingMs', label: 'Worker time', num: true, render: (j) => fmtDuration(j.processingMs) },
    { key: 'attemptCount', label: 'Attempts', num: true, render: (j) => String(j.attemptCount || 0) },
    { key: 'failureMode', label: 'Demo failure', render: (j) => (j.failureMode && j.failureMode !== 'none' ? badge(j.failureMode, 'amber') : h('span', { class: 'muted' }, '—')) },
    { key: 'errorCode', label: 'Failure reason', render: (j) => (j.errorCode ? h('span', { class: 'small', title: j.errorSummary || '' }, j.errorCode) : h('span', { class: 'muted' }, '—')) },
  ], {
    pageSize: 15,
    initialSort: { key: 'createdAtEpochMs', dir: 'desc' },
    onRowClick: (j) => showJob(j.jobId),
    rowClass: (j) => (j.jobId === highlight ? 'selected' : null),
    emptyText: 'No jobs yet',
  });
  table.setCaption('Processing jobs');

  async function recover(j) {
    try {
      await app.provider.recoverJob(j.jobId);
      toast('Recovery requested', j.jobId + ': demo failure flag cleared, message removed from the DLQ and re-queued.', 'good');
      load();
    } catch (err) { toastError(err, 'Recovery failed'); }
  }

  async function showJob(jobId) {
    const d = openDrawer('Job ' + jobId, h('div', { class: 'loading-block' }, 'Loading…'));
    try {
      const j = await app.provider.getJob(jobId);
      d.setBody(h('div', { class: 'stack' },
        h('div', { class: 'row' }, jobBadge(j.jobStatus), j.failureMode !== 'none' ? badge('controlled failure: ' + j.failureMode, 'amber') : null),
        h('dl', { class: 'kv' },
          h('dt', null, 'Dataset'), h('dd', null, h('code', null, j.datasetId)),
          h('dt', null, 'Scope'), h('dd', null, j.recordIds ? j.recordIds.join(', ') : j.recordIdsPreview ? j.recordIdsPreview.join(', ') + '…' : 'entire dataset'),
          h('dt', null, 'Scoring profile'), h('dd', null, j.profile),
          h('dt', null, 'Submitted'), h('dd', null, fmtDate(j.createdAt) + ' by ' + j.submittedBy),
          h('dt', null, 'Started'), h('dd', null, fmtDate(j.startedAt)),
          h('dt', null, 'Completed'), h('dd', null, fmtDate(j.completedAt)),
          h('dt', null, 'Submit → done'), h('dd', null, fmtDuration(j.durationMs)),
          h('dt', null, 'Error'), h('dd', null, j.errorCode ? j.errorCode + ' — ' + (j.errorSummary || '') : '—'),
          j.resultSummary ? [h('dt', null, 'Result'), h('dd', null, `${j.resultSummary.scored} scored, ${j.resultSummary.flagged} flagged, ${j.resultSummary.casesCreated} case(s) opened`)] : null),
        card('Attempts', attemptsView(j), { sub: 'max 3 per recovery cycle' }),
        ['DEAD_LETTERED', 'FAILED'].includes(j.jobStatus) ? button('Recover this job', () => { d.close(); recover(j); }, { kind: 'primary', iconName: 'reset', disabled: !app.can('analyst') }) : null));
    } catch (err) { d.setBody(errorState(err)); }
  }

  async function load() {
    clearTimeout(timer);
    try {
      const [js, ops] = await Promise.all([app.provider.listJobs(ds ? ds.datasetId : undefined), app.provider.getOps().catch((e) => ({ error: e }))]);
      if (!ctx.isCurrent()) return;
      jobs = js;
      table.update(jobs);
      mount(opsBox, ops.error ? errorState(ops.error) : opsPanel(ops, app.mode));
      const active = jobs.filter((j) => ACTIVE.includes(j.jobStatus)).length;
      statusLine.textContent = active ? active + ' active job(s) · auto-refreshing every 2.5 s' : 'No active jobs · ' + new Date().toISOString().slice(11, 19) + ' UTC';
      if (active) timer = setTimeout(load, 2500);
    } catch (err) {
      statusLine.textContent = 'Refresh failed: ' + err.message;
      toastError(err, 'Could not refresh the queue');
    }
  }
  app.onLeave(() => clearTimeout(timer));

  const recordInput = h('input', { class: 'input', placeholder: 'e.g. SHP-0003, INV-0007', value: form.recordIds, oninput: (e) => { form.recordIds = e.target.value; } });
  const profiles = Object.entries(app.rules.profiles).map(([k, p]) => [k, p.label]);
  const submitCard = card('Submit a processing job', ds ? h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      const params = { datasetId: ds.datasetId, failureMode: form.failureMode, profile: form.profile || null };
      if (form.scope === 'records') {
        params.recordIds = form.recordIds.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
        if (!params.recordIds.length) { recordInput.setAttribute('aria-invalid', 'true'); recordInput.focus(); return; }
      }
      try {
        const job = await app.provider.submitJob(params);
        toast('Accepted (202) — not yet completed', job.jobId + ' is queued. The worker will pick it up asynchronously.', 'good');
        load();
      } catch (err) { toastError(err, 'Job rejected'); }
    },
  },
  h('div', { class: 'form-grid' },
    field('Scope', select([['dataset', 'Entire dataset'], ['records', 'Specific records']], form.scope, (v) => { form.scope = v; recordInput.disabled = v !== 'records'; })),
    field('Record IDs', recordInput, 'comma separated'),
    field('Controlled failure (demo)', select([['none', 'None'], ['transient', 'Transient: fail 2×, then succeed'], ['permanent', 'Permanent: dead-letter']], form.failureMode, (v) => { form.failureMode = v; })),
    field('Scoring profile', select([['', 'Default (' + app.rules.defaultProfile + ')'], ...profiles], form.profile, (v) => { form.profile = v; }))),
  h('div', { class: 'row' }, button('Submit job', null, { type: 'submit', kind: 'primary', iconName: 'play', disabled: !app.can('analyst') }),
    button('Burst test: 10 small jobs', async () => {
      // Small, rate-limit-friendly load test: shows queue buffering and the worker concurrency cap.
      try {
        const recs = await app.provider.listRecords(ds.datasetId);
        const pick = recs.filter((r, i) => i % Math.max(1, Math.floor(recs.length / 10)) === 0).slice(0, 10);
        const started = Date.now();
        const jobs = await Promise.all(pick.map((r) => app.provider.submitJob({ datasetId: ds.datasetId, recordIds: [r.recordId] })));
        toast('Burst accepted', jobs.length + ' jobs accepted in ' + (Date.now() - started) + ' ms; watch the queue drain (worker concurrency cap 2).', 'good');
        load();
      } catch (err) { toastError(err, 'Burst test stopped'); load(); }
    }, { iconName: 'bolt', disabled: !app.can('analyst') }),
    !app.can('analyst') ? h('span', { class: 'muted small' }, 'Requires analyst role') : null),
  callout(['Failure simulation only sets a flag on ', h('strong', null, 'this demo job'), '; the worker then raises a controlled error. It never touches infrastructure. ',
    'Retries: up to 3 attempts with backoff, then the worker moves the message to the dead-letter queue. Use ', h('strong', null, 'Recover'), ' to fix and re-drive it.'], 'info'))
    : emptyState('No dataset', 'Generate a dataset first.'), { sub: ds ? ds.scenarioLabel : '' });
  recordInput.disabled = form.scope !== 'records';

  mount(main,
    pageHead('Processing Queue', 'Jobs are accepted immediately (HTTP 202), buffered in the queue and scored by a separate worker. Watch them move from Queued to Succeeded, or through retries to the dead-letter queue.',
      [statusLine, button('Refresh', () => load(), { kind: 'ghost', iconName: 'refresh' })]),
    h('div', { class: 'grid split' }, submitCard, card('Queue & worker health', opsBox, { sub: app.mode === 'aws' ? 'live' : 'simulated' })),
    h('section', { class: 'card mt-12' }, h('div', { class: 'card-head' }, h('h2', null, 'Jobs', h('span', { class: 'sub' }, ds ? 'for ' + ds.datasetId : 'all datasets')),
      sourceTag(app.mode === 'aws' ? 'app' : 'sim')), tableBox));
  mount(tableBox, table.el);
  await load();
  if (highlight) showJob(highlight);
}
