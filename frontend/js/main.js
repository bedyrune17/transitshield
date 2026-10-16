// TransitShield application shell: mode selection, routing, top bar.
import config from './config.js';
import { h, mount } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { button, errorState, loading, select, toast, toastError, emptyState, callout } from './ui/components.js';
import { LocalProvider } from './data/localProvider.js';
import { AwsProvider } from './data/awsProvider.js';
import { CognitoAuth } from './auth/cognito.js';

import * as overview from './views/overview.js';
import * as records from './views/records.js';
import * as investigations from './views/investigations.js';
import * as relationships from './views/relationships.js';
import * as queue from './views/queue.js';
import * as evaluationView from './views/evaluation.js';
import * as auditView from './views/audit.js';
import * as settings from './views/settings.js';

const ROUTES = [
  { path: 'overview', label: 'Overview', icon: 'overview', view: overview },
  { path: 'records', label: 'Records', icon: 'records', view: records },
  { path: 'investigations', label: 'Investigations', icon: 'cases', view: investigations },
  { path: 'relationships', label: 'Relationship Explorer', icon: 'graph', view: relationships },
  { path: 'queue', label: 'Processing Queue', icon: 'queue', view: queue },
  { path: 'evaluation', label: 'Risk Evaluation', icon: 'evaluation', view: evaluationView },
  { path: 'audit', label: 'Audit History', icon: 'audit', view: auditView },
  { path: 'settings', label: 'Settings', icon: 'settings', view: settings },
];

const MODE_KEY = 'transitshield.mode';
const DATASET_KEY = 'transitshield.dataset';
const pref = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* optional */ } },
};

const app = {
  config,
  auth: new CognitoAuth(config),
  rules: null,
  provider: null,
  mode: 'local',
  identity: null,
  datasets: [],
  datasetId: null,
  leaveHandlers: [],
  renderToken: 0,

  awsConfigured() { return this.auth.configured(); },
  can(role) { return Boolean(this.identity && this.identity.roles && this.identity.roles.includes(role)); },
  currentDataset() { return this.datasets.find((d) => d.datasetId === this.datasetId) || null; },
  onLeave(fn) { this.leaveHandlers.push(fn); },
  navigate(hash) {
    if (window.location.hash === hash) render();
    else window.location.hash = hash;
  },

  async setDataset(id) {
    this.datasetId = id;
    pref.set(DATASET_KEY + '.' + this.mode, id);
    renderTopbar();
    await render();
  },

  async refreshDatasets() {
    this.datasets = await this.provider.listDatasets();
    if (!this.datasets.some((d) => d.datasetId === this.datasetId)) {
      const saved = pref.get(DATASET_KEY + '.' + this.mode);
      this.datasetId = (this.datasets.find((d) => d.datasetId === saved) || this.datasets[0] || {}).datasetId || null;
    }
    renderTopbar();
    return this.datasets;
  },

  async switchMode(mode) {
    if (mode === 'aws' && !this.awsConfigured()) {
      toast('AWS mode unavailable', 'This build has no AWS configuration (frontend/js/config.js is empty).', 'warn');
      return;
    }
    pref.set(MODE_KEY, mode);
    await boot();
    if (mode === 'local') toast('Switched to local demo mode', 'Data shown is generated in this browser, not live AWS data.', 'warn');
  },
};

// ------------------------------------------------------------------ chrome
function renderNav() {
  const current = currentRoute().route.path;
  mount(document.getElementById('nav'), ROUTES.map((r) => h('a', {
    href: '#/' + r.path, 'aria-current': r.path === current ? 'page' : null,
    onclick: () => document.getElementById('sidebar').classList.remove('open'),
  }, icon(r.icon), r.label)));
  mount(document.getElementById('sidebar-foot'),
    h('div', null, 'Synthetic data only. Scores are illustrative and are not evidence of wrongdoing.'),
    h('div', { class: 'mt-8' }, 'Rules ', h('code', null, app.rules ? app.rules.rulesetVersion : '…')));
}

function modePill() {
  if (app.mode === 'aws') {
    return h('span', { class: 'mode-pill aws', title: 'Data is read from and written to the AWS backend' }, icon('cloud'), 'AWS · live');
  }
  return h('span', { class: 'mode-pill local', title: 'All data is generated and processed in this browser' }, icon('laptop'), 'Local demo');
}

function renderTopbar() {
  const top = document.getElementById('topbar');
  const dsSelect = app.datasets.length
    ? select(app.datasets.map((d) => [d.datasetId, d.scenarioLabel + ' · seed ' + d.seed + ' · ' + d.recordCount + ' records']),
      app.datasetId, (v) => app.setDataset(v), { 'aria-label': 'Active dataset' })
    : h('span', { class: 'muted small' }, 'No dataset yet');
  if (dsSelect.tagName === 'SELECT') dsSelect.style.maxWidth = '360px';
  let user = null;
  if (app.identity) {
    const name = app.identity.username || app.identity.sub;
    user = h('div', { class: 'user-chip' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, String(name).slice(0, 2).toUpperCase()),
      h('span', null, name, h('span', { class: 'muted' }, ' · ' + (app.identity.roles || []).slice(-1)[0])),
      app.mode === 'aws' ? button('Sign out', () => app.auth.signOut(), { kind: 'ghost', iconName: 'logout', sm: true }) : null);
  }
  mount(top,
    button('', () => document.getElementById('sidebar').classList.toggle('open'), { kind: 'ghost', iconName: 'menu', title: 'Toggle navigation', ariaLabel: 'Toggle navigation' }),
    modePill(), dsSelect, h('span', { class: 'spacer' }), user);
  top.firstChild.classList.add('menu-btn');
}

