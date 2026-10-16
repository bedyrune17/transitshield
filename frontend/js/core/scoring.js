// Deterministic, explainable rule-based scoring - exact port of
// backend/shared/scoring.py. Ground-truth labels are never an input.

import { idiv } from './prng.js';
import { parseTs } from './timeutil.js';

export function resolveProfile(config, profile) {
  const name = profile || config.defaultProfile;
  const prof = config.profiles[name];
  if (!prof) throw new Error('unknown scoring profile');
  const weights = {};
  for (const r of config.rules) weights[r.id] = r.weight;
  Object.assign(weights, prof.weights || {});
  const params = { ...config.params, ...(prof.params || {}) };
  return {
    profile: name,
    rules: config.rules,
    weights,
    params,
    levels: prof.levels || config.levels,
    flagMinScore: prof.flagMinScore !== undefined ? prof.flagMinScore : config.flagMinScore,
    requiredFields: config.requiredFields,
    refField: config.documentReferenceField,
    currencies: config.reference.currencies,
    airports: config.reference.airports,
    version: 'engine-' + config.engineVersion + '/rules-' + config.rulesetVersion + '/' + name,
  };
}

export function isMissing(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const nn = (v) => (v === undefined ? null : v);

export function fmtValue(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : '(unsupported value)';
  if (typeof v === 'string') return '"' + v + '"';
  if (v === null || v === undefined) return 'null';
  return '(unsupported value)';
}

function group3(n) {
  let s = String(n);
  let out = '';
  while (s.length > 3) {
    out = ',' + s.slice(-3) + out;
    s = s.slice(0, -3);
  }
  return s + out;
}

export function fmtMoney(minor, currency) {
  const sign = minor < 0 ? '-' : '';
  const m = minor < 0 ? -minor : minor;
  const cents = m % 100;
  return sign + group3(idiv(m, 100)) + '.' + (cents < 10 ? '0' : '') + String(cents) + ' ' + currency;
}

export function fmtBps(bps) {
  const tenths = idiv(bps + 5, 10);
  return String(idiv(tenths, 10)) + '.' + String(tenths % 10) + '%';
}

const REF_FIELD = { MANIFEST: 'manifestNo', SHIPMENT: 'awbNumber', INVOICE: 'invoiceNo', TRANSACTION: 'txnRef' };

export function buildContext(records) {
  const byId = new Map();
  const refIndex = new Map();
  const shipmentClaims = new Map();
  const txnClaims = new Map();
  const consigneeCounts = new Map();
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const r of records) byId.set(r.recordId, r);
  for (const r of records) {
    const f = r.fields || {};
    const refField = REF_FIELD[r.recordType];
    if (refField && isStr(f[refField])) push(refIndex, r.recordType + '|' + f[refField], r.recordId);
    if (r.recordType === 'SHIPMENT') {
      if (isStr(f.invoiceId)) push(shipmentClaims, f.invoiceId, r.recordId);
      if (isStr(f.consigneeId)) consigneeCounts.set(f.consigneeId, (consigneeCounts.get(f.consigneeId) || 0) + 1);
    }
    if (r.recordType === 'TRANSACTION' && isStr(f.invoiceId)) push(txnClaims, f.invoiceId, r.recordId);
  }
  return { byId, refIndex, shipmentClaims, txnClaims, consigneeCounts };
}

function linked(ctx, rid, rtype) {
  if (!isStr(rid)) return null;
  const r = ctx.byId.get(rid);
  if (!r || r.recordType !== rtype) return null;
  return r;
}

const others = (ids, selfId) => ids.filter((i) => i !== selfId).sort();

function checkMissing(rec, cfg, out) {
  const f = rec.fields || {};
  const missing = (cfg.requiredFields[rec.recordType] || []).filter((name) => isMissing(f[name]));
  if (missing.length) {
    out.R01 = {
      explanations: ['Required field(s) missing or empty: ' + missing.join(', ') + '.'],
      evidence: missing.map((name) => ({ field: name, issue: 'missing' })),
    };
  }
}

