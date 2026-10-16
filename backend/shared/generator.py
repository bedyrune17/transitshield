"""Deterministic synthetic dataset generator.

Every record, company, airport and reference produced here is FICTIONAL.
Anomalies are deliberately planted data-quality / relationship
inconsistencies used to evaluate the demo rule engine. Nothing here models
real screening procedures or real-world evasion techniques.

The JavaScript port in ``frontend/js/core/generator.js`` must consume the
PRNG in exactly the same order; ``tests/unit/test_parity.py`` enforces this.
"""

from .prng import Mulberry32
from .timeutil import format_ts, parse_ts

GENERATOR_VERSION = "1.0.0"
SOURCE = "synthetic-generator/" + GENERATOR_VERSION

# 2026-09-01T00:00:00Z
BASE_EPOCH = 1788220800
DAY = 86400
HOUR = 3600

MIN_COUNT = 20
MAX_COUNT = 300
MAX_SEED = 4294967295

AIRPORTS = [
    {"code": "PCL1", "name": "Port Calder International (fictional)"},
    {"code": "NVH2", "name": "Northvale Air Cargo Hub (fictional)"},
    {"code": "EHV3", "name": "Esterhaven Regional (fictional)"},
    {"code": "MRL4", "name": "Mirelund Airfield (fictional)"},
    {"code": "SCI5", "name": "Sable Coast International (fictional)"},
    {"code": "HMT6", "name": "Highmoor Cargo Terminal (fictional)"},
    {"code": "QRB7", "name": "Quarry Bay Freight Field (fictional)"},
    {"code": "DLW8", "name": "Dunlow Airport (fictional)"},
]

CARRIERS = [
    {"entityId": "CR-01", "name": "Skyward Cargo Lines (fictional)", "kind": "CARRIER"},
    {"entityId": "CR-02", "name": "Meridian Air Freight (fictional)", "kind": "CARRIER"},
    {"entityId": "CR-03", "name": "Polaris Wings Cargo (fictional)", "kind": "CARRIER"},
]

_PREFIXES = [
    "Bright", "North", "Silver", "Cedar", "Harbor", "Iron", "Blue", "Amber", "Granite",
    "Willow", "Falcon", "Coral", "Summit", "Lumen", "Maple", "Quartz", "Orchid", "Tidal",
]
_SUFFIXES = ["water", "field", "line", "gate", "crest", "stone", "ridge", "brook"]
_KINDS = [
    "Trading Co.", "Logistics Ltd.", "Imports", "Components", "Supply Group",
    "Freight Partners", "Textiles", "Industries",
]
COMMODITIES = [
    "Machine parts", "Textiles", "Consumer electronics", "Furniture", "Packaged foods",
    "Printed books", "Auto components", "Garden tools", "Ceramic tiles", "Sports equipment",
]
CURRENCIES = ["USD", "EUR", "INR", "GBP", "SGD", "AED"]
MALFORMED_TIMESTAMPS = [
    "2026-02-30T10:00:00Z",
    "2026-13-04T08:30:00Z",
    "2026-09-31T25:10:00Z",
    "31/09/2026 10:00",
]

SCENARIOS = {
    "normal": {
        "label": "Normal dataset",
        "description": "Consistent records only. No anomalies are planted; any flag is a false positive.",
    },
    "documentation_inconsistency": {
        "label": "Documentation inconsistency",
        "description": "Invoices name different counterparties or currencies than their shipments; some links are broken.",
    },
    "duplicate_references": {
        "label": "Duplicate references",
        "description": "Air waybills, invoice numbers or transaction references are copied onto unrelated records.",
    },
    "conflicting_amounts": {
        "label": "Conflicting amounts",
        "description": "Invoice and transaction amounts disagree with their linked documents, including a subtle case below the default tolerance.",
    },
    "invalid_timestamps": {
        "label": "Invalid or conflicting timestamps",
        "description": "Arrivals before departures, payments long before invoices and malformed timestamps.",
    },
    "missing_fields": {
        "label": "Missing mandatory fields",
        "description": "Required fields are removed or blanked on a subset of records.",
    },
    "repeated_entities": {
        "label": "Repeated entity references",
        "description": "One fictional consignee is concentrated across many shipments, and invoice references are reused across shipments.",
    },
    "mixed": {
        "label": "Mixed normal and anomalous",
        "description": "A mix of every planted pattern at a lower rate among mostly normal records.",
    },
}

