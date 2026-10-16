// Reusable UI components.
import { h, mount, clear } from './dom.js';
import { icon } from './icons.js';
import { fmtMoney } from '../core/scoring.js';
import { STATUS_LABELS } from '../core/cases.js';

// ---------------------------------------------------------------- formatting
export function fmtDate(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
export function fmtRelative(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return ms + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}
export function fmtPct(v, digits = 1) {
  return v === null || v === undefined ? 'n/a' : (v * 100).toFixed(digits) + '%';
}
export function fmtNum(v) {
  return v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US');
}
export function fmtAmount(minor, currency) {
  if (typeof minor !== 'number' || !Number.isInteger(minor)) return minor === undefined ? '—' : String(minor);
  return fmtMoney(minor, currency || '');
}

// ---------------------------------------------------------------- badges
export const RISK_COLORS = { NONE: 'slate', LOW: 'blue', MEDIUM: 'amber', HIGH: 'red' };
export const RISK_HEX = { NONE: '#6b7c8f', LOW: '#6ea8fe', MEDIUM: '#e2a336', HIGH: '#ec5f59' };
export const RISK_MEANING = {
  NONE: 'No demo rule fired. The record is internally consistent under the selected profile.',
  LOW: 'Minor inconsistency below the review threshold. Not flagged.',
  MEDIUM: 'Flagged for review: at least one material inconsistency in this synthetic record.',
  HIGH: 'Flagged with high review priority: several or severe inconsistencies. A case is opened automatically.',
};

export function badge(text, color = 'slate', withDot = false) {
  return h('span', { class: ['badge', color] }, withDot ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null, text);
}
export function riskBadge(level) {
  if (!level) return badge('Not scored', 'outline');
  return badge(level === 'NONE' ? 'None' : level[0] + level.slice(1).toLowerCase(), RISK_COLORS[level] || 'slate', true);
}
const PROC = { UNPROCESSED: ['Unprocessed', 'outline'], QUEUED: ['Queued', 'violet'], PROCESSING: ['Processing', 'blue'], PROCESSED: ['Processed', 'green'] };
export function processingBadge(status) {
  const [t, c] = PROC[status] || [status || '—', 'slate'];
  return badge(t, c, true);
}
const JOB = {
  QUEUED: ['Queued', 'violet'], PROCESSING: ['Processing', 'blue'], RETRY_SCHEDULED: ['Retry scheduled', 'amber'],
  SUCCEEDED: ['Succeeded', 'green'], FAILED: ['Failed', 'red'], DEAD_LETTERED: ['Dead-lettered', 'red'], REDRIVEN: ['Redriven', 'violet'],
};
export function jobBadge(status) {
  const [t, c] = JOB[status] || [status, 'slate'];
  return badge(t, c, true);
}
const CASE_COLORS = { NEW: 'violet', UNDER_REVIEW: 'blue', ESCALATED: 'amber', DISMISSED: 'slate', RESOLVED: 'green' };
export function caseBadge(status) {
  return badge(STATUS_LABELS[status] || status, CASE_COLORS[status] || 'slate', true);
}
export function scoreCell(score, level) {
  if (score === null || score === undefined) return h('span', { class: 'muted' }, '—');
  const bar = h('span');
  bar.style.width = Math.max(2, score) + '%';
  bar.style.background = RISK_HEX[level] || RISK_HEX.NONE;
  return h('span', { class: 'score', title: 'Score ' + score + ' of 100' }, h('b', null, String(score)),
    h('span', { class: 'score-bar', 'aria-hidden': 'true' }, bar));
}
export function sourceTag(kind) {
  const map = { aws: ['Live AWS', 'aws'], sim: ['Simulated', 'sim'], app: ['App data', 'app'] };
  const [t, c] = map[kind] || map.app;
  return h('span', { class: ['source-tag', c] }, t);
}

// ---------------------------------------------------------------- layout bits
export function card(title, body, { actions, sub, flush = false, cls } = {}) {
  return h('section', { class: ['card', cls] },
    title ? h('div', { class: 'card-head' }, h('h2', null, title, sub ? h('span', { class: 'sub' }, sub) : null),
      actions ? h('div', { class: 'row' }, actions) : null) : null,
    h('div', { class: ['card-body', flush && 'flush'] }, body));
}
export function kpi(label, value, { hint, tone, iconName } = {}) {
  return h('div', { class: ['kpi', tone] },
    h('div', { class: 'label' }, iconName ? icon(iconName) : null, label),
    h('div', { class: 'value' }, value),
    hint ? h('div', { class: 'hint' }, hint) : null);
}
export function pageHead(title, description, actions) {
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), description ? h('p', null, description) : null),
    actions ? h('div', { class: 'page-actions' }, actions) : null);
}
export function button(label, onClick, { kind, iconName, title, disabled, sm, type = 'button', ariaLabel } = {}) {
  return h('button', { type, class: ['btn', kind, sm && 'sm', !label && 'icon-only'], onclick: onClick, title,
    disabled, 'aria-label': ariaLabel || (!label ? title : undefined) }, iconName ? icon(iconName) : null, label);
}
export function emptyState(title, text, actions, iconName = 'database') {
  return h('div', { class: 'empty' }, icon(iconName), h('h3', null, title), text ? h('p', null, text) : null,
    actions ? h('div', { class: 'row' }, actions) : null);
}
export function loading(text = 'Loading…') {
  return h('div', { class: 'loading-block', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}
export function errorState(err, onRetry) {
  const code = err && err.code ? ' (' + err.code + ')' : '';
  return h('div', { class: 'error-state', role: 'alert' },
    h('strong', null, 'Could not load this view' + code), h('div', { class: 'small mt-8' }, (err && err.message) || String(err)),
    onRetry ? h('div', { class: 'row' }, button('Retry', onRetry, { iconName: 'refresh', sm: true })) : null);
}
export function callout(content, tone = '') {
  return h('div', { class: ['callout', tone] }, content);
}
export function field(labelText, control, help) {
  const id = control.id || 'f-' + Math.random().toString(36).slice(2, 9);
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, labelText), control, help ? h('div', { class: 'help' }, help) : null);
}
export function select(options, value, onChange, attrs = {}) {
  return h('select', { class: 'input', onchange: (e) => onChange && onChange(e.target.value), ...attrs },
    options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
}
export function chip(text, onClick, title) {
  return h('button', { type: 'button', class: 'chip-link', onclick: onClick, title: title || 'Open ' + text }, text);
}

// ---------------------------------------------------------------- toasts
export function toast(title, message, tone = '') {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: ['toast', tone], role: tone === 'bad' ? 'alert' : 'status' },
    h('div', { class: 't-msg' }, h('div', { class: 't-title' }, title), message ? h('div', { class: 'small' }, message) : null),
    button('', () => el.remove(), { kind: 'ghost', iconName: 'close', sm: true, title: 'Dismiss notification' }));
  root.appendChild(el);
  setTimeout(() => el.remove(), tone === 'bad' ? 9000 : 5000);
}
export function toastError(err, title = 'Request failed') {
  toast(title, (err && err.message ? err.message : String(err)) + (err && err.code ? ' [' + err.code + ']' : ''), 'bad');
}

