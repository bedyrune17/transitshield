"""Scoring engine tests on small, hand-built record sets."""

import copy
import json
import unittest

from tests import helpers  # noqa: F401
from shared.generator import generate_dataset
from shared.scoring import fmt_bps, fmt_money, level_for, load_rules, score_dataset

RULES = load_rules()


def chain(n=1, *, declared=1_000_000, invoice=1_010_000, txn=1_005_000, currency="USD"):
    """One consistent manifest -> shipment -> invoice -> transaction chain."""
    s = "%04d" % n
    return [
        {"recordId": "MAN-" + s, "recordType": "MANIFEST", "fields": {
            "manifestNo": "MNF-" + s, "flightRef": "TS1000", "carrierId": "CR-01", "originAirport": "PCL1",
            "destinationAirport": "NVH2", "departureAt": "2026-09-02T10:00:00Z", "arrivalAt": "2026-09-02T16:00:00Z",
            "shipmentIds": ["SHP-" + s]}},
        {"recordId": "SHP-" + s, "recordType": "SHIPMENT", "fields": {
            "awbNumber": "AWB-" + s, "manifestId": "MAN-" + s, "consignorId": "CO-001", "consigneeId": "CO-002",
            "commodity": "Textiles", "pieces": 3, "weightKg": 60, "declaredValueMinor": declared,
            "currency": currency, "invoiceId": "INV-" + s}},
        {"recordId": "INV-" + s, "recordType": "INVOICE", "fields": {
            "invoiceNo": "INVDOC-" + s, "shipmentId": "SHP-" + s, "sellerId": "CO-001", "buyerId": "CO-002",
            "amountMinor": invoice, "currency": currency, "issuedAt": "2026-08-30T09:00:00Z"}},
        {"recordId": "TXN-" + s, "recordType": "TRANSACTION", "fields": {
            "txnRef": "FTR-" + s, "invoiceId": "INV-" + s, "payerId": "CO-002", "payeeId": "CO-001",
            "amountMinor": txn, "currency": currency, "valueDate": "2026-09-10T09:00:00Z"}},
    ]


def by_id(results):
    return {r["recordId"]: r for r in results}