PATTERN_DESCRIPTIONS = {
    "DUPLICATE_REFERENCE": "Document reference copied from another record of the same type.",
    "AMOUNT_CONFLICT": "Invoice amount set far away from the shipment's declared value.",
    "AMOUNT_CONFLICT_SUBTLE": "Invoice amount set 3.6-4.4% above declared value (below the balanced tolerance).",
    "TXN_AMOUNT_CONFLICT": "Transaction amount set to a fraction of the invoice amount.",
    "CURRENCY_CONFLICT": "Invoice (and its payment) switched to a different currency than the shipment.",
    "COUNTERPARTY_CONFLICT": "Invoice (and its payment) names a seller that is not the shipment's consignor.",
    "ARRIVAL_BEFORE_DEPARTURE": "Manifest arrival time set before its departure time.",
    "PAYMENT_BEFORE_INVOICE": "Payment value date set 45-120 days before the invoice issue date.",
    "MALFORMED_TIMESTAMP": "Invoice issue date replaced with a malformed timestamp.",
    "MISSING_FIELDS": "One or two required, non-link fields removed or blanked.",
    "REFERENCE_REUSE": "A second shipment claims another shipment's invoice, orphaning its own invoice.",
    "BROKEN_LINK": "Transaction points at an invoice ID that does not exist.",
    "ENTITY_CONCENTRATION": "One consignee (with matching invoice buyer and payer) placed on seven shipments.",
}

# Link fields are excluded from MISSING_FIELDS so that the pattern does not
# create collateral inconsistencies on other records.
_MISSABLE = {
    "MANIFEST": ["manifestNo", "flightRef", "carrierId", "originAirport", "destinationAirport", "departureAt", "arrivalAt"],
    "SHIPMENT": ["awbNumber", "consignorId", "consigneeId", "commodity", "pieces", "weightKg", "declaredValueMinor", "currency"],
    "INVOICE": ["invoiceNo", "sellerId", "buyerId", "amountMinor", "currency", "issuedAt"],
    "TRANSACTION": ["txnRef", "payerId", "payeeId", "amountMinor", "currency", "valueDate"],
}

_REF_FIELD = {"MANIFEST": "manifestNo", "SHIPMENT": "awbNumber", "INVOICE": "invoiceNo", "TRANSACTION": "txnRef"}


class GeneratorError(ValueError):
    pass


def pad(n: int, width: int) -> str:
    s = str(n)
    return "0" * (width - len(s)) + s if len(s) < width else s


def idiv(a: int, b: int) -> int:
    """Floor division with identical semantics in the JS port."""
    return a // b


def dataset_id_for(scenario: str, seed: int, count: int) -> str:
    return "ds-" + scenario.replace("_", "-") + "-s" + str(seed) + "-n" + str(count)


def _plan(scenario: str, s: int, m: int):
    """Ordered list of (pattern, instances) for a scenario.

    ``s`` is the number of shipments and ``m`` the number of manifests.
    """
    def at_least_1(x):
        return x if x > 0 else 1

    if scenario == "normal":
        return []
    if scenario == "documentation_inconsistency":
        return [("COUNTERPARTY_CONFLICT", at_least_1(idiv(s, 8))), ("CURRENCY_CONFLICT", at_least_1(idiv(s, 10))),
                ("BROKEN_LINK", at_least_1(idiv(s, 10)))]
    if scenario == "duplicate_references":
        return [("DUPLICATE_REFERENCE", at_least_1(idiv(s, 6)))]
    if scenario == "conflicting_amounts":
        return [("AMOUNT_CONFLICT", at_least_1(idiv(s, 6))), ("AMOUNT_CONFLICT_SUBTLE", at_least_1(idiv(s, 12))),
                ("TXN_AMOUNT_CONFLICT", at_least_1(idiv(s, 10)))]
    if scenario == "invalid_timestamps":
        return [("ARRIVAL_BEFORE_DEPARTURE", at_least_1(idiv(m, 4))), ("PAYMENT_BEFORE_INVOICE", at_least_1(idiv(s, 10))),
                ("MALFORMED_TIMESTAMP", at_least_1(idiv(s, 10)))]
    if scenario == "missing_fields":
        return [("MISSING_FIELDS", at_least_1(idiv(s, 5)))]
    if scenario == "repeated_entities":
        return [("ENTITY_CONCENTRATION", 1), ("REFERENCE_REUSE", at_least_1(idiv(s, 14)))]
    if scenario == "mixed":
        return [
            ("DUPLICATE_REFERENCE", at_least_1(idiv(s, 14))),
            ("AMOUNT_CONFLICT", at_least_1(idiv(s, 12))),
            ("AMOUNT_CONFLICT_SUBTLE", 1),
            ("TXN_AMOUNT_CONFLICT", at_least_1(idiv(s, 20))),
            ("CURRENCY_CONFLICT", 1),
            ("COUNTERPARTY_CONFLICT", at_least_1(idiv(s, 16))),
            ("ARRIVAL_BEFORE_DEPARTURE", 1),
            ("PAYMENT_BEFORE_INVOICE", 1),
            ("MALFORMED_TIMESTAMP", 1),
            ("MISSING_FIELDS", at_least_1(idiv(s, 14))),
            ("REFERENCE_REUSE", at_least_1(idiv(s, 14))),
            ("BROKEN_LINK", 1),
        ]
    raise GeneratorError("unknown scenario")