// ---------------------------------------------------------------- drawer & modal
let lastFocus = null;
export function openDrawer(title, body, { onClose } = {}) {
  const root = document.getElementById('drawer-root');
  lastFocus = document.activeElement;
  const close = () => {
    clear(root);
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const headTitle = h('h2', { id: 'drawer-title' }, title);
  const panel = h('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title' },
    h('div', { class: 'drawer-head' }, headTitle, button('', close, { kind: 'ghost', iconName: 'close', title: 'Close panel' })),
    h('div', { class: 'drawer-body' }, body));
  mount(root, h('div', { class: 'overlay', onclick: close }), panel);
  document.addEventListener('keydown', onKey);
  panel.querySelector('button').focus();
  return { close, setBody: (b) => mount(panel.querySelector('.drawer-body'), b), setTitle: (t) => mount(headTitle, t) };
}
export function closeDrawer() {
  const root = document.getElementById('drawer-root');
  const btn = root.querySelector('.drawer-head button');
  if (btn) btn.click();
}

export function modal(title, body, actions) {
  const root = document.getElementById('modal-root');
  const prev = document.activeElement;
  return new Promise((resolve) => {
    const finish = (val) => {
      clear(root);
      document.removeEventListener('keydown', onKey);
      if (prev && prev.focus) prev.focus();
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
      h('div', { class: 'modal-head' }, h('h2', { id: 'modal-title' }, title)),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' }, actions(finish)));
    mount(root, h('div', { class: 'overlay modal-overlay', onclick: () => finish(null) }), box);
    document.addEventListener('keydown', onKey);
    const focusable = box.querySelector('textarea, input, select, .btn.primary, .btn.danger');
    if (focusable) focusable.focus();
  });
}
export function confirmDialog(title, message, confirmLabel = 'Confirm', danger = false) {
  return modal(title, h('p', null, message), (finish) => [
    button('Cancel', () => finish(false), { kind: 'ghost' }),
    button(confirmLabel, () => finish(true), { kind: danger ? 'danger' : 'primary' }),
  ]);
}

// ---------------------------------------------------------------- data table
/**
 * Sortable, paginated table. columns: [{key, label, render(row), sort(row) , num, width}]
 * Returns {el, update(rows)}.
 */
export function dataTable(columns, { pageSize = 25, onRowClick, rowClass, initialSort, emptyText = 'No rows', selectable, getId, onSelect } = {}) {
  let rows = [];
  let page = 0;
  let sort = initialSort || null; // {key, dir}
  const selected = new Set();
  const wrap = h('div');
  const caption = h('caption', { class: 'sr-only' }, 'Data table');

  function sorted() {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const val = col.sort || ((r) => r[col.key]);
    const dir = sort.dir === 'desc' ? -1 : 1;
    return rows.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x > y ? 1 : -1) * dir;
    });
  }

  function render() {
    const all = sorted();
    const pages = Math.max(1, Math.ceil(all.length / pageSize));
    if (page >= pages) page = pages - 1;
    const slice = all.slice(page * pageSize, page * pageSize + pageSize);
    const head = h('tr', null,
      selectable ? h('th', { scope: 'col' }, h('input', { type: 'checkbox', class: 'check', 'aria-label': 'Select all rows on this page',
        checked: slice.length > 0 && slice.every((r) => selected.has(getId(r))),
        onchange: (e) => { slice.forEach((r) => (e.target.checked ? selected.add(getId(r)) : selected.delete(getId(r)))); onSelect && onSelect([...selected]); render(); } })) : null,
      columns.map((c) => {
        const active = sort && sort.key === c.key;
        const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
        const label = c.sortable === false ? c.label : h('button', {
          onclick: () => { sort = { key: c.key, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' }; render(); },
          'aria-label': 'Sort by ' + c.label,
        }, c.label, h('span', { 'aria-hidden': 'true', class: 'muted' }, active ? (sort.dir === 'asc' ? '▲' : '▼') : ''));
        return h('th', { scope: 'col', class: c.num ? 'num' : null, 'aria-sort': c.sortable === false ? null : ariaSort }, label);
      }));
    const body = slice.length
      ? slice.map((r) => {
        const id = getId ? getId(r) : null;
        return h('tr', {
          class: [onRowClick && 'clickable', rowClass && rowClass(r), selectable && selected.has(id) && 'selected'],
          onclick: onRowClick ? (e) => { if (!e.target.closest('input,button,a')) onRowClick(r); } : null,
          tabindex: onRowClick ? '0' : null,
          onkeydown: onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : null,
        },
        selectable ? h('td', null, h('input', { type: 'checkbox', 'aria-label': 'Select ' + id, checked: selected.has(id),
          onchange: (e) => { if (e.target.checked) selected.add(id); else selected.delete(id); onSelect && onSelect([...selected]); render(); } })) : null,
        columns.map((c) => h('td', { class: c.num ? 'num' : null }, c.render ? c.render(r) : (r[c.key] ?? '—'))));
      })
      : [h('tr', null, h('td', { colspan: String(columns.length + (selectable ? 1 : 0)) }, emptyState(emptyText, null, null, 'filter')))];
    const foot = h('div', { class: 'table-foot' },
      h('span', null, all.length ? `Showing ${page * pageSize + 1}–${page * pageSize + slice.length} of ${all.length}` : '0 rows',
        selectable && selected.size ? ` · ${selected.size} selected` : ''),
      h('div', { class: 'row' },
        button('', () => { page -= 1; render(); }, { kind: 'ghost', iconName: 'chevronLeft', sm: true, title: 'Previous page', disabled: page === 0 }),
        h('span', null, `Page ${page + 1} / ${pages}`),
        button('', () => { page += 1; render(); }, { kind: 'ghost', iconName: 'chevronRight', sm: true, title: 'Next page', disabled: page >= pages - 1 })));
    mount(wrap, h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, caption, h('thead', null, head), h('tbody', null, body))), foot);
  }

  render();
  return {
    el: wrap,
    update(newRows, { resetPage = false } = {}) {
      rows = newRows;
      if (resetPage) page = 0;
      if (getId) {
        const ids = new Set(rows.map(getId));
        [...selected].forEach((id) => { if (!ids.has(id)) selected.delete(id); });
      }
      render();
    },
    setCaption(text) { caption.textContent = text; },
    selected: () => [...selected],
    clearSelection() { selected.clear(); onSelect && onSelect([]); render(); },
  };
}
