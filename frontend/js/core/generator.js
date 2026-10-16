// Deterministic synthetic dataset generator - exact port of
// backend/shared/generator.py. The PRNG must be consumed in the same order;
// tests/unit/test_parity.py compares both implementations.
//
// Every record, company, airport and reference is FICTIONAL. Anomalies are
// deliberately planted data-quality / relationship inconsistencies.

import { Mulberry32, idiv } from './prng.js';
import { formatTs, parseTs } from './timeutil.js';

export const GENERATOR_VERSION = '1.0.0';
export const SOURCE = 'synthetic-generator/' + GENERATOR_VERSION;
const BASE_EPOCH = 1788220800; // 2026-09-01T00:00:00Z
const DAY = 86400;
const HOUR = 3600;
export const MIN_COUNT = 20;
export const MAX_COUNT = 300;
export const MAX_SEED = 4294967295;

export const AIRPORTS = [
  { code: 'PCL1', name: 'Port Calder International (fictional)' },
  { code: 'NVH2', name: 'Northvale Air Cargo Hub (fictional)' },
  { code: 'EHV3', name: 'Esterhaven Regional (fictional)' },
  { code: 'MRL4', name: 'Mirelund Airfield (fictional)' },
  { code: 'SCI5', name: 'Sable Coast International (fictional)' },
  { code: 'HMT6', name: 'Highmoor Cargo Terminal (fictional)' },
  { code: 'QRB7', name: 'Quarry Bay Freight Field (fictional)' },
  { code: 'DLW8', name: 'Dunlow Airport (fictional)' },
];

export const CARRIERS = [
  { entityId: 'CR-01', name: 'Skyward Cargo Lines (fictional)', kind: 'CARRIER' },
  { entityId: 'CR-02', name: 'Meridian Air Freight (fictional)', kind: 'CARRIER' },
  { entityId: 'CR-03', name: 'Polaris Wings Cargo (fictional)', kind: 'CARRIER' },
];

const PREFIXES = [
  'Bright', 'North', 'Silver', 'Cedar', 'Harbor', 'Iron', 'Blue', 'Amber', 'Granite',
  'Willow', 'Falcon', 'Coral', 'Summit', 'Lumen', 'Maple', 'Quartz', 'Orchid', 'Tidal',
];
const SUFFIXES = ['water', 'field', 'line', 'gate', 'crest', 'stone', 'ridge', 'brook'];
const KINDS = [
  'Trading Co.', 'Logistics Ltd.', 'Imports', 'Components', 'Supply Group',
  'Freight Partners', 'Textiles', 'Industries',
];
const COMMODITIES = [
  'Machine parts', 'Textiles', 'Consumer electronics', 'Furniture', 'Packaged foods',
  'Printed books', 'Auto components', 'Garden tools', 'Ceramic tiles', 'Sports equipment',
];
const CURRENCIES = ['USD', 'EUR', 'INR', 'GBP', 'SGD', 'AED'];
const MALFORMED_TIMESTAMPS = [
  '2026-02-30T10:00:00Z',
  '2026-13-04T08:30:00Z',
  '2026-09-31T25:10:00Z',
  '31/09/2026 10:00',
];

export const SCENARIOS = {
  normal: {
    label: 'Normal dataset',
    description: 'Consistent records only. No anomalies are planted; any flag is a false positive.',
  },
  documentation_inconsistency: {
    label: 'Documentation inconsistency',
    description: 'Invoices name different counterparties or currencies than their shipments; some links are broken.',
  },
  duplicate_references: {
    label: 'Duplicate references',
    description: 'Air waybills, invoice numbers or transaction references are copied onto unrelated records.',
  },
  conflicting_amounts: {
    label: 'Conflicting amounts',
    description: 'Invoice and transaction amounts disagree with their linked documents, including a subtle case below the default tolerance.',
  },
  invalid_timestamps: {
    label: 'Invalid or conflicting timestamps',
    description: 'Arrivals before departures, payments long before invoices and malformed timestamps.',
  },
  missing_fields: {
    label: 'Missing mandatory fields',
    description: 'Required fields are removed or blanked on a subset of records.',
  },
  repeated_entities: {
    label: 'Repeated entity references',
    description: 'One fictional consignee is concentrated across many shipments, and invoice references are reused across shipments.',
  },
  mixed: {
    label: 'Mixed normal and anomalous',
    description: 'A mix of every planted pattern at a lower rate among mostly normal records.',
  },
};

