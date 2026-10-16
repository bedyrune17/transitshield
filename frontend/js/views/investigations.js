import { h, mount } from '../ui/dom.js';
import {
  pageHead, card, button, dataTable, caseBadge, riskBadge, badge, fmtDate, fmtRelative, emptyState, toast, toastError,
  callout, errorState, chip, sourceTag,
} from '../ui/components.js';
import { TRANSITIONS, STATUS_LABELS, needsReason, CLOSED } from '../core/cases.js';
import { openRecordDrawer, findingsList, typeLabel } from './recordDetail.js';
import { describeEvent, eventTone } from './audit.js';

let statusFilter = 'OPEN';

export async function render(app, main, ctx) {
  if (ctx.params[0]) return renderCase(app, main, ctx, ctx.params[0]);
  const ds = app.currentDataset();
  const cases = await app.provider.listCases(ds ? ds.datasetId : undefined);
  if (!ctx.isCurrent()) return;

  const counts = { OPEN: 0, ALL: cases.length };
  for (const c of cases) {
    counts[c.caseStatus] = (counts[c.caseStatus] || 0) + 1;
    if (!CLOSED.includes(c.caseStatus)) counts.OPEN += 1;
  }
  const table = dataTable([
    { key: 'priority', label: 'Priority', sort: (c) => (c.priority === 'HIGH' ? 0 : 1), render: (c) => (c.priority === 'HIGH' ? badge('High', 'red', true) : badge('Normal', 'slate')) },
    { key: 'caseStatus', label: 'Status', render: (c) => caseBadge(c.caseStatus) },
    { key: 'recordId', label: 'Record', render: (c) => h('code', null, c.recordId) },
    { key: 'riskScoreAtOpen', label: 'Score at open', num: true, render: (c) => (c.riskScoreAtOpen ?? '—') },
    { key: 'riskLevelAtOpen', label: 'Risk at open', render: (c) => riskBadge(c.riskLevelAtOpen) },
    { key: 'origin', label: 'Opened by', render: (c) => (c.origin === 'AUTO' ? badge('Worker (auto)', 'violet') : badge('Analyst', 'blue')) },
    { key: 'commentCount', label: 'Comments', num: true },
    { key: 'updatedAt', label: 'Updated', render: (c) => h('span', { title: fmtDate(c.updatedAt) }, fmtRelative(c.updatedAt)) },
  ], {
    onRowClick: (c) => app.navigate('#/investigations/' + encodeURIComponent(c.caseId)),
    initialSort: { key: 'updatedAt', dir: 'desc' },
    emptyText: 'No cases in this view',
  });
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Case status filter' });
  function apply() {
    mount(tabs, ['OPEN', 'NEW', 'UNDER_REVIEW', 'ESCALATED', 'RESOLVED', 'DISMISSED', 'ALL'].map((s) => h('button', {
      role: 'tab', 'aria-selected': String(statusFilter === s), onclick: () => { statusFilter = s; apply(); },
    }, (s === 'OPEN' ? 'Open' : s === 'ALL' ? 'All' : STATUS_LABELS[s]) + ' (' + (counts[s] || 0) + ')')));
    table.update(cases.filter((c) => statusFilter === 'ALL' || (statusFilter === 'OPEN' ? !CLOSED.includes(c.caseStatus) : c.caseStatus === statusFilter)), { resetPage: true });
  }
  apply();
  table.setCaption('Investigation cases');
  mount(main,
    pageHead('Investigations', 'Cases are opened automatically for HIGH-risk results or manually by an analyst. Every decision is recorded in the audit trail.',
      [sourceTag(app.mode === 'aws' ? 'app' : 'sim')]),
    callout(['A case is a prompt to review inconsistent ', h('strong', null, 'synthetic'), ' documents. Opening, escalating or resolving a case is not a finding that any party acted unlawfully.'], 'info'),
    h('section', { class: 'card mt-12' }, tabs, cases.length ? table.el
      : h('div', { class: 'card-body' }, emptyState('No cases yet', 'Process the dataset: HIGH-risk records open cases automatically. You can also open a case from any record.',
        [button('Go to records', () => app.navigate('#/records'), { kind: 'primary' })], 'cases'))));
}