class ScoringTest(unittest.TestCase):
    def test_valid_records_receive_no_flags(self):
        res = score_dataset(chain(1) + chain(2), RULES)
        for r in res:
            self.assertEqual(r["score"], 0, r)
            self.assertEqual(r["riskLevel"], "NONE")
            self.assertFalse(r["flagged"])
            self.assertEqual(r["triggeredRules"], [])

    def test_duplicate_reference_triggers_r02_on_both(self):
        recs = chain(1) + chain(2)
        recs[5]["fields"]["awbNumber"] = recs[1]["fields"]["awbNumber"]
        res = by_id(score_dataset(recs, RULES))
        for rid, other in (("SHP-0001", "SHP-0002"), ("SHP-0002", "SHP-0001")):
            self.assertIn("R02", res[rid]["triggeredRules"])
            finding = res[rid]["findings"][0]
            self.assertEqual(finding["evidence"][0]["relatedRecordIds"], [other])
            self.assertIn(other, finding["explanations"][0])
            self.assertTrue(res[rid]["flagged"])

    def test_mismatched_amount_is_explained(self):
        recs = chain(1, declared=1_000_000, invoice=1_600_000, txn=1_600_000)
        res = by_id(score_dataset(recs, RULES))
        inv = res["INV-0001"]
        self.assertEqual(inv["triggeredRules"], ["R03"])
        expl = inv["findings"][0]["explanations"][0]
        self.assertIn("16,000.00 USD", expl)
        self.assertIn("10,000.00 USD", expl)
        self.assertIn("37.5%", expl)
        self.assertIn("tolerance 5.0%", expl)
        self.assertEqual(inv["findings"][0]["evidence"][0]["differenceBps"], 3750)
        self.assertEqual(res["TXN-0001"]["triggeredRules"], [])

    def test_amount_within_tolerance_does_not_fire(self):
        res = by_id(score_dataset(chain(1, declared=1_000_000, invoice=1_049_000), RULES))
        self.assertEqual(res["INV-0001"]["triggeredRules"], [])

    def test_missing_fields_handled_safely(self):
        recs = chain(1)
        del recs[2]["fields"]["amountMinor"]
        recs[2]["fields"]["currency"] = "  "
        recs[3]["fields"] = {}
        res = by_id(score_dataset(recs, RULES))
        self.assertIn("R01", res["INV-0001"]["triggeredRules"])
        ev = res["INV-0001"]["findings"][0]["evidence"]
        self.assertEqual({e["field"] for e in ev}, {"amountMinor", "currency"})
        self.assertIn("R01", res["TXN-0001"]["triggeredRules"])
        self.assertLessEqual(res["TXN-0001"]["score"], 100)

    def test_currency_mismatch_skips_amount_comparison(self):
        recs = chain(1, invoice=5_000_000)
        recs[2]["fields"]["currency"] = "EUR"
        recs[3]["fields"]["currency"] = "EUR"
        res = by_id(score_dataset(recs, RULES))
        self.assertEqual(res["INV-0001"]["triggeredRules"], ["R04"])
        self.assertEqual(res["INV-0001"]["riskLevel"], "LOW")
        self.assertFalse(res["INV-0001"]["flagged"])

    def test_date_order_rules(self):
        recs = chain(1)
        recs[0]["fields"]["arrivalAt"] = "2026-09-02T09:00:00Z"
        recs[3]["fields"]["valueDate"] = "2026-06-01T00:00:00Z"
        res = by_id(score_dataset(recs, RULES))
        self.assertEqual(res["MAN-0001"]["triggeredRules"], ["R05"])
        self.assertEqual(res["TXN-0001"]["triggeredRules"], ["R05"])
        self.assertIn("by 90 days", res["TXN-0001"]["findings"][0]["explanations"][0])

    def test_malformed_values(self):
        recs = chain(1)
        recs[2]["fields"]["issuedAt"] = "2026-02-30T10:00:00Z"
        recs[1]["fields"]["pieces"] = -2
        recs[1]["fields"]["currency"] = "XXX"
        recs[0]["fields"]["destinationAirport"] = "PCL1"
        res = by_id(score_dataset(recs, RULES))
        self.assertIn("R10", res["INV-0001"]["triggeredRules"])
        self.assertIn("R10", res["SHP-0001"]["triggeredRules"])
        self.assertIn("identical", " ".join(res["MAN-0001"]["findings"][-1]["explanations"]))

    def test_broken_and_reused_links(self):
        recs = chain(1) + chain(2)
        recs[5]["fields"]["invoiceId"] = "INV-0001"   # SHP-0002 claims INV-0001
        recs[7]["fields"]["invoiceId"] = "INV-9999"   # TXN-0002 -> missing invoice
        res = by_id(score_dataset(recs, RULES))
        self.assertEqual(res["SHP-0001"]["triggeredRules"], ["R07"])
        self.assertEqual(res["SHP-0002"]["triggeredRules"], ["R07", "R08"])
        self.assertEqual(res["SHP-0002"]["riskLevel"], "HIGH")
        self.assertEqual(res["INV-0002"]["triggeredRules"], ["R08"])
        self.assertEqual(res["TXN-0002"]["triggeredRules"], ["R08"])

    def test_score_is_bounded(self):
        recs = chain(1) + chain(2)
        f = recs[5]["fields"]
        f["awbNumber"] = recs[1]["fields"]["awbNumber"]
        f["invoiceId"] = "INV-0001"
        f["manifestId"] = "MAN-0404"
        f["pieces"] = 0
        f["commodity"] = ""
        res = by_id(score_dataset(recs, RULES))
        self.assertEqual(res["SHP-0002"]["score"], 100)
        self.assertIn("R11", res["SHP-0002"]["triggeredRules"])
        self.assertEqual(res["SHP-0002"]["riskLevel"], "HIGH")

    def test_unknown_record_type_is_handled(self):
        res = score_dataset([{"recordId": "X-1", "recordType": "BOARDING_PASS", "fields": {}}], RULES)
        self.assertEqual(res[0]["triggeredRules"], ["R10"])

    def test_identical_inputs_produce_identical_output(self):
        d = generate_dataset("mixed", 42, 100)
        a = score_dataset(copy.deepcopy(d["records"]), RULES)
        b = score_dataset(copy.deepcopy(d["records"]), RULES)
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        self.assertTrue(all(r["scoringVersion"] == a[0]["scoringVersion"] for r in a))
        self.assertIn(RULES["rulesetVersion"], a[0]["scoringVersion"])

    def test_scoring_does_not_mutate_input(self):
        d = generate_dataset("mixed", 3, 60)
        before = json.dumps(d["records"], sort_keys=True)
        score_dataset(d["records"], RULES)
        self.assertEqual(before, json.dumps(d["records"], sort_keys=True))

    def test_profiles_change_thresholds(self):
        recs = chain(1, declared=1_000_000, invoice=1_040_000)
        self.assertEqual(by_id(score_dataset(recs, RULES, "balanced"))["INV-0001"]["triggeredRules"], [])
        self.assertEqual(by_id(score_dataset(recs, RULES, "strict"))["INV-0001"]["triggeredRules"], ["R03"])
        with self.assertRaises(ValueError):
            score_dataset(recs, RULES, "nope")

    def test_level_categorisation(self):
        levels = RULES["levels"]
        self.assertEqual([level_for(s, levels) for s in (0, 1, 29, 30, 59, 60, 100)],
                         ["NONE", "LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH"])

    def test_formatting_helpers(self):
        self.assertEqual(fmt_money(123456789, "INR"), "1,234,567.89 INR")
        self.assertEqual(fmt_money(5, "USD"), "0.05 USD")
        self.assertEqual(fmt_bps(500), "5.0%")
        self.assertEqual(fmt_bps(3749), "37.5%")
        self.assertEqual(fmt_bps(14), "0.1%")


if __name__ == "__main__":
    unittest.main()
