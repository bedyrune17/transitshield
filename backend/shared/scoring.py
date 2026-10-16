"""Deterministic, explainable rule-based risk scoring.

Scores are bounded to 0..100 and are the sum of the weights of the rules that
fired (each rule counts once per record). Every finding carries
human-readable explanations and the evidence fields that triggered it.

The scoring input is the set of records only; ground-truth labels are never
passed to this module. ``frontend/js/core/scoring.js`` is a line-for-line
port and ``tests/unit/test_parity.py`` checks both produce identical output.
"""

import json
import os

from .timeutil import parse_ts

_RULES_PATH = os.path.join(os.path.dirname(__file__), "risk_rules.json")


def load_rules(path: str = _RULES_PATH) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def resolve_profile(config: dict, profile: str = None) -> dict:
    name = profile or config["defaultProfile"]
    if name not in config["profiles"]:
        raise ValueError("unknown scoring profile")
    prof = config["profiles"][name]
    weights = {r["id"]: r["weight"] for r in config["rules"]}
    for rid, w in (prof.get("weights") or {}).items():
        weights[rid] = w
    params = dict(config["params"])
    params.update(prof.get("params") or {})
    return {
        "profile": name,
        "rules": config["rules"],
        "weights": weights,
        "params": params,
        "levels": prof.get("levels") or config["levels"],
        "flagMinScore": prof.get("flagMinScore", config["flagMinScore"]),
        "requiredFields": config["requiredFields"],
        "refField": config["documentReferenceField"],
        "currencies": config["reference"]["currencies"],
        "airports": config["reference"]["airports"],
        "version": "engine-" + config["engineVersion"] + "/rules-" + config["rulesetVersion"] + "/" + name,
    }


def is_missing(v) -> bool:
    if v is None:
        return True
    if isinstance(v, str) and v.strip() == "":
        return True
    if isinstance(v, list) and len(v) == 0:
        return True
    return False


def _is_pos_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def _is_str(v) -> bool:
    return isinstance(v, str) and v.strip() != ""


def fmt_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return '"' + v + '"'
    if v is None:
        return "null"
    return "(unsupported value)"


def _group3(n: int) -> str:
    s = str(n)
    out = ""
    while len(s) > 3:
        out = "," + s[-3:] + out
        s = s[:-3]
    return s + out