export const PATTERN_DESCRIPTIONS = {
  DUPLICATE_REFERENCE: 'Document reference copied from another record of the same type.',
  AMOUNT_CONFLICT: "Invoice amount set far away from the shipment's declared value.",
  AMOUNT_CONFLICT_SUBTLE: 'Invoice amount set 3.6-4.4% above declared value (below the balanced tolerance).',
  TXN_AMOUNT_CONFLICT: 'Transaction amount set to a fraction of the invoice amount.',
  CURRENCY_CONFLICT: 'Invoice (and its payment) switched to a different currency than the shipment.',
  COUNTERPARTY_CONFLICT: "Invoice (and its payment) names a seller that is not the shipment's consignor.",
  ARRIVAL_BEFORE_DEPARTURE: 'Manifest arrival time set before its departure time.',
  PAYMENT_BEFORE_INVOICE: 'Payment value date set 45-120 days before the invoice issue date.',
  MALFORMED_TIMESTAMP: 'Invoice issue date replaced with a malformed timestamp.',
  MISSING_FIELDS: 'One or two required, non-link fields removed or blanked.',
  REFERENCE_REUSE: "A second shipment claims another shipment's invoice, orphaning its own invoice.",
  BROKEN_LINK: 'Transaction points at an invoice ID that does not exist.',
  ENTITY_CONCENTRATION: 'One consignee (with matching invoice buyer and payer) placed on seven shipments.',
};

const MISSABLE = {
  MANIFEST: ['manifestNo', 'flightRef', 'carrierId', 'originAirport', 'destinationAirport', 'departureAt', 'arrivalAt'],
  SHIPMENT: ['awbNumber', 'consignorId', 'consigneeId', 'commodity', 'pieces', 'weightKg', 'declaredValueMinor', 'currency'],
  INVOICE: ['invoiceNo', 'sellerId', 'buyerId', 'amountMinor', 'currency', 'issuedAt'],
  TRANSACTION: ['txnRef', 'payerId', 'payeeId', 'amountMinor', 'currency', 'valueDate'],
};

const REF_FIELD = { MANIFEST: 'manifestNo', SHIPMENT: 'awbNumber', INVOICE: 'invoiceNo', TRANSACTION: 'txnRef' };

export class GeneratorError extends Error {}

export function pad(n, width) {
  const s = String(n);
  return s.length < width ? '0'.repeat(width - s.length) + s : s;
}

export function datasetIdFor(scenario, seed, count) {
  return 'ds-' + scenario.replace(/_/g, '-') + '-s' + seed + '-n' + count;
}

