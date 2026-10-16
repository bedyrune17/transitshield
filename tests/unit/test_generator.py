import json
import unittest

from tests import helpers  # noqa: F401
from shared.generator import SCENARIOS, GeneratorError, generate_dataset


class GeneratorTest(unittest.TestCase):
    def test_same_seed_is_reproducible(self):
        a = generate_dataset("mixed", 42, 100)
        b = generate_dataset("mixed", 42, 100)
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_different_seed_differs(self):
        a = generate_dataset("mixed", 42, 100)
        b = generate_dataset("mixed", 43, 100)
        self.assertNotEqual(json.dumps(a["records"], sort_keys=True), json.dumps(b["records"], sort_keys=True))

    def test_size_close_to_request_and_ids_unique(self):
        for count in (20, 100, 300):
            d = generate_dataset("normal", 1, count)
            ids = [r["recordId"] for r in d["records"]]
            self.assertEqual(len(ids), len(set(ids)))
            self.assertLessEqual(len(ids), count)
            self.assertGreaterEqual(len(ids), count - 3)

    def test_labels_are_separate_from_scoring_input(self):
        d = generate_dataset("mixed", 42, 100)
        label_keys = {"isAnomalous", "patterns", "roles"}
        for r in d["records"]:
            self.assertFalse(label_keys & set(r), "label leaked into record " + r["recordId"])
            self.assertFalse(label_keys & set(r["fields"]))
        self.assertEqual({lab["recordId"] for lab in d["labels"]}, {r["recordId"] for r in d["records"]})

    def test_normal_scenario_plants_nothing(self):
        d = generate_dataset("normal", 42, 100)
        self.assertEqual(d["meta"]["anomalousRecordCount"], 0)
        self.assertEqual(d["meta"]["plantedPatterns"], [])

    def test_every_scenario_plants_what_it_reports(self):
        for scenario in SCENARIOS:
            d = generate_dataset(scenario, 42, 100)
            planted = {rid for p in d["meta"]["plantedPatterns"] for rid in p["recordIds"]}
            labelled = {lab["recordId"] for lab in d["labels"] if lab["isAnomalous"]}
            self.assertEqual(planted, labelled, scenario)
            self.assertTrue(all(p["applied"] for p in d["meta"]["plantedPatterns"]), scenario)

    def test_everything_is_marked_fictional(self):
        d = generate_dataset("mixed", 5, 60)
        for e in d["meta"]["entities"] + d["meta"]["airports"]:
            self.assertIn("(fictional)", e["name"])
        self.assertTrue(all(r["source"].startswith("synthetic-generator/") for r in d["records"]))

    def test_rejects_bad_parameters(self):
        for args in (("nope", 1, 100), ("mixed", -1, 100), ("mixed", 1, 19), ("mixed", 1, 301),
                     ("mixed", True, 100), ("mixed", 1.5, 100), ("mixed", 2 ** 32, 100)):
            with self.assertRaises(GeneratorError):
                generate_dataset(*args)

    def test_links_reference_existing_records_in_normal_data(self):
        d = generate_dataset("normal", 11, 100)
        ids = {r["recordId"] for r in d["records"]}
        entity_ids = {e["entityId"] for e in d["meta"]["entities"]}
        for r in d["records"]:
            for link in r["linkedEntityIds"]:
                self.assertIn(link, ids | entity_ids)


if __name__ == "__main__":
    unittest.main()