def fmt_money(minor: int, currency: str) -> str:
    sign = "-" if minor < 0 else ""
    m = -minor if minor < 0 else minor
    cents = m % 100
    return sign + _group3(m // 100) + "." + ("0" if cents < 10 else "") + str(cents) + " " + currency


def fmt_bps(bps: int) -> str:
    tenths = (bps + 5) // 10
    return str(tenths // 10) + "." + str(tenths % 10) + "%"


def build_context(records):
    by_id = {}
    ref_index = {}
    shipment_claims = {}
    txn_claims = {}
    consignee_counts = {}
    for r in records:
        by_id[r["recordId"]] = r
    for r in records:
        f = r.get("fields") or {}
        rtype = r.get("recordType")
        ref_field = {"MANIFEST": "manifestNo", "SHIPMENT": "awbNumber", "INVOICE": "invoiceNo",
                     "TRANSACTION": "txnRef"}.get(rtype)
        if ref_field and _is_str(f.get(ref_field)):
            ref_index.setdefault(rtype + "|" + f[ref_field], []).append(r["recordId"])
        if rtype == "SHIPMENT":
            if _is_str(f.get("invoiceId")):
                shipment_claims.setdefault(f["invoiceId"], []).append(r["recordId"])
            if _is_str(f.get("consigneeId")):
                consignee_counts[f["consigneeId"]] = consignee_counts.get(f["consigneeId"], 0) + 1
        if rtype == "TRANSACTION" and _is_str(f.get("invoiceId")):
            txn_claims.setdefault(f["invoiceId"], []).append(r["recordId"])
    return {
        "byId": by_id,
        "refIndex": ref_index,
        "shipmentClaims": shipment_claims,
        "txnClaims": txn_claims,
        "consigneeCounts": consignee_counts,
    }


def _linked(ctx, rid, rtype):
    if not _is_str(rid):
        return None
    r = ctx["byId"].get(rid)
    if r is None or r.get("recordType") != rtype:
        return None
    return r


def _others(ids, self_id):
    return sorted(i for i in ids if i != self_id)


def _check_missing(rec, cfg, out):
    f = rec.get("fields") or {}
    missing = [name for name in cfg["requiredFields"].get(rec["recordType"], []) if is_missing(f.get(name))]
    if missing:
        out["R01"] = {
            "explanations": ["Required field(s) missing or empty: " + ", ".join(missing) + "."],
            "evidence": [{"field": name, "issue": "missing"} for name in missing],
        }


def _check_invalid(rec, cfg, out):
    f = rec.get("fields") or {}
    rtype = rec["recordType"]
    expl = []
    ev = []

    def bad(field, reason):
        expl.append(field + " " + reason + " (found " + fmt_value(f.get(field)) + ").")
        ev.append({"field": field, "issue": "invalid", "value": f.get(field)})

    for name in ("pieces", "weightKg", "declaredValueMinor", "amountMinor"):
        if name in f and not is_missing(f.get(name)) and not _is_pos_int(f.get(name)):
            bad(name, "must be a positive whole number")
    if "currency" in f and not is_missing(f.get("currency")) and f.get("currency") not in cfg["currencies"]:
        bad("currency", "is not an allowed currency code")
    for name in ("departureAt", "arrivalAt", "issuedAt", "valueDate"):
        if name in f and not is_missing(f.get(name)) and parse_ts(f.get(name)) is None:
            bad(name, "is not a valid UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)")
    if rtype == "MANIFEST":
        for name in ("originAirport", "destinationAirport"):
            if name in f and not is_missing(f.get(name)) and f.get(name) not in cfg["airports"]:
                bad(name, "is not a known (fictional) airport code")
        o, d = f.get("originAirport"), f.get("destinationAirport")
        if _is_str(o) and _is_str(d) and o == d:
            expl.append("Origin and destination airports are identical (" + o + ").")
            ev.append({"field": "destinationAirport", "issue": "equals origin", "value": d})
    if expl:
        out["R10"] = {"explanations": expl, "evidence": ev}


def _check_duplicate(rec, cfg, ctx, out):
    rtype = rec["recordType"]
    field = cfg["refField"].get(rtype)
    f = rec.get("fields") or {}
    if not field or not _is_str(f.get(field)):
        return
    ids = ctx["refIndex"].get(rtype + "|" + f[field], [])
    others = _others(ids, rec["recordId"])
    if others:
        out["R02"] = {
            "explanations": [field + " \"" + f[field] + "\" also appears on " + ", ".join(others) + "."],
            "evidence": [{"field": field, "value": f[field], "relatedRecordIds": others}],
        }


def _check_amounts_currency_parties_dates(rec, cfg, ctx, out):
    f = rec.get("fields") or {}
    rtype = rec["recordType"]
    p = cfg["params"]

    def compare_amount(a_name, a, linked_id, linked_label, b_name, b, tol, cur):
        if not (_is_pos_int(a) and _is_pos_int(b)):
            return
        diff = a - b if a > b else b - a
        base = a if a > b else b
        if diff * 10000 > tol * base:
            bps = (diff * 10000) // base
            out["R03"] = {
                "explanations": [
                    a_name + " " + fmt_money(a, cur) + " differs from " + linked_label + " " + linked_id + " "
                    + b_name + " " + fmt_money(b, cur) + " by " + fmt_bps(bps) + " (tolerance " + fmt_bps(tol) + ")."
                ],
                "evidence": [{"field": "amountMinor", "value": a, "relatedRecordId": linked_id,
                              "relatedField": b_name, "relatedValue": b, "differenceBps": bps, "toleranceBps": tol}],
            }

    def compare_currency(cur, linked, linked_label):
        lf = linked["fields"]
        lc = lf.get("currency")
        if _is_str(cur) and _is_str(lc) and cur != lc:
            out["R04"] = {
                "explanations": ["Currency " + cur + " differs from " + linked_label + " " + linked["recordId"]
                                 + " currency " + lc + "."],
                "evidence": [{"field": "currency", "value": cur, "relatedRecordId": linked["recordId"],
                              "relatedValue": lc}],
            }
            return False
        return _is_str(cur) and _is_str(lc)

    def compare_parties(pairs, linked, linked_label):
        expl = []
        ev = []
        lf = linked["fields"]
        for mine, theirs, mine_label, their_label in pairs:
            a, b = f.get(mine), lf.get(theirs)
            if _is_str(a) and _is_str(b) and a != b:
                expl.append(mine_label + " " + a + " does not match " + linked_label + " " + linked["recordId"] + " "
                            + their_label + " " + b + ".")
                ev.append({"field": mine, "value": a, "relatedRecordId": linked["recordId"],
                           "relatedField": theirs, "relatedValue": b})
        if expl:
            out["R06"] = {"explanations": expl, "evidence": ev}

    if rtype == "INVOICE":
        ship = _linked(ctx, f.get("shipmentId"), "SHIPMENT")
        if ship is not None:
            same_cur = compare_currency(f.get("currency"), ship, "shipment")
            if same_cur:
                compare_amount("Invoice amount", f.get("amountMinor"), ship["recordId"], "shipment", "declared value",
                               ship["fields"].get("declaredValueMinor"), p["invoiceShipmentToleranceBps"], f["currency"])
            compare_parties([("sellerId", "consignorId", "Invoice seller", "consignor"),
                             ("buyerId", "consigneeId", "Invoice buyer", "consignee")], ship, "shipment")
    elif rtype == "TRANSACTION":
        inv = _linked(ctx, f.get("invoiceId"), "INVOICE")
        if inv is not None:
            same_cur = compare_currency(f.get("currency"), inv, "invoice")
            if same_cur:
                compare_amount("Transaction amount", f.get("amountMinor"), inv["recordId"], "invoice", "amount",
                               inv["fields"].get("amountMinor"), p["txnInvoiceToleranceBps"], f["currency"])
            compare_parties([("payeeId", "sellerId", "Payee", "seller"),
                             ("payerId", "buyerId", "Payer", "buyer")], inv, "invoice")
            vd = parse_ts(f.get("valueDate"))
            issued = parse_ts(inv["fields"].get("issuedAt"))
            if vd is not None and issued is not None and issued - vd > p["maxPrepaymentDays"] * 86400:
                days = (issued - vd) // 86400
                out["R05"] = {
                    "explanations": ["Payment value date " + f["valueDate"] + " precedes invoice " + inv["recordId"]
                                     + " issue date " + inv["fields"]["issuedAt"] + " by " + str(days)
                                     + " days (allowed prepayment window " + str(p["maxPrepaymentDays"]) + " days)."],
                    "evidence": [{"field": "valueDate", "value": f["valueDate"], "relatedRecordId": inv["recordId"],
                                  "relatedField": "issuedAt", "relatedValue": inv["fields"]["issuedAt"],
                                  "days": days}],
                }
    elif rtype == "MANIFEST":
        dep = parse_ts(f.get("departureAt"))
        arr = parse_ts(f.get("arrivalAt"))
        if dep is not None and arr is not None and arr <= dep:
            out["R05"] = {
                "explanations": ["Arrival " + f["arrivalAt"] + " is not after departure " + f["departureAt"] + "."],
                "evidence": [{"field": "arrivalAt", "value": f["arrivalAt"], "relatedField": "departureAt",
                              "relatedValue": f["departureAt"]}],
            }


def _check_reuse(rec, ctx, out):
    f = rec.get("fields") or {}
    rtype = rec["recordType"]
    inv = f.get("invoiceId")
    if not _is_str(inv):
        return
    if rtype == "SHIPMENT":
        claims = ctx["shipmentClaims"].get(inv, [])
        label = "shipment(s)"
    elif rtype == "TRANSACTION":
        claims = ctx["txnClaims"].get(inv, [])
        label = "transaction(s)"
    else:
        return
    others = _others(claims, rec["recordId"])
    if others:
        out["R07"] = {
            "explanations": ["Invoice " + inv + " is also claimed by " + label + " " + ", ".join(others) + "."],
            "evidence": [{"field": "invoiceId", "value": inv, "relatedRecordIds": others}],
        }


def _check_links(rec, ctx, out):
    f = rec.get("fields") or {}
    rtype = rec["recordType"]
    rid = rec["recordId"]
    expl = []
    ev = []

    def missing_link(field, target, label):
        expl.append("Linked " + label + " " + target + " does not exist in the dataset.")
        ev.append({"field": field, "value": target, "issue": "not found"})

    def non_reciprocal(field, target, text):
        expl.append(text)
        ev.append({"field": field, "value": target, "issue": "not reciprocal"})

    if rtype == "SHIPMENT":
        mid = f.get("manifestId")
        if _is_str(mid):
            man = _linked(ctx, mid, "MANIFEST")
            if man is None:
                missing_link("manifestId", mid, "manifest")
            else:
                listed = man["fields"].get("shipmentIds")
                if isinstance(listed, list) and rid not in listed:
                    non_reciprocal("manifestId", mid, "Manifest " + mid + " does not list this shipment.")
        iid = f.get("invoiceId")
        if _is_str(iid):
            inv = _linked(ctx, iid, "INVOICE")
            if inv is None:
                missing_link("invoiceId", iid, "invoice")
            else:
                back = inv["fields"].get("shipmentId")
                if _is_str(back) and back != rid:
                    non_reciprocal("invoiceId", iid, "Invoice " + iid + " refers to shipment " + back
                                   + ", not this shipment.")
    elif rtype == "INVOICE":
        sid = f.get("shipmentId")
        if _is_str(sid):
            ship = _linked(ctx, sid, "SHIPMENT")
            if ship is None:
                missing_link("shipmentId", sid, "shipment")
            else:
                back = ship["fields"].get("invoiceId")
                if _is_str(back) and back != rid:
                    non_reciprocal("shipmentId", sid, "Shipment " + sid + " refers to invoice " + back
                                   + ", not this invoice.")
    elif rtype == "TRANSACTION":
        iid = f.get("invoiceId")
        if _is_str(iid) and _linked(ctx, iid, "INVOICE") is None:
            missing_link("invoiceId", iid, "invoice")
    elif rtype == "MANIFEST":
        listed = f.get("shipmentIds")
        if isinstance(listed, list):
            for sid in listed:
                if not _is_str(sid):
                    continue
                ship = _linked(ctx, sid, "SHIPMENT")
                if ship is None:
                    missing_link("shipmentIds", sid, "shipment")
                else:
                    back = ship["fields"].get("manifestId")
                    if _is_str(back) and back != rid:
                        non_reciprocal("shipmentIds", sid, "Shipment " + sid + " refers to manifest " + back + ".")
    if expl:
        out["R08"] = {"explanations": expl, "evidence": ev}


def _check_concentration(rec, cfg, ctx, out):
    if rec["recordType"] != "SHIPMENT":
        return
    cid = (rec.get("fields") or {}).get("consigneeId")
    if not _is_str(cid):
        return
    n = ctx["consigneeCounts"].get(cid, 0)
    t = cfg["params"]["concentrationMinShipments"]
    if n >= t:
        out["R09"] = {
            "explanations": ["Consignee " + cid + " appears on " + str(n) + " shipments in this dataset (threshold "
                             + str(t) + ")."],
            "evidence": [{"field": "consigneeId", "value": cid, "count": n, "threshold": t}],
        }


def level_for(score: int, levels) -> str:
    name = levels[0]["name"]
    for lv in levels:
        if score >= lv["minScore"]:
            name = lv["name"]
    return name


def score_record(rec: dict, ctx: dict, cfg: dict) -> dict:
    out = {}
    if rec.get("recordType") not in cfg["requiredFields"]:
        out["R10"] = {"explanations": ["Unknown record type " + fmt_value(rec.get("recordType")) + "."],
                      "evidence": [{"field": "recordType", "issue": "invalid", "value": rec.get("recordType")}]}
    else:
        _check_missing(rec, cfg, out)
        _check_duplicate(rec, cfg, ctx, out)
        _check_amounts_currency_parties_dates(rec, cfg, ctx, out)
        _check_reuse(rec, ctx, out)
        _check_links(rec, ctx, out)
        _check_concentration(rec, cfg, ctx, out)
        _check_invalid(rec, cfg, out)
    fired_others = len(out)
    if fired_others >= cfg["params"]["multipleFindingsMin"]:
        out["R11"] = {"explanations": [str(fired_others) + " independent rules fired on this record."],
                      "evidence": [{"count": fired_others}]}

    findings = []
    total = 0
    for rule in cfg["rules"]:
        rid = rule["id"]
        if rid in out:
            w = cfg["weights"][rid]
            total += w
            findings.append({
                "ruleId": rid,
                "code": rule["code"],
                "title": rule["title"],
                "weight": w,
                "explanations": out[rid]["explanations"],
                "evidence": out[rid]["evidence"],
            })
    score = total if total < 100 else 100
    return {
        "recordId": rec.get("recordId"),
        "score": score,
        "riskLevel": level_for(score, cfg["levels"]),
        "flagged": score >= cfg["flagMinScore"],
        "triggeredRules": [fd["ruleId"] for fd in findings],
        "findings": findings,
        "scoringVersion": cfg["version"],
        "profile": cfg["profile"],
    }


def score_dataset(records, config: dict, profile: str = None, only_ids=None):
    """Score records in the context of the whole dataset.

    ``only_ids`` restricts which records receive results; the context (for
    duplicate / link / concentration rules) always uses every record.
    """
    cfg = resolve_profile(config, profile)
    ctx = build_context(records)
    wanted = set(only_ids) if only_ids is not None else None
    results = []
    for rec in records:
        if wanted is not None and rec.get("recordId") not in wanted:
            continue
        results.append(score_record(rec, ctx, cfg))
    return results
