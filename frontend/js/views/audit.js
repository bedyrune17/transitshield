import { h, mount } from '../ui/dom.js';
import { pageHead, card, button, dataTable, badge, fmtDate, select, field, callout, sourceTag } from '../ui/components.js';

export function eventTone(e) {
  if (/FAILED|DEAD|DENIED/.test(e.action)) return 'bad';
  if (e.action === 'JOB_ATTEMPT_FAILED' || e.action === 'DATASET_RESET' || e.action === 'JOB_RECOVERY_REQUESTED') return 'warn';
  if (e.action === 'SCORING_COMPLETED' || (e.action === 'CASE_STATUS_CHANGED' && e.metadata && e.metadata.to === 'RESOLVED')) return 'good';
  return '';
}

export function describeEvent(e) {
  const m = e.metadata || {};
  switch (e.action) {
    case 'DATASET_GENERATED': return `Generated ${m.recordCount} synthetic records (scenario ${m.scenario}, seed ${m.seed}); ${m.plantedAnomalousRecords} with planted anomalies.`;
    case 'DATASET_RESET': return `Demo dataset reset: ${m.recordsRemoved} records removed, ${m.casesArchived} cases archived (not deleted).`;
    case 'JOB_SUBMITTED': return `Job ${e.jobId} accepted: ${m.jobType} for ${m.recordCount} record(s)` + (m.failureMode && m.failureMode !== 'none' ? `, controlled failure "${m.failureMode}".` : '.');
    case 'SCORING_COMPLETED': return `Job ${e.jobId} scored ${m.scored} record(s); ${m.flagged} flagged.`;
    case 'JOB_ATTEMPT_FAILED': return `Attempt ${m.attempt} of job ${e.jobId} failed (${m.errorCode}); retry scheduled.`;
    case 'JOB_DEAD_LETTERED': return `Job ${e.jobId} exhausted ${m.maxAttempts} attempts (${m.errorCode}) and was moved to the dead-letter queue.`;
    case 'JOB_FAILED': return `Job ${e.jobId} failed without retry (${m.errorCode}).`;
    case 'JOB_RECOVERY_REQUESTED': return `Operator recovery for ${e.jobId}: failure flag cleared, re-queued (${m.dlqMessagesRemoved} DLQ message(s) removed).`;
    case 'CASE_CREATED': return `Case opened for ${e.recordId} (${m.origin === 'AUTO' ? 'automatically, HIGH risk' : 'manually'}).`;
    case 'CASE_STATUS_CHANGED': return `${m.from} → ${m.to}` + (m.reason ? `: “${m.reason}”` : '');
    case 'CASE_COMMENT_ADDED': return `Comment: “${m.text}”`;
    case 'AUTHENTICATION_FAILED': return `Rejected request (${m.reason}) to ${m.method} ${m.path}.`;
    case 'AUTHORIZATION_DENIED': return 'Action refused: insufficient role' + (m.path ? ` for ${m.method} ${m.path}` : '') + '.';
    default: return JSON.stringify(m);
  }
}

let actionFilter = '';

export async function render(app, main, ctx) {
  const res = await app.provider.listAudit({ limit: 500 });
  if (!ctx.isCurrent()) return;
  const actions = [...new Set(res.events.map((e) => e.action))].sort();
  const table = dataTable([
    { key: 'timestamp', label: 'Time (UTC)', sort: (e) => e.sortKey || e.timestamp, render: (e) => h('span', { class: 'nowrap' }, fmtDate(e.timestamp)) },
    { key: 'action', label: 'Action', render: (e) => badge(e.action, { bad: 'red', warn: 'amber', good: 'green' }[eventTone(e)] || 'slate') },
    { key: 'actorId', label: 'Actor', render: (e) => h('code', null, e.actorId) },
    { key: 'subject', label: 'Subject', sort: (e) => e.caseId || e.jobId || e.recordId || e.datasetId || '', render: (e) => h('code', { class: 'small' }, e.caseId ? e.recordId + ' (case)' : e.jobId || e.recordId || e.datasetId || e.streamId) },
    { key: 'details', label: 'Details', sortable: false, render: (e) => h('span', { class: 'small' }, describeEvent(e)) },
  ], { pageSize: 30, initialSort: { key: 'timestamp', dir: 'desc' }, emptyText: 'No audit events match' });
  const apply = () => table.update(res.events.filter((e) => !actionFilter || e.action === actionFilter), { resetPage: true });
  apply();
  table.setCaption('Audit events');
  mount(main,
    pageHead('Audit History', 'Significant events, appended by the application. Timestamps and actor IDs are set by the server from the verified identity.',
      [sourceTag(app.mode === 'aws' ? 'app' : 'sim'), button('Refresh', () => app.navigate('#/audit'), { kind: 'ghost', iconName: 'refresh' })]),
    callout(['The application only ever ', h('strong', null, 'appends'), ' audit events; the UI and API offer no way to edit or delete them, and writes are idempotent (one event per action even if a message is retried). It is ',
      h('strong', null, 'not'), ' a cryptographically tamper-evident log: an AWS administrator could still modify the table.'], 'info'),
    h('section', { class: 'card mt-12' },
      h('div', { class: 'toolbar' }, field('Action', select([['', 'All actions'], ...actions.map((a) => [a, a])], actionFilter, (v) => { actionFilter = v; apply(); })),
        h('span', { class: 'muted small' }, res.total + ' events stored' + (res.total > res.events.length ? ' (showing newest ' + res.events.length + ')' : ''))),
      table.el));
}