async function renderCase(app, main, ctx, caseId) {
  let data;
  let draftComment = '';
  let draftReason = '';
  let conflict = null;

  async function load() {
    data = await app.provider.getCase(caseId);
    if (ctx.isCurrent()) draw();
  }

  function draw() {
    const c = data.case;
    const rec = data.record;
    const canEdit = app.can('analyst') && !c.archived;
    const reasonBox = h('textarea', { class: 'input', id: 'case-reason', placeholder: 'Reason (required to dismiss, resolve or reopen; 5–500 characters)', maxlength: '500',
      oninput: (e) => { draftReason = e.target.value; } });
    reasonBox.value = draftReason;
    const commentBox = h('textarea', { class: 'input', id: 'case-comment', placeholder: 'Add a comment for the case file (max 1000 characters)', maxlength: '1000',
      oninput: (e) => { draftComment = e.target.value; } });
    commentBox.value = draftComment;

    async function act(fn, okTitle) {
      try {
        await fn();
        conflict = null;
        toast(okTitle, null, 'good');
        await load();
      } catch (err) {
        if (err.status === 409 && err.code === 'VERSION_CONFLICT') {
          conflict = err;
          draw();
        } else toastError(err);
      }
    }

    const transitions = (TRANSITIONS[c.caseStatus] || []).map((to) => button(
      (CLOSED.includes(c.caseStatus) ? 'Reopen → ' : '') + STATUS_LABELS[to],
      () => {
        if (needsReason(c.caseStatus, to) && draftReason.trim().length < 5) {
          reasonBox.setAttribute('aria-invalid', 'true');
          reasonBox.focus();
          toast('Reason required', 'Explain why the case is being ' + (CLOSED.includes(to) ? STATUS_LABELS[to].toLowerCase() : 'reopened') + '.', 'warn');
          return;
        }
        act(async () => {
          await app.provider.transitionCase(c.caseId, to, draftReason.trim() || null, c.version);
          draftReason = '';
        }, 'Case moved to ' + STATUS_LABELS[to]);
      },
      { kind: to === 'RESOLVED' ? 'primary' : to === 'ESCALATED' ? 'danger' : null, disabled: !canEdit }));

    const actionsCard = card('Decision', h('div', { class: 'stack' },
      conflict ? h('div', { class: 'error-state', role: 'alert' }, h('strong', null, 'This case was changed by someone else.'),
        h('div', { class: 'small mt-8' }, 'Your text has been kept. Reload the latest version, review it, then apply your decision again.'),
        h('div', { class: 'row' }, button('Reload latest version', () => { conflict = null; load(); }, { sm: true, iconName: 'refresh' }))) : null,
      !canEdit ? callout(c.archived ? 'This case belongs to a dataset that was reset; it is archived and read-only.' : 'Your role is read-only (viewer). Analysts and admins can change cases.', 'info') : null,
      h('div', { class: 'field' }, h('label', { for: 'case-reason' }, 'Reason'), reasonBox),
      h('div', { class: 'row' }, transitions.length ? transitions : h('span', { class: 'muted' }, 'No transitions available.')),
      h('div', { class: 'divider' }),
      h('div', { class: 'field' }, h('label', { for: 'case-comment' }, 'Comment'), commentBox),
      h('div', { class: 'row' }, button('Add comment', () => {
        if (!draftComment.trim()) { commentBox.focus(); return; }
        act(async () => { await app.provider.addComment(c.caseId, draftComment, c.version); draftComment = ''; }, 'Comment added');
      }, { iconName: 'comment', disabled: !canEdit }))),
    { sub: 'version ' + c.version + ' · optimistic locking' });

    const history = data.history.length
      ? h('ul', { class: 'timeline' }, data.history.map((e) => h('li', { class: eventTone(e) },
        h('div', { class: 't-head' }, h('strong', null, e.action.replace(/_/g, ' ').toLowerCase()), h('span', { class: 't-time' }, fmtDate(e.timestamp))),
        h('div', { class: 't-body' }, describeEvent(e)),
        h('div', { class: 't-body muted' }, 'actor ', h('code', null, e.actorId)))))
      : h('p', { class: 'muted' }, 'No history.');

    const evidence = rec
      ? card('Record & evidence', h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('strong', null, typeLabel(rec.recordType)), chip(rec.recordId, () => openRecordDrawer(app, c.datasetId, rec.recordId, { onChanged: load })),
          riskBadge(rec.riskLevel), rec.riskScore !== undefined && rec.riskScore !== null ? badge('score ' + rec.riskScore, 'outline') : null),
        findingsList(rec.findings),
        h('div', { class: 'row' }, button('Open full record', () => openRecordDrawer(app, c.datasetId, rec.recordId, { onChanged: load }), { sm: true, iconName: 'records' }),
          button('Show in graph', () => app.navigate('#/relationships?focus=' + encodeURIComponent(rec.recordId)), { sm: true, kind: 'ghost', iconName: 'graph' }))),
      { sub: 'current score' })
      : card('Record & evidence', h('p', { class: 'muted' }, 'The underlying synthetic record no longer exists (dataset reset). The case history is preserved.'));

    mount(main,
      h('div', { class: 'row mt-8' }, button('All cases', () => app.navigate('#/investigations'), { kind: 'ghost', iconName: 'chevronLeft', sm: true })),
      pageHead(h('span', null, 'Case ', h('code', null, c.recordId)), null,
        [caseBadge(c.caseStatus), c.priority === 'HIGH' ? badge('High priority', 'red', true) : badge('Normal priority', 'slate'), c.archived ? badge('Archived', 'outline') : null]),
      h('dl', { class: 'kv card card-body' },
        h('dt', null, 'Case ID'), h('dd', null, h('code', null, c.caseId)),
        h('dt', null, 'Opened'), h('dd', null, fmtDate(c.createdAt) + ' by ' + (c.origin === 'AUTO' ? 'worker (automatic, HIGH risk)' : c.createdBy)),
        h('dt', null, 'Risk at open'), h('dd', null, c.riskScoreAtOpen !== null && c.riskScoreAtOpen !== undefined ? c.riskScoreAtOpen + ' (' + c.riskLevelAtOpen + ')' : 'not scored'),
        h('dt', null, 'Last decision by'), h('dd', null, c.assignedActor ? h('code', null, c.assignedActor) : '—'),
        c.resolutionReason ? [h('dt', null, 'Closing reason'), h('dd', null, c.resolutionReason)] : null,
        c.reopenReason ? [h('dt', null, 'Reopen reason'), h('dd', null, c.reopenReason)] : null),
      h('div', { class: 'grid split mt-12' },
        h('div', { class: 'stack' }, evidence, card('Case history', history, { sub: 'append-only audit events' })),
        h('div', { class: 'stack' }, actionsCard)));
  }

  try {
    await load();
  } catch (err) {
    mount(main, button('All cases', () => app.navigate('#/investigations'), { kind: 'ghost', iconName: 'chevronLeft', sm: true }),
      errorState(err, () => renderCase(app, main, ctx, caseId)));
  }
}