def _companies(rng: Mulberry32):
    prefixes = rng.sample(_PREFIXES, len(_PREFIXES))
    out = []
    for i, prefix in enumerate(prefixes):
        name = prefix + rng.choice(_SUFFIXES) + " " + rng.choice(_KINDS) + " (fictional)"
        out.append({"entityId": "CO-" + pad(i + 1, 3), "name": name, "kind": "COMPANY"})
    return out


def link_ids(record_type: str, fields: dict):
    """Forward references from a record's fields (used for linkedEntityIds)."""
    keys = {
        "MANIFEST": ["carrierId"],
        "SHIPMENT": ["manifestId", "invoiceId", "consignorId", "consigneeId"],
        "INVOICE": ["shipmentId", "sellerId", "buyerId"],
        "TRANSACTION": ["invoiceId", "payerId", "payeeId"],
    }[record_type]
    out = []
    if record_type == "MANIFEST":
        ships = fields.get("shipmentIds")
        if isinstance(ships, list):
            for sid in ships:
                if isinstance(sid, str) and sid and sid not in out:
                    out.append(sid)
    for k in keys:
        v = fields.get(k)
        if isinstance(v, str) and v.strip() != "" and v not in out:
            out.append(v)
    return out


def generate_dataset(scenario: str = "mixed", seed: int = 42, count: int = 100):
    if scenario not in SCENARIOS:
        raise GeneratorError("unknown scenario")
    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0 or seed > MAX_SEED:
        raise GeneratorError("seed must be an integer between 0 and 4294967295")
    if not isinstance(count, int) or isinstance(count, bool) or count < MIN_COUNT or count > MAX_COUNT:
        raise GeneratorError("count must be an integer between 20 and 300")

    rng = Mulberry32(seed)
    dataset_id = dataset_id_for(scenario, seed, count)
    companies = _companies(rng)
    company_ids = [c["entityId"] for c in companies]
    carrier_ids = [c["entityId"] for c in CARRIERS]
    airport_codes = [a["code"] for a in AIRPORTS]
    base = BASE_EPOCH + rng.randint(0, 6) * DAY

    records = []
    by_id = {}
    chains = []  # (manifest, shipment, invoice, transaction) per shipment
    manifests = []
    n_man = 0
    n_shp = 0
    remaining = count
    group = 0

    def add(rec):
        records.append(rec)
        by_id[rec["recordId"]] = rec

    while remaining >= 4:
        k = rng.randint(2, 4)
        cap = idiv(remaining - 1, 3)
        if k > cap:
            k = cap
        if k < 1:
            break
        group += 1
        group_id = "G-" + pad(group, 3)
        n_man += 1
        man_id = "MAN-" + pad(n_man, 4)
        route = rng.sample(airport_codes, 2)
        dep = base + (group - 1) * 6 * HOUR + rng.randint(0, 5) * HOUR
        arr = dep + rng.randint(2, 11) * HOUR + rng.randint(0, 3) * 900
        manifest = {
            "recordId": man_id,
            "recordType": "MANIFEST",
            "datasetId": dataset_id,
            "source": SOURCE,
            "groupId": group_id,
            "createdAt": format_ts(dep - 2 * HOUR),
            "fields": {
                "manifestNo": "MNF-26-" + pad(n_man, 4) + str(rng.randint(10, 99)),
                "flightRef": "TS" + str(rng.randint(1000, 9999)),
                "carrierId": rng.choice(carrier_ids),
                "originAirport": route[0],
                "destinationAirport": route[1],
                "departureAt": format_ts(dep),
                "arrivalAt": format_ts(arr),
                "shipmentIds": [],
            },
        }
        add(manifest)
        manifests.append(manifest)

        for _ in range(k):
            n_shp += 1
            shp_id = "SHP-" + pad(n_shp, 4)
            inv_id = "INV-" + pad(n_shp, 4)
            txn_id = "TXN-" + pad(n_shp, 4)
            parties = rng.sample(company_ids, 2)
            pieces = rng.randint(1, 40)
            weight = pieces * rng.randint(5, 60)
            currency = rng.choice(CURRENCIES)
            declared = rng.randint(120000, 25000000)
            shipment = {
                "recordId": shp_id,
                "recordType": "SHIPMENT",
                "datasetId": dataset_id,
                "source": SOURCE,
                "groupId": group_id,
                "createdAt": format_ts(dep - rng.randint(2, 20) * HOUR),
                "fields": {
                    "awbNumber": "AWB-" + str(rng.randint(100, 999)) + "-" + pad(n_shp, 5) + str(rng.randint(0, 9)),
                    "manifestId": man_id,
                    "consignorId": parties[0],
                    "consigneeId": parties[1],
                    "commodity": rng.choice(COMMODITIES),
                    "pieces": pieces,
                    "weightKg": weight,
                    "declaredValueMinor": declared,
                    "currency": currency,
                    "invoiceId": inv_id,
                },
            }
            if rng.chance(40):
                bps = rng.randint(550, 700)  # legitimate freight adjustment (natural FP source)
            else:
                bps = rng.randint(-300, 300)
            inv_amount = declared + idiv(declared * bps, 10000)
            issued = dep - rng.randint(1, 10) * DAY + rng.randint(0, 23) * HOUR
            invoice = {
                "recordId": inv_id,
                "recordType": "INVOICE",
                "datasetId": dataset_id,
                "source": SOURCE,
                "groupId": group_id,
                "createdAt": format_ts(issued),
                "fields": {
                    "invoiceNo": "INV-DOC-" + pad(n_shp, 5) + "-" + str(rng.randint(100, 999)),
                    "shipmentId": shp_id,
                    "sellerId": parties[0],
                    "buyerId": parties[1],
                    "amountMinor": inv_amount,
                    "currency": currency,
                    "issuedAt": format_ts(issued),
                },
            }
            if rng.randint(0, 99) < 6:
                value_date = issued - rng.randint(1, 10) * DAY  # short prepayment (allowed)
            else:
                value_date = issued + rng.randint(0, 45) * DAY + rng.randint(0, 23) * HOUR
            txn_amount = inv_amount
            if rng.chance(80):
                txn_amount = inv_amount - idiv(inv_amount * rng.randint(10, 150), 10000)  # bank fee
            txn = {
                "recordId": txn_id,
                "recordType": "TRANSACTION",
                "datasetId": dataset_id,
                "source": SOURCE,
                "groupId": group_id,
                "createdAt": format_ts(value_date),
                "fields": {
                    "txnRef": "FTR-" + pad(n_shp, 6) + str(rng.randint(10, 99)),
                    "invoiceId": inv_id,
                    "payerId": parties[1],
                    "payeeId": parties[0],
                    "amountMinor": txn_amount,
                    "currency": currency,
                    "valueDate": format_ts(value_date),
                },
            }
            manifest["fields"]["shipmentIds"].append(shp_id)
            add(shipment)
            add(invoice)
            add(txn)
            chains.append({"manifest": manifest, "shipment": shipment, "invoice": invoice, "txn": txn})
        remaining -= 1 + 3 * k

    labels = {}
    for rec in records:
        labels[rec["recordId"]] = {"recordId": rec["recordId"], "isAnomalous": False, "patterns": [], "roles": []}
    touched = set()
    planted = []

    def mark(rec, pattern, role):
        lab = labels[rec["recordId"]]
        lab["isAnomalous"] = True
        lab["patterns"].append(pattern)
        lab["roles"].append(role)

    def free_chains():
        return [c for c in chains if c["shipment"]["recordId"] not in touched
                and c["invoice"]["recordId"] not in touched and c["txn"]["recordId"] not in touched]

    def take(cands):
        if not cands:
            return None
        return cands[rng.randint(0, len(cands) - 1)]

    def touch(*recs):
        for r in recs:
            touched.add(r["recordId"])

    def plant(pattern):
        """Apply one instance of a pattern. Returns affected record IDs or None."""
        if pattern == "DUPLICATE_REFERENCE":
            rtype = rng.choice(["SHIPMENT", "INVOICE", "TRANSACTION"])
            key = {"SHIPMENT": "shipment", "INVOICE": "invoice", "TRANSACTION": "txn"}[rtype]
            cands = [c[key] for c in chains if c[key]["recordId"] not in touched]
            a = take(cands)
            if a is None:
                return None
            cands_b = [r for r in cands if r["groupId"] != a["groupId"]]
            b = take(cands_b)
            if b is None:
                return None
            ref = _REF_FIELD[rtype]
            b["fields"][ref] = a["fields"][ref]
            touch(a, b)
            mark(a, pattern, "counterpart")
            mark(b, pattern, "altered")
            return [a["recordId"], b["recordId"]]

        if pattern in ("AMOUNT_CONFLICT", "AMOUNT_CONFLICT_SUBTLE"):
            c = take(free_chains())
            if c is None:
                return None
            declared = c["shipment"]["fields"]["declaredValueMinor"]
            if pattern == "AMOUNT_CONFLICT_SUBTLE":
                bps = rng.randint(10360, 10440)
            elif rng.chance(500):
                bps = rng.randint(4000, 7000)
            else:
                bps = rng.randint(14000, 19000)
            amount = idiv(declared * bps, 10000)
            c["invoice"]["fields"]["amountMinor"] = amount
            c["txn"]["fields"]["amountMinor"] = amount
            touch(c["invoice"], c["txn"])
            mark(c["invoice"], pattern, "altered")
            return [c["invoice"]["recordId"]]

        if pattern == "TXN_AMOUNT_CONFLICT":
            c = take(free_chains())
            if c is None:
                return None
            inv_amount = c["invoice"]["fields"]["amountMinor"]
            c["txn"]["fields"]["amountMinor"] = idiv(inv_amount * rng.randint(5000, 8500), 10000)
            touch(c["txn"])
            mark(c["txn"], pattern, "altered")
            return [c["txn"]["recordId"]]

        if pattern == "CURRENCY_CONFLICT":
            c = take(free_chains())
            if c is None:
                return None
            current = c["invoice"]["fields"]["currency"]
            new_cur = rng.choice([x for x in CURRENCIES if x != current])
            c["invoice"]["fields"]["currency"] = new_cur
            c["txn"]["fields"]["currency"] = new_cur
            touch(c["invoice"], c["txn"])
            mark(c["invoice"], pattern, "altered")
            return [c["invoice"]["recordId"]]

        if pattern == "COUNTERPARTY_CONFLICT":
            c = take(free_chains())
            if c is None:
                return None
            sf = c["shipment"]["fields"]
            others = [x for x in company_ids if x != sf["consignorId"] and x != sf["consigneeId"]]
            new_seller = rng.choice(others)
            c["invoice"]["fields"]["sellerId"] = new_seller
            c["txn"]["fields"]["payeeId"] = new_seller
            touch(c["invoice"], c["txn"])
            mark(c["invoice"], pattern, "altered")
            return [c["invoice"]["recordId"]]

        if pattern == "ARRIVAL_BEFORE_DEPARTURE":
            cands = [mn for mn in manifests if mn["recordId"] not in touched]
            mn = take(cands)
            if mn is None:
                return None
            dep_s = mn["fields"]["departureAt"]
            mn["fields"]["arrivalAt"] = format_ts(parse_ts(dep_s) - rng.randint(1, 6) * HOUR)
            touch(mn)
            mark(mn, pattern, "altered")
            return [mn["recordId"]]

        if pattern == "PAYMENT_BEFORE_INVOICE":
            c = take(free_chains())
            if c is None:
                return None
            issued = parse_ts(c["invoice"]["fields"]["issuedAt"])
            c["txn"]["fields"]["valueDate"] = format_ts(issued - rng.randint(45, 120) * DAY)
            touch(c["txn"], c["invoice"])
            mark(c["txn"], pattern, "altered")
            return [c["txn"]["recordId"]]

        if pattern == "MALFORMED_TIMESTAMP":
            c = take(free_chains())
            if c is None:
                return None
            c["invoice"]["fields"]["issuedAt"] = rng.choice(MALFORMED_TIMESTAMPS)
            touch(c["invoice"], c["txn"])
            mark(c["invoice"], pattern, "altered")
            return [c["invoice"]["recordId"]]

        if pattern == "MISSING_FIELDS":
            pool = [r for r in records if r["recordId"] not in touched]
            r = take(pool)
            if r is None:
                return None
            n = rng.randint(1, 2)
            fields_to_drop = rng.sample(_MISSABLE[r["recordType"]], n)
            for f in fields_to_drop:
                if rng.chance(500):
                    del r["fields"][f]
                else:
                    r["fields"][f] = ""
            touch(r)
            mark(r, pattern, "altered")
            return [r["recordId"]]

        if pattern == "REFERENCE_REUSE":
            free = free_chains()
            a = take(free)
            if a is None:
                return None
            free_b = [c for c in free if c["manifest"]["recordId"] != a["manifest"]["recordId"]]
            b = take(free_b)
            if b is None:
                return None
            b["shipment"]["fields"]["invoiceId"] = a["invoice"]["recordId"]
            touch(a["shipment"], a["invoice"], b["shipment"], b["invoice"])
            mark(a["shipment"], pattern, "counterpart")
            mark(b["shipment"], pattern, "altered")
            mark(b["invoice"], pattern, "orphaned")
            return [a["shipment"]["recordId"], b["shipment"]["recordId"], b["invoice"]["recordId"]]

        if pattern == "BROKEN_LINK":
            c = take(free_chains())
            if c is None:
                return None
            c["txn"]["fields"]["invoiceId"] = "INV-" + pad(9000 + rng.randint(0, 99), 4)
            touch(c["txn"])
            mark(c["txn"], pattern, "altered")
            return [c["txn"]["recordId"]]

        if pattern == "ENTITY_CONCENTRATION":
            target = rng.choice(company_ids)
            free = [c for c in free_chains() if c["shipment"]["fields"]["consigneeId"] != target
                    and c["shipment"]["fields"]["consignorId"] != target]
            picked = rng.sample(free, 7)
            if len(picked) < 7:
                return None
            ids = []
            for c in picked:
                c["shipment"]["fields"]["consigneeId"] = target
                c["invoice"]["fields"]["buyerId"] = target
                c["txn"]["fields"]["payerId"] = target
                touch(c["shipment"], c["invoice"], c["txn"])
                mark(c["shipment"], pattern, "altered")
                ids.append(c["shipment"]["recordId"])
            return ids

        raise GeneratorError("unknown pattern")

    plan = _plan(scenario, len(chains), len(manifests))
    for pattern, instances in plan:
        for i in range(instances):
            affected = plant(pattern)
            planted.append({
                "pattern": pattern,
                "instance": i + 1,
                "applied": affected is not None,
                "recordIds": affected or [],
                "description": PATTERN_DESCRIPTIONS[pattern],
            })

    for rec in records:
        rec["linkedEntityIds"] = link_ids(rec["recordType"], rec["fields"])

    label_list = [labels[r["recordId"]] for r in records]
    entities = companies + [dict(c) for c in CARRIERS]
    meta = {
        "datasetId": dataset_id,
        "scenario": scenario,
        "scenarioLabel": SCENARIOS[scenario]["label"],
        "scenarioDescription": SCENARIOS[scenario]["description"],
        "seed": seed,
        "requestedCount": count,
        "recordCount": len(records),
        "generatorVersion": GENERATOR_VERSION,
        "plantedPatterns": planted,
        "anomalousRecordCount": sum(1 for lab in label_list if lab["isAnomalous"]),
        "entities": entities,
        "airports": [dict(a) for a in AIRPORTS],
        "notice": "All records, companies, airports and references are fictional and deliberately constructed for testing.",
    }
    return {"meta": meta, "records": records, "labels": label_list}