function checkInvalid(rec, cfg, out) {
  const f = rec.fields || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
  const expl = [];
  const ev = [];
  const bad = (field, reason) => {
    expl.push(field + ' ' + reason + ' (found ' + fmtValue(f[field]) + ').');
    ev.push({ field, issue: 'invalid', value: nn(f[field]) });
  };
  for (const name of ['pieces', 'weightKg', 'declaredValueMinor', 'amountMinor']) {
    if (has(name) && !isMissing(f[name]) && !isPosInt(f[name])) bad(name, 'must be a positive whole number');
  }
  if (has('currency') && !isMissing(f.currency) && !cfg.currencies.includes(f.currency)) {
    bad('currency', 'is not an allowed currency code');
  }
  for (const name of ['departureAt', 'arrivalAt', 'issuedAt', 'valueDate']) {
    if (has(name) && !isMissing(f[name]) && parseTs(f[name]) === null) {
      bad(name, 'is not a valid UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)');
    }
  }
  if (rec.recordType === 'MANIFEST') {
    for (const name of ['originAirport', 'destinationAirport']) {
      if (has(name) && !isMissing(f[name]) && !cfg.airports.includes(f[name])) {
        bad(name, 'is not a known (fictional) airport code');
      }
    }
    const o = f.originAirport;
    const d = f.destinationAirport;
    if (isStr(o) && isStr(d) && o === d) {
      expl.push('Origin and destination airports are identical (' + o + ').');
      ev.push({ field: 'destinationAirport', issue: 'equals origin', value: d });
    }
  }
  if (expl.length) out.R10 = { explanations: expl, evidence: ev };
}

function checkDuplicate(rec, cfg, ctx, out) {
  const field = cfg.refField[rec.recordType];
  const f = rec.fields || {};
  if (!field || !isStr(f[field])) return;
  const ids = ctx.refIndex.get(rec.recordType + '|' + f[field]) || [];
  const o = others(ids, rec.recordId);
  if (o.length) {
    out.R02 = {
      explanations: [field + ' "' + f[field] + '" also appears on ' + o.join(', ') + '.'],
      evidence: [{ field, value: f[field], relatedRecordIds: o }],
    };
  }
}

function checkAmountsCurrencyPartiesDates(rec, cfg, ctx, out) {
  const f = rec.fields || {};
  const p = cfg.params;

  const compareAmount = (aName, a, linkedId, linkedLabel, bName, b, tol, cur) => {
    if (!(isPosInt(a) && isPosInt(b))) return;
    const diff = a > b ? a - b : b - a;
    const base = a > b ? a : b;
    if (diff * 10000 > tol * base) {
      const bps = idiv(diff * 10000, base);
      out.R03 = {
        explanations: [aName + ' ' + fmtMoney(a, cur) + ' differs from ' + linkedLabel + ' ' + linkedId + ' '
          + bName + ' ' + fmtMoney(b, cur) + ' by ' + fmtBps(bps) + ' (tolerance ' + fmtBps(tol) + ').'],
        evidence: [{ field: 'amountMinor', value: a, relatedRecordId: linkedId, relatedField: bName,
          relatedValue: b, differenceBps: bps, toleranceBps: tol }],
      };
    }
  };

  const compareCurrency = (cur, link, linkedLabel) => {
    const lc = link.fields.currency;
    if (isStr(cur) && isStr(lc) && cur !== lc) {
      out.R04 = {
        explanations: ['Currency ' + cur + ' differs from ' + linkedLabel + ' ' + link.recordId + ' currency ' + lc + '.'],
        evidence: [{ field: 'currency', value: cur, relatedRecordId: link.recordId, relatedValue: lc }],
      };
      return false;
    }
    return isStr(cur) && isStr(lc);
  };

  const compareParties = (pairs, link, linkedLabel) => {
    const expl = [];
    const ev = [];
    const lf = link.fields;
    for (const [mine, theirs, mineLabel, theirLabel] of pairs) {
      const a = f[mine];
      const b = lf[theirs];
      if (isStr(a) && isStr(b) && a !== b) {
        expl.push(mineLabel + ' ' + a + ' does not match ' + linkedLabel + ' ' + link.recordId + ' ' + theirLabel + ' ' + b + '.');
        ev.push({ field: mine, value: a, relatedRecordId: link.recordId, relatedField: theirs, relatedValue: b });
      }
    }
    if (expl.length) out.R06 = { explanations: expl, evidence: ev };
  };

  if (rec.recordType === 'INVOICE') {
    const ship = linked(ctx, f.shipmentId, 'SHIPMENT');
    if (ship) {
      if (compareCurrency(f.currency, ship, 'shipment')) {
        compareAmount('Invoice amount', f.amountMinor, ship.recordId, 'shipment', 'declared value',
          ship.fields.declaredValueMinor, p.invoiceShipmentToleranceBps, f.currency);
      }
      compareParties([['sellerId', 'consignorId', 'Invoice seller', 'consignor'],
        ['buyerId', 'consigneeId', 'Invoice buyer', 'consignee']], ship, 'shipment');
    }
  } else if (rec.recordType === 'TRANSACTION') {
    const inv = linked(ctx, f.invoiceId, 'INVOICE');
    if (inv) {
      if (compareCurrency(f.currency, inv, 'invoice')) {
        compareAmount('Transaction amount', f.amountMinor, inv.recordId, 'invoice', 'amount',
          inv.fields.amountMinor, p.txnInvoiceToleranceBps, f.currency);
      }
      compareParties([['payeeId', 'sellerId', 'Payee', 'seller'], ['payerId', 'buyerId', 'Payer', 'buyer']], inv, 'invoice');
      const vd = parseTs(f.valueDate);
      const issued = parseTs(inv.fields.issuedAt);
      if (vd !== null && issued !== null && issued - vd > p.maxPrepaymentDays * 86400) {
        const days = idiv(issued - vd, 86400);
        out.R05 = {
          explanations: ['Payment value date ' + f.valueDate + ' precedes invoice ' + inv.recordId + ' issue date '
            + inv.fields.issuedAt + ' by ' + days + ' days (allowed prepayment window ' + p.maxPrepaymentDays + ' days).'],
          evidence: [{ field: 'valueDate', value: f.valueDate, relatedRecordId: inv.recordId, relatedField: 'issuedAt',
            relatedValue: inv.fields.issuedAt, days }],
        };
      }
    }
  } else if (rec.recordType === 'MANIFEST') {
    const dep = parseTs(f.departureAt);
    const arr = parseTs(f.arrivalAt);
    if (dep !== null && arr !== null && arr <= dep) {
      out.R05 = {
        explanations: ['Arrival ' + f.arrivalAt + ' is not after departure ' + f.departureAt + '.'],
        evidence: [{ field: 'arrivalAt', value: f.arrivalAt, relatedField: 'departureAt', relatedValue: f.departureAt }],
      };
    }
  }
}