function plan(scenario, s, m) {
  const atLeast1 = (x) => (x > 0 ? x : 1);
  switch (scenario) {
    case 'normal':
      return [];
    case 'documentation_inconsistency':
      return [['COUNTERPARTY_CONFLICT', atLeast1(idiv(s, 8))], ['CURRENCY_CONFLICT', atLeast1(idiv(s, 10))],
        ['BROKEN_LINK', atLeast1(idiv(s, 10))]];
    case 'duplicate_references':
      return [['DUPLICATE_REFERENCE', atLeast1(idiv(s, 6))]];
    case 'conflicting_amounts':
      return [['AMOUNT_CONFLICT', atLeast1(idiv(s, 6))], ['AMOUNT_CONFLICT_SUBTLE', atLeast1(idiv(s, 12))],
        ['TXN_AMOUNT_CONFLICT', atLeast1(idiv(s, 10))]];
    case 'invalid_timestamps':
      return [['ARRIVAL_BEFORE_DEPARTURE', atLeast1(idiv(m, 4))], ['PAYMENT_BEFORE_INVOICE', atLeast1(idiv(s, 10))],
        ['MALFORMED_TIMESTAMP', atLeast1(idiv(s, 10))]];
    case 'missing_fields':
      return [['MISSING_FIELDS', atLeast1(idiv(s, 5))]];
    case 'repeated_entities':
      return [['ENTITY_CONCENTRATION', 1], ['REFERENCE_REUSE', atLeast1(idiv(s, 14))]];
    case 'mixed':
      return [
        ['DUPLICATE_REFERENCE', atLeast1(idiv(s, 14))],
        ['AMOUNT_CONFLICT', atLeast1(idiv(s, 12))],
        ['AMOUNT_CONFLICT_SUBTLE', 1],
        ['TXN_AMOUNT_CONFLICT', atLeast1(idiv(s, 20))],
        ['CURRENCY_CONFLICT', 1],
        ['COUNTERPARTY_CONFLICT', atLeast1(idiv(s, 16))],
        ['ARRIVAL_BEFORE_DEPARTURE', 1],
        ['PAYMENT_BEFORE_INVOICE', 1],
        ['MALFORMED_TIMESTAMP', 1],
        ['MISSING_FIELDS', atLeast1(idiv(s, 14))],
        ['REFERENCE_REUSE', atLeast1(idiv(s, 14))],
        ['BROKEN_LINK', 1],
      ];
    default:
      throw new GeneratorError('unknown scenario');
  }
}

function makeCompanies(rng) {
  const prefixes = rng.sample(PREFIXES, PREFIXES.length);
  return prefixes.map((prefix, i) => {
    const name = prefix + rng.choice(SUFFIXES) + ' ' + rng.choice(KINDS) + ' (fictional)';
    return { entityId: 'CO-' + pad(i + 1, 3), name, kind: 'COMPANY' };
  });
}

export function linkIds(recordType, fields) {
  const keys = {
    MANIFEST: ['carrierId'],
    SHIPMENT: ['manifestId', 'invoiceId', 'consignorId', 'consigneeId'],
    INVOICE: ['shipmentId', 'sellerId', 'buyerId'],
    TRANSACTION: ['invoiceId', 'payerId', 'payeeId'],
  }[recordType];
  const out = [];
  if (recordType === 'MANIFEST' && Array.isArray(fields.shipmentIds)) {
    for (const sid of fields.shipmentIds) {
      if (typeof sid === 'string' && sid && !out.includes(sid)) out.push(sid);
    }
  }
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === 'string' && v.trim() !== '' && !out.includes(v)) out.push(v);
  }
  return out;
}

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

