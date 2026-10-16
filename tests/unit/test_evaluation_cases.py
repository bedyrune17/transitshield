import unittest

from tests import helpers  # noqa: F401
from shared import cases
from shared.evaluation import evaluate


def lab(rid, anomalous, patterns=()):
    return {"recordId": rid, "isAnomalous": anomalous, "patterns": list(patterns), "roles": []}


class EvaluationTest(unittest.TestCase):
    def test_manually_verified_small_dataset(self):
        labels = [lab("A", True, ["P1"]), lab("B", True, ["P1"]), lab("C", True, ["P2"]),
                  lab("D", False), lab("E", False), lab("F", False), lab("G", False)]
        results = [{"recordId": "A", "flagged": True}, {"recordId": "B", "flagged": True},
                   {"recordId": "C", "flagged": False}, {"recordId": "D", "flagged": True},
                   {"recordId": "E", "flagged": False}, {"recordId": "F", "flagged": False},
                   {"recordId": "G", "flagged": False}]
        ev = evaluate(results, labels)
        self.assertEqual((ev["truePositives"], ev["falsePositives"], ev["trueNegatives"], ev["falseNegatives"]),
                         (2, 1, 3, 1))
        self.assertAlmostEqual(ev["precision"], 2 / 3)
        self.assertAlmostEqual(ev["recall"], 2 / 3)
        self.assertAlmostEqual(ev["falsePositiveRate"], 1 / 4)
        self.assertAlmostEqual(ev["accuracy"], 5 / 7)
        self.assertEqual(ev["falseNegativeIds"], ["C"])
        self.assertEqual(ev["falsePositiveIds"], ["D"])
        self.assertEqual([(p["pattern"], p["detected"], p["records"]) for p in ev["byPattern"]],
                         [("P1", 2, 2), ("P2", 0, 1)])

    def test_zero_denominators_are_none(self):
        ev = evaluate([], [])
        self.assertEqual(ev["total"], 0)
        for k in ("precision", "recall", "falsePositiveRate", "accuracy", "f1"):
            self.assertIsNone(ev[k])
        ev = evaluate([{"recordId": "A", "flagged": False}], [lab("A", False)])
        self.assertIsNone(ev["precision"])
        self.assertIsNone(ev["recall"])
        self.assertEqual(ev["falsePositiveRate"], 0.0)

    def test_unlabeled_results_are_counted_separately(self):
        ev = evaluate([{"recordId": "Z", "flagged": True}], [lab("A", True)])
        self.assertEqual(ev["unlabeled"], 1)
        self.assertEqual(ev["total"], 0)


class CaseWorkflowTest(unittest.TestCase):
    def test_valid_transitions(self):
        self.assertEqual(cases.check_transition("NEW", "UNDER_REVIEW", None), "")
        self.assertEqual(cases.check_transition("UNDER_REVIEW", "RESOLVED", "Documents reconciled"),
                         "Documents reconciled")
        self.assertEqual(cases.check_transition("RESOLVED", "UNDER_REVIEW", "New evidence arrived"),
                         "New evidence arrived")

    def test_invalid_transitions(self):
        for cur, target in (("NEW", "RESOLVED"), ("DISMISSED", "RESOLVED"), ("RESOLVED", "ESCALATED")):
            with self.assertRaises(cases.TransitionError) as ctx:
                cases.check_transition(cur, target, "long enough reason")
            self.assertEqual(ctx.exception.code, "INVALID_TRANSITION")
        with self.assertRaises(cases.TransitionError) as ctx:
            cases.check_transition("NEW", "NEW", None)
        self.assertEqual(ctx.exception.code, "NO_OP_TRANSITION")
        with self.assertRaises(cases.TransitionError) as ctx:
            cases.check_transition("NEW", "BOGUS", None)
        self.assertEqual(ctx.exception.code, "INVALID_STATUS")

    def test_reason_rules(self):
        for cur, target in (("UNDER_REVIEW", "DISMISSED"), ("ESCALATED", "RESOLVED"), ("DISMISSED", "UNDER_REVIEW")):
            with self.assertRaises(cases.TransitionError) as ctx:
                cases.check_transition(cur, target, "  ok ")
            self.assertEqual(ctx.exception.code, "REASON_REQUIRED")
        with self.assertRaises(cases.TransitionError) as ctx:
            cases.check_transition("NEW", "DISMISSED", "x" * 501)
        self.assertEqual(ctx.exception.code, "REASON_TOO_LONG")


if __name__ == "__main__":
    unittest.main()