function checkReuse(rec, ctx, out) {
  const f = rec.fields || {};
  const inv = f.invoiceId;
  if (!isStr(inv)) return;
  let claims;
  let label;
  if (rec.recordType === 'SHIPMENT') {
    claims = ctx.shipmentClaims.get(inv) || [];
    label = 'shipment(s)';
  } else if (rec.recordType === 'TRANSACTION') {
    claims = ctx.txnClaims.get(inv) || [];
    label = 'transaction(s)';
  } else {
    return;
  }
  const o = others(claims, rec.recordId);
  if (o.length) {
    out.R07 = {
      explanations: ['Invoice ' + inv + ' is also claimed by ' + label + ' ' + o.join(', ') + '.'],
      evidence: [{ field: 'invoiceId', value: inv, relatedRecordIds: o }],
    };
  }
}

function checkLinks(rec, ctx, out) {
  const f = rec.fields || {};
  const rid = rec.recordId;
  const expl = [];
  const ev = [];
  const missingLink = (field, target, label) => {
    expl.push('Linked ' + label + ' ' + target + ' does not exist in the dataset.');
    ev.push({ field, value: target, issue: 'not found' });
  };
  const nonReciprocal = (field, target, text) => {
    expl.push(text);
    ev.push({ field, value: target, issue: 'not reciprocal' });
  };
  if (rec.recordType === 'SHIPMENT') {
    const mid = f.manifestId;
    if (isStr(mid)) {
      const man = linked(ctx, mid, 'MANIFEST');
      if (!man) missingLink('manifestId', mid, 'manifest');
      else if (Array.isArray(man.fields.shipmentIds) && !man.fields.shipmentIds.includes(rid)) {
        nonReciprocal('manifestId', mid, 'Manifest ' + mid + ' does not list this shipment.');
      }
    }
    const iid = f.invoiceId;
    if (isStr(iid)) {
      const inv = linked(ctx, iid, 'INVOICE');
      if (!inv) missingLink('invoiceId', iid, 'invoice');
      else {
        const back = inv.fields.shipmentId;
        if (isStr(back) && back !== rid) {
          nonReciprocal('invoiceId', iid, 'Invoice ' + iid + ' refers to shipment ' + back + ', not this shipment.');
        }
      }
    }
  } else if (rec.recordType === 'INVOICE') {
    const sid = f.shipmentId;
    if (isStr(sid)) {
      const ship = linked(ctx, sid, 'SHIPMENT');
      if (!ship) missingLink('shipmentId', sid, 'shipment');
      else {
        const back = ship.fields.invoiceId;
        if (isStr(back) && back !== rid) {
          nonReciprocal('shipmentId', sid, 'Shipment ' + sid + ' refers to invoice ' + back + ', not this invoice.');
        }
      }
    }
  } else if (rec.recordType === 'TRANSACTION') {
    const iid = f.invoiceId;
    if (isStr(iid) && !linked(ctx, iid, 'INVOICE')) missingLink('invoiceId', iid, 'invoice');
  } else if (rec.recordType === 'MANIFEST') {
    if (Array.isArray(f.shipmentIds)) {
      for (const sid of f.shipmentIds) {
        if (!isStr(sid)) continue;
        const ship = linked(ctx, sid, 'SHIPMENT');
        if (!ship) missingLink('shipmentIds', sid, 'shipment');
        else {
          const back = ship.fields.manifestId;
          if (isStr(back) && back !== rid) {
            nonReciprocal('shipmentIds', sid, 'Shipment ' + sid + ' refers to manifest ' + back + '.');
          }
        }
      }
    }
  }
  if (expl.length) out.R08 = { explanations: expl, evidence: ev };
}