export function generateDataset(scenario = 'mixed', seed = 42, count = 100) {
  if (!Object.prototype.hasOwnProperty.call(SCENARIOS, scenario)) throw new GeneratorError('unknown scenario');
  if (!isInt(seed) || seed < 0 || seed > MAX_SEED) {
    throw new GeneratorError('seed must be an integer between 0 and 4294967295');
  }
  if (!isInt(count) || count < MIN_COUNT || count > MAX_COUNT) {
    throw new GeneratorError('count must be an integer between 20 and 300');
  }

  const rng = new Mulberry32(seed);
  const datasetId = datasetIdFor(scenario, seed, count);
  const companies = makeCompanies(rng);
  const companyIds = companies.map((c) => c.entityId);
  const carrierIds = CARRIERS.map((c) => c.entityId);
  const airportCodes = AIRPORTS.map((a) => a.code);
  const base = BASE_EPOCH + rng.randint(0, 6) * DAY;

  const records = [];
  const chains = [];
  const manifests = [];
  let nMan = 0;
  let nShp = 0;
  let remaining = count;
  let group = 0;

  while (remaining >= 4) {
    let k = rng.randint(2, 4);
    const cap = idiv(remaining - 1, 3);
    if (k > cap) k = cap;
    if (k < 1) break;
    group += 1;
    const groupId = 'G-' + pad(group, 3);
    nMan += 1;
    const manId = 'MAN-' + pad(nMan, 4);
    const route = rng.sample(airportCodes, 2);
    const dep = base + (group - 1) * 6 * HOUR + rng.randint(0, 5) * HOUR;
    const arr = dep + rng.randint(2, 11) * HOUR + rng.randint(0, 3) * 900;
    const manifest = {
      recordId: manId,
      recordType: 'MANIFEST',
      datasetId,
      source: SOURCE,
      groupId,
      createdAt: formatTs(dep - 2 * HOUR),
      fields: {
        manifestNo: 'MNF-26-' + pad(nMan, 4) + String(rng.randint(10, 99)),
        flightRef: 'TS' + String(rng.randint(1000, 9999)),
        carrierId: rng.choice(carrierIds),
        originAirport: route[0],
        destinationAirport: route[1],
        departureAt: formatTs(dep),
        arrivalAt: formatTs(arr),
        shipmentIds: [],
      },
    };
    records.push(manifest);
    manifests.push(manifest);

    for (let j = 0; j < k; j++) {
      nShp += 1;
      const shpId = 'SHP-' + pad(nShp, 4);
      const invId = 'INV-' + pad(nShp, 4);
      const txnId = 'TXN-' + pad(nShp, 4);
      const parties = rng.sample(companyIds, 2);
      const pieces = rng.randint(1, 40);
      const weight = pieces * rng.randint(5, 60);
      const currency = rng.choice(CURRENCIES);
      const declared = rng.randint(120000, 25000000);
      const shipment = {
        recordId: shpId,
        recordType: 'SHIPMENT',
        datasetId,
        source: SOURCE,
        groupId,
        createdAt: formatTs(dep - rng.randint(2, 20) * HOUR),
        fields: {
          awbNumber: 'AWB-' + String(rng.randint(100, 999)) + '-' + pad(nShp, 5) + String(rng.randint(0, 9)),
          manifestId: manId,
          consignorId: parties[0],
          consigneeId: parties[1],
          commodity: rng.choice(COMMODITIES),
          pieces,
          weightKg: weight,
          declaredValueMinor: declared,
          currency,
          invoiceId: invId,
        },
      };
      let bps;
      if (rng.chance(40)) bps = rng.randint(550, 700);
      else bps = rng.randint(-300, 300);
      const invAmount = declared + idiv(declared * bps, 10000);
      const issued = dep - rng.randint(1, 10) * DAY + rng.randint(0, 23) * HOUR;
      const invoice = {
        recordId: invId,
        recordType: 'INVOICE',
        datasetId,
        source: SOURCE,
        groupId,
        createdAt: formatTs(issued),
        fields: {
          invoiceNo: 'INV-DOC-' + pad(nShp, 5) + '-' + String(rng.randint(100, 999)),
          shipmentId: shpId,
          sellerId: parties[0],
          buyerId: parties[1],
          amountMinor: invAmount,
          currency,
          issuedAt: formatTs(issued),
        },
      };
      let valueDate;
      if (rng.randint(0, 99) < 6) valueDate = issued - rng.randint(1, 10) * DAY;
      else valueDate = issued + rng.randint(0, 45) * DAY + rng.randint(0, 23) * HOUR;
      let txnAmount = invAmount;
      if (rng.chance(80)) txnAmount = invAmount - idiv(invAmount * rng.randint(10, 150), 10000);
      const txn = {
        recordId: txnId,
        recordType: 'TRANSACTION',
        datasetId,
        source: SOURCE,
        groupId,
        createdAt: formatTs(valueDate),
        fields: {
          txnRef: 'FTR-' + pad(nShp, 6) + String(rng.randint(10, 99)),
          invoiceId: invId,
          payerId: parties[1],
          payeeId: parties[0],
          amountMinor: txnAmount,
          currency,
          valueDate: formatTs(valueDate),
        },
      };
      manifest.fields.shipmentIds.push(shpId);
      records.push(shipment, invoice, txn);
      chains.push({ manifest, shipment, invoice, txn });
    }
    remaining -= 1 + 3 * k;
  }

  const labels = {};
  for (const rec of records) {
    labels[rec.recordId] = { recordId: rec.recordId, isAnomalous: false, patterns: [], roles: [] };
  }
  const touched = new Set();
  const planted = [];

  const mark = (rec, pattern, role) => {
    const lab = labels[rec.recordId];
    lab.isAnomalous = true;
    lab.patterns.push(pattern);
    lab.roles.push(role);
  };
  const freeChains = () => chains.filter((c) => !touched.has(c.shipment.recordId)
    && !touched.has(c.invoice.recordId) && !touched.has(c.txn.recordId));
  const take = (cands) => (cands.length ? cands[rng.randint(0, cands.length - 1)] : null);
  const touch = (...recs) => recs.forEach((r) => touched.add(r.recordId));

  function plantOne(pattern) {
    switch (pattern) {
      case 'DUPLICATE_REFERENCE': {
        const rtype = rng.choice(['SHIPMENT', 'INVOICE', 'TRANSACTION']);
        const key = { SHIPMENT: 'shipment', INVOICE: 'invoice', TRANSACTION: 'txn' }[rtype];
        const cands = chains.map((c) => c[key]).filter((r) => !touched.has(r.recordId));
        const a = take(cands);
        if (!a) return null;
        const b = take(cands.filter((r) => r.groupId !== a.groupId));
        if (!b) return null;
        const ref = REF_FIELD[rtype];
        b.fields[ref] = a.fields[ref];
        touch(a, b);
        mark(a, pattern, 'counterpart');
        mark(b, pattern, 'altered');
        return [a.recordId, b.recordId];
      }
      case 'AMOUNT_CONFLICT':
      case 'AMOUNT_CONFLICT_SUBTLE': {
        const c = take(freeChains());
        if (!c) return null;
        const declared = c.shipment.fields.declaredValueMinor;
        let bps;
        if (pattern === 'AMOUNT_CONFLICT_SUBTLE') bps = rng.randint(10360, 10440);
        else if (rng.chance(500)) bps = rng.randint(4000, 7000);
        else bps = rng.randint(14000, 19000);
        const amount = idiv(declared * bps, 10000);
        c.invoice.fields.amountMinor = amount;
        c.txn.fields.amountMinor = amount;
        touch(c.invoice, c.txn);
        mark(c.invoice, pattern, 'altered');
        return [c.invoice.recordId];
      }
      case 'TXN_AMOUNT_CONFLICT': {
        const c = take(freeChains());
        if (!c) return null;
        const invAmount = c.invoice.fields.amountMinor;
        c.txn.fields.amountMinor = idiv(invAmount * rng.randint(5000, 8500), 10000);
        touch(c.txn);
        mark(c.txn, pattern, 'altered');
        return [c.txn.recordId];
      }
      case 'CURRENCY_CONFLICT': {
        const c = take(freeChains());
        if (!c) return null;
        const current = c.invoice.fields.currency;
        const newCur = rng.choice(CURRENCIES.filter((x) => x !== current));
        c.invoice.fields.currency = newCur;
        c.txn.fields.currency = newCur;
        touch(c.invoice, c.txn);
        mark(c.invoice, pattern, 'altered');
        return [c.invoice.recordId];
      }
      case 'COUNTERPARTY_CONFLICT': {
        const c = take(freeChains());
        if (!c) return null;
        const sf = c.shipment.fields;
        const others = companyIds.filter((x) => x !== sf.consignorId && x !== sf.consigneeId);
        const newSeller = rng.choice(others);
        c.invoice.fields.sellerId = newSeller;
        c.txn.fields.payeeId = newSeller;
        touch(c.invoice, c.txn);
        mark(c.invoice, pattern, 'altered');
        return [c.invoice.recordId];
      }
      case 'ARRIVAL_BEFORE_DEPARTURE': {
        const mn = take(manifests.filter((x) => !touched.has(x.recordId)));
        if (!mn) return null;
        mn.fields.arrivalAt = formatTs(parseTs(mn.fields.departureAt) - rng.randint(1, 6) * HOUR);
        touch(mn);
        mark(mn, pattern, 'altered');
        return [mn.recordId];
      }
      case 'PAYMENT_BEFORE_INVOICE': {
        const c = take(freeChains());
        if (!c) return null;
        const issued = parseTs(c.invoice.fields.issuedAt);
        c.txn.fields.valueDate = formatTs(issued - rng.randint(45, 120) * DAY);
        touch(c.txn, c.invoice);
        mark(c.txn, pattern, 'altered');
        return [c.txn.recordId];
      }
      case 'MALFORMED_TIMESTAMP': {
        const c = take(freeChains());
        if (!c) return null;
        c.invoice.fields.issuedAt = rng.choice(MALFORMED_TIMESTAMPS);
        touch(c.invoice, c.txn);
        mark(c.invoice, pattern, 'altered');
        return [c.invoice.recordId];
      }
      case 'MISSING_FIELDS': {
        const r = take(records.filter((x) => !touched.has(x.recordId)));
        if (!r) return null;
        const n = rng.randint(1, 2);
        const drop = rng.sample(MISSABLE[r.recordType], n);
        for (const f of drop) {
          if (rng.chance(500)) delete r.fields[f];
          else r.fields[f] = '';
        }
        touch(r);
        mark(r, pattern, 'altered');
        return [r.recordId];
      }
      case 'REFERENCE_REUSE': {
        const free = freeChains();
        const a = take(free);
        if (!a) return null;
        const b = take(free.filter((c) => c.manifest.recordId !== a.manifest.recordId));
        if (!b) return null;
        b.shipment.fields.invoiceId = a.invoice.recordId;
        touch(a.shipment, a.invoice, b.shipment, b.invoice);
        mark(a.shipment, pattern, 'counterpart');
        mark(b.shipment, pattern, 'altered');
        mark(b.invoice, pattern, 'orphaned');
        return [a.shipment.recordId, b.shipment.recordId, b.invoice.recordId];
      }
      case 'BROKEN_LINK': {
        const c = take(freeChains());
        if (!c) return null;
        c.txn.fields.invoiceId = 'INV-' + pad(9000 + rng.randint(0, 99), 4);
        touch(c.txn);
        mark(c.txn, pattern, 'altered');
        return [c.txn.recordId];
      }
      case 'ENTITY_CONCENTRATION': {
        const target = rng.choice(companyIds);
        const free = freeChains().filter((c) => c.shipment.fields.consigneeId !== target
          && c.shipment.fields.consignorId !== target);
        const picked = rng.sample(free, 7);
        if (picked.length < 7) return null;
        const ids = [];
        for (const c of picked) {
          c.shipment.fields.consigneeId = target;
          c.invoice.fields.buyerId = target;
          c.txn.fields.payerId = target;
          touch(c.shipment, c.invoice, c.txn);
          mark(c.shipment, pattern, 'altered');
          ids.push(c.shipment.recordId);
        }
        return ids;
      }
      default:
        throw new GeneratorError('unknown pattern');
    }
  }

  for (const [pattern, instances] of plan(scenario, chains.length, manifests.length)) {
    for (let i = 0; i < instances; i++) {
      const affected = plantOne(pattern);
      planted.push({
        pattern,
        instance: i + 1,
        applied: affected !== null,
        recordIds: affected || [],
        description: PATTERN_DESCRIPTIONS[pattern],
      });
    }
  }

  for (const rec of records) rec.linkedEntityIds = linkIds(rec.recordType, rec.fields);
  const labelList = records.map((r) => labels[r.recordId]);
  const meta = {
    datasetId,
    scenario,
    scenarioLabel: SCENARIOS[scenario].label,
    scenarioDescription: SCENARIOS[scenario].description,
    seed,
    requestedCount: count,
    recordCount: records.length,
    generatorVersion: GENERATOR_VERSION,
    plantedPatterns: planted,
    anomalousRecordCount: labelList.filter((l) => l.isAnomalous).length,
    entities: companies.concat(CARRIERS.map((c) => ({ ...c }))),
    airports: AIRPORTS.map((a) => ({ ...a })),
    notice: 'All records, companies, airports and references are fictional and deliberately constructed for testing.',
  };
  return { meta, records, labels: labelList };
}
