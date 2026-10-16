import { h, mount } from '../ui/dom.js';
import {
  pageHead, card, button, field, select, callout, badge, toast, toastError, confirmDialog, fmtDate, chip,
} from '../ui/components.js';
import { SCENARIOS } from '../core/generator.js';
import { resolveProfile } from '../core/scoring.js';

const gen = { scenario: 'mixed', seed: 42, count: 100 };

export async function render(app, main, ctx) {
  const ds = app.currentDataset();

  // ---------------- mode
  const awsOk = app.awsConfigured();
  const modeCard = card('Data mode', h('div', { class: 'stack' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Data mode' },
      h('button', { type: 'button', 'aria-pressed': String(app.mode === 'local'), onclick: () => app.mode !== 'local' && app.switchMode('local') }, 'Local demo'),
      h('button', { type: 'button', 'aria-pressed': String(app.mode === 'aws'), disabled: !awsOk, onclick: () => app.mode !== 'aws' && app.switchMode('aws') }, 'AWS (live)')),
    app.mode === 'local'
      ? callout(['Local demo mode runs the generator, scoring engine, queue and worker ', h('strong', null, 'in this browser'),
        '. Data persists in this browser only. Nothing is sent to AWS.'], '')
      : callout(['AWS mode stores everything in the deployed backend (' + app.config.region + '). Failed requests are reported, never replaced with local data.'], 'good'),
    !awsOk ? h('p', { class: 'small muted' }, 'AWS mode is unavailable because frontend/js/config.js has no deployment values. Run scripts/deploy.py to deploy and fill it.') : null,
    h('dl', { class: 'kv' },
      h('dt', null, 'Signed-in identity'), h('dd', null, app.identity ? h('code', null, app.identity.sub) : '—'),
      h('dt', null, 'Roles'), h('dd', null, app.identity ? app.identity.roles.map((r) => badge(r, r === 'admin' ? 'red' : r === 'analyst' ? 'blue' : 'slate')) : '—'),
      app.mode === 'aws' ? [h('dt', null, 'Session'), h('dd', null, button('Sign out', () => app.auth.signOut(), { sm: true, iconName: 'logout' }))] : null)));

  // ---------------- local role simulator
  const roleCard = app.mode === 'local' ? card('Simulated role (local only)', h('div', { class: 'stack' },
    field('Act as', select([['admin', 'Admin — everything incl. dataset reset'], ['analyst', 'Analyst — process, cases, comments'], ['viewer', 'Viewer — read-only']],
      (app.identity.roles.includes('admin') ? 'admin' : app.identity.roles.includes('analyst') ? 'analyst' : 'viewer'),
      async (v) => { await app.provider.setRole(v); app.identity = await app.provider.getIdentity(); toast('Role changed', 'Now acting as ' + v + ' (local simulation).'); app.navigate('#/settings'); })),
    h('p', { class: 'small muted' }, 'Lets you see authorization in action: as a viewer, write actions are refused (and audited). In AWS mode roles come only from your Cognito group membership, verified by the API.'),
    h('div', { class: 'row' }, button('Erase all local demo data', async () => {
      if (await confirmDialog('Erase local demo data?', 'This clears every dataset, job, case and audit event stored in THIS browser for local mode. AWS data is not affected.', 'Erase local data', true)) {
        await app.provider.wipeLocalData();
        await app.refreshDatasets();
        toast('Local data erased', null, 'good');
        app.navigate('#/settings');
      }
    }, { kind: 'danger', iconName: 'reset' })))) : null;

  // ---------------- generation
  const scenarioHelp = h('p', { class: 'small muted' }, SCENARIOS[gen.scenario].description);
  const seedInput = h('input', { class: 'input', type: 'number', min: '0', max: '4294967295', step: '1', value: String(gen.seed), oninput: (e) => { gen.seed = e.target.value; } });
  const countInput = h('input', { class: 'input', type: 'number', min: '20', max: '300', step: '1', value: String(gen.count), oninput: (e) => { gen.count = e.target.value; } });
  const genCard = card('Generate synthetic dataset', h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      const seed = Number(gen.seed);
      const count = Number(gen.count);
      seedInput.removeAttribute('aria-invalid');
      countInput.removeAttribute('aria-invalid');
      if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) { seedInput.setAttribute('aria-invalid', 'true'); seedInput.focus(); return; }
      if (!Number.isInteger(count) || count < 20 || count > 300) { countInput.setAttribute('aria-invalid', 'true'); countInput.focus(); return; }
      try {
        const res = await app.provider.seedDataset({ scenario: gen.scenario, seed, count });
        toast(res.created ? 'Dataset generated' : 'Dataset already exists', res.dataset.datasetId + ' · ' + res.dataset.recordCount + ' records, ' + res.dataset.anomalousRecordCount + ' with planted anomalies', 'good');
        await app.refreshDatasets();
        await app.setDataset(res.dataset.datasetId);
      } catch (err) { toastError(err, 'Generation failed'); }
    },
  },
  h('div', { class: 'form-grid' },
    field('Scenario', select(Object.entries(SCENARIOS).map(([k, s]) => [k, s.label]), gen.scenario, (v) => { gen.scenario = v; scenarioHelp.textContent = SCENARIOS[v].description; })),
    field('Seed', seedInput, '0 – 4294967295; same seed ⇒ same data'),
    field('Records', countInput, '20 – 300')),
  scenarioHelp,
  h('div', { class: 'row' }, button('Generate', null, { type: 'submit', kind: 'primary', iconName: 'plus', disabled: !app.can('analyst') }),
    !app.can('analyst') ? h('span', { class: 'small muted' }, 'Requires analyst role') : null),
  callout('These are deliberately constructed test scenarios. All companies, airports, flights and financial references are fictional; the planted anomalies are generic data-quality and relationship inconsistencies.', 'info')),
  { sub: 'deterministic' });

  // ---------------- dataset list
  const dsCard = card('Datasets', app.datasets.length
    ? h('ul', { class: 'list-plain' }, app.datasets.map((d) => h('li', null,
      h('div', { class: 'row between' },
        h('div', null, h('strong', null, d.scenarioLabel), ' ', d.datasetId === app.datasetId ? badge('active', 'green') : null,
          h('div', { class: 'small muted' }, h('code', null, d.datasetId), ' · ' + d.recordCount + ' records · ' + d.anomalousRecordCount + ' planted · ' + fmtDate(d.createdAt))),
        h('div', { class: 'row' },
          d.datasetId !== app.datasetId ? button('Select', () => app.setDataset(d.datasetId), { sm: true }) : null,
          button('Reset', async () => {
            const ok = await confirmDialog('Reset demo dataset?', 'Deletes only the synthetic records and labels of ' + d.datasetId + '. Cases are archived (kept, read-only) and all audit events are preserved. Other datasets are untouched.', 'Reset dataset', true);
            if (!ok) return;
            try {
              const r = await app.provider.resetDataset(d.datasetId);
              toast('Dataset reset', r.recordsRemoved + ' records removed, ' + r.casesArchived + ' cases archived.', 'good');
              await app.refreshDatasets();
              app.navigate('#/settings');
            } catch (err) { toastError(err, 'Reset failed'); }
          }, { sm: true, kind: 'danger', iconName: 'reset', disabled: !app.can('admin'), title: app.can('admin') ? null : 'Requires admin role' }))))))
    : h('p', { class: 'muted' }, 'No datasets yet.'), { sub: 'max 8' });

  // ---------------- rules
  const profiles = Object.keys(app.rules.profiles).map((p) => resolveProfile(app.rules, p));
  const rulesTable = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('caption', { class: 'sr-only' }, 'Rule weights per profile'),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Rule'), h('th', { scope: 'col' }, 'What it checks'),
      ...profiles.map((p) => h('th', { scope: 'col', class: 'num' }, app.rules.profiles[p.profile].label)))),
    h('tbody', null, app.rules.rules.map((r) => h('tr', null,
      h('td', { class: 'nowrap' }, h('code', null, r.id), ' ', r.title),
      h('td', { class: 'small' }, r.description),
      ...profiles.map((p) => h('td', { class: 'num' }, '+' + p.weights[r.id])))),
    h('tr', null, h('td', null, h('strong', null, 'Flag threshold')), h('td', { class: 'small' }, 'Score at or above which a record is flagged for review'),
      ...profiles.map((p) => h('td', { class: 'num' }, '≥ ' + p.flagMinScore))),
    h('tr', null, h('td', null, h('strong', null, 'Levels')), h('td', { class: 'small' }, 'Minimum score for each level'),
      ...profiles.map((p) => h('td', { class: 'num small' }, p.levels.filter((l) => l.minScore > 0).map((l) => l.name[0] + l.name.slice(1).toLowerCase() + ' ≥' + l.minScore).join(', ')))),
    h('tr', null, h('td', null, h('strong', null, 'Tolerances')), h('td', { class: 'small' }, 'Invoice↔shipment / transaction↔invoice amount tolerance; consignee concentration'),
      ...profiles.map((p) => h('td', { class: 'num small' }, (p.params.invoiceShipmentToleranceBps / 100) + '% / ' + (p.params.txnInvoiceToleranceBps / 100) + '% / ≥' + p.params.concentrationMinShipments))))));
  const rulesCard = card('Risk rules', h('div', { class: 'stack' },
    callout([h('strong', null, 'Illustrative only. '), app.rules.disclaimer]),
    h('p', { class: 'small muted' }, 'Ruleset ', h('code', null, app.rules.rulesetVersion), ' · engine ', h('code', null, app.rules.engineVersion),
      ' · source of truth: backend/shared/risk_rules.json · records at level ', badge(app.rules.autoCaseMinLevel, 'red'), ' open a case automatically. Score = sum of fired rule weights, capped at 100.'),
    rulesTable), { sub: 'same file drives the Python worker and the browser' });

  // ---------------- deployment info
  const c = app.config;
  const deployCard = card('AWS configuration (public identifiers)', h('div', { class: 'stack' },
    h('dl', { class: 'kv' },
      ...[['Region', c.region], ['Stack', c.stackName], ['API (Function URL)', c.apiUrl], ['User pool', c.userPoolId], ['App client (public, no secret)', c.userPoolClientId],
        ['Identity pool', c.identityPoolId], ['Cognito domain', c.cognitoDomain], ['Deployed', c.deployedAt]]
        .flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v ? h('code', { class: 'small' }, v) : h('span', { class: 'muted' }, 'not configured'))])),
    h('p', { class: 'small muted' }, 'These values are not secrets and grant nothing by themselves: the API requires identity-pool credentials of a signed-in user (checked by AWS IAM) and verifies the Cognito access token itself.')));

  mount(main,
    pageHead('Settings', 'Data mode, identity, synthetic data generation and the rule configuration.'),
    h('div', { class: 'grid cols-2' }, h('div', { class: 'stack' }, modeCard, roleCard, deployCard), h('div', { class: 'stack' }, genCard, dsCard)),
    h('div', { class: 'mt-12' }, rulesCard),
    ds ? h('p', { class: 'small muted mt-12' }, 'Active dataset ', chip(ds.datasetId, () => app.navigate('#/overview'))) : null);
}