function checkConcentration(rec, cfg, ctx, out) {
  if (rec.recordType !== 'SHIPMENT') return;
  const cid = (rec.fields || {}).consigneeId;
  if (!isStr(cid)) return;
  const n = ctx.consigneeCounts.get(cid) || 0;
  const t = cfg.params.concentrationMinShipments;
  if (n >= t) {
    out.R09 = {
      explanations: ['Consignee ' + cid + ' appears on ' + n + ' shipments in this dataset (threshold ' + t + ').'],
      evidence: [{ field: 'consigneeId', value: cid, count: n, threshold: t }],
    };
  }
}

export function levelFor(score, levels) {
  let name = levels[0].name;
  for (const lv of levels) if (score >= lv.minScore) name = lv.name;
  return name;
}

export function scoreRecord(rec, ctx, cfg) {
  const out = {};
  if (!Object.prototype.hasOwnProperty.call(cfg.requiredFields, rec.recordType)) {
    out.R10 = {
      explanations: ['Unknown record type ' + fmtValue(rec.recordType) + '.'],
      evidence: [{ field: 'recordType', issue: 'invalid', value: nn(rec.recordType) }],
    };
  } else {
    checkMissing(rec, cfg, out);
    checkDuplicate(rec, cfg, ctx, out);
    checkAmountsCurrencyPartiesDates(rec, cfg, ctx, out);
    checkReuse(rec, ctx, out);
    checkLinks(rec, ctx, out);
    checkConcentration(rec, cfg, ctx, out);
    checkInvalid(rec, cfg, out);
  }
  const firedOthers = Object.keys(out).length;
  if (firedOthers >= cfg.params.multipleFindingsMin) {
    out.R11 = { explanations: [firedOthers + ' independent rules fired on this record.'], evidence: [{ count: firedOthers }] };
  }
  const findings = [];
  let total = 0;
  for (const rule of cfg.rules) {
    if (out[rule.id]) {
      const w = cfg.weights[rule.id];
      total += w;
      findings.push({
        ruleId: rule.id,
        code: rule.code,
        title: rule.title,
        weight: w,
        explanations: out[rule.id].explanations,
        evidence: out[rule.id].evidence,
      });
    }
  }
  const score = total < 100 ? total : 100;
  return {
    recordId: nn(rec.recordId),
    score,
    riskLevel: levelFor(score, cfg.levels),
    flagged: score >= cfg.flagMinScore,
    triggeredRules: findings.map((fd) => fd.ruleId),
    findings,
    scoringVersion: cfg.version,
    profile: cfg.profile,
  };
}

export function scoreDataset(records, config, profile, onlyIds) {
  const cfg = resolveProfile(config, profile);
  const ctx = buildContext(records);
  const wanted = onlyIds ? new Set(onlyIds) : null;
  const results = [];
  for (const rec of records) {
    if (wanted && !wanted.has(rec.recordId)) continue;
    results.push(scoreRecord(rec, ctx, cfg));
  }
  return results;
}