function renderNotice() {
  const bar = document.getElementById('notice-bar');
  if (app.mode === 'aws') {
    mount(bar, h('strong', null, 'AWS mode: '), 'records, jobs, cases and audit events are stored in the TransitShield backend (' + config.region + '). ',
      'Values tagged ', h('span', { class: 'source-tag aws' }, 'Live AWS'), ' come directly from SQS / CloudWatch.');
  } else {
    const warn = app.provider && app.provider.storageWarning ? ' ' + app.provider.storageWarning : '';
    mount(bar, h('strong', null, 'Local demo mode: '), 'all data is generated and processed in this browser; the queue and worker are ',
      h('span', { class: 'source-tag sim' }, 'Simulated'), '. Nothing on screen is AWS data.' + warn);
  }
}

// ------------------------------------------------------------------ routing
function currentRoute() {
  const raw = (window.location.hash || '#/overview').slice(2);
  const [pathPart, queryPart] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const route = ROUTES.find((r) => r.path === segs[0]) || ROUTES[0];
  return { route, params: segs.slice(1), query: new URLSearchParams(queryPart || '') };
}

async function render() {
  const token = ++app.renderToken;
  app.leaveHandlers.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
  renderNav();
  renderNotice();
  const main = document.getElementById('main');
  const { route, params, query } = currentRoute();
  document.title = route.label + ' · TransitShield';
  if (!app.provider) {
    mount(main, signInScreen());
    return;
  }
  mount(main, loading());
  try {
    await route.view.render(app, main, { params, query, isCurrent: () => token === app.renderToken });
  } catch (err) {
    if (token !== app.renderToken) return;
    console.error('[TransitShield] view error', err);
    mount(main, errorState(err, () => render()));
  }
}

function signInScreen() {
  return h('div', { class: 'stack' },
    h('div', { class: 'card' }, h('div', { class: 'card-body' },
      emptyState('Sign in to use AWS mode',
        'AWS mode reads and writes live data in the TransitShield backend. Sign in with your Cognito account (Authorization Code + PKCE). You can also continue in local demo mode, which needs no account.',
        [button('Sign in with Cognito', () => app.auth.signIn().catch(toastError), { kind: 'primary', iconName: 'login' }),
          button('Use local demo mode', () => app.switchMode('local'), { iconName: 'laptop' })], 'shield'))),
    callout(['Access to the API requires ', h('strong', null, 'both'),
      ' short-lived AWS credentials from the Cognito identity pool (checked by AWS before the function runs) and a Cognito access token that the API verifies itself. Sign-in does not grant write access unless your account is in the analysts or admins group.'], 'info'));
}

// ------------------------------------------------------------------ boot
async function boot() {
  if (app.provider) app.provider.destroy();
  app.provider = null;
  app.identity = null;
  app.datasets = [];
  app.datasetId = null;
  let mode = pref.get(MODE_KEY) || 'local';
  if (mode === 'aws' && !app.awsConfigured()) mode = 'local';

  try {
    if (await app.auth.handleRedirect()) {
      mode = 'aws';
      pref.set(MODE_KEY, 'aws');
      toast('Signed in', 'AWS mode is active.', 'good');
    }
  } catch (err) {
    toastError(err, 'Sign-in failed');
  }
  app.mode = mode;

  if (mode === 'aws') {
    if (!app.auth.isSignedIn()) {
      renderTopbar();
      await render();
      return;
    }
    app.provider = new AwsProvider(config, app.auth);
  } else {
    app.provider = new LocalProvider(app.rules);
  }

  try {
    app.identity = await app.provider.getIdentity();
    await app.refreshDatasets();
  } catch (err) {
    renderTopbar();
    renderNav();
    renderNotice();
    const main = document.getElementById('main');
    mount(main, h('div', { class: 'stack' }, errorState(err, () => boot()),
      mode === 'aws' ? callout(['The AWS backend could not be reached. This app does not silently fall back to fake data. ',
        button('Switch to local demo mode', () => app.switchMode('local'), { sm: true }), ' ',
        button('Sign in again', () => { app.auth.clearLocalSession(); app.auth.signIn(); }, { sm: true })], 'bad') : null));
    return;
  }
  renderTopbar();
  await render();
}

async function start() {
  try {
    const res = await fetch('data/risk_rules.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    app.rules = await res.json();
  } catch (err) {
    mount(document.getElementById('main'), errorState({ message: 'Could not load data/risk_rules.json (' + err.message + '). Serve the frontend over HTTP, e.g. python scripts/serve_frontend.py.' }));
    return;
  }
  window.addEventListener('hashchange', render);
  await boot();
}

start();
