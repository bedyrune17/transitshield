"""Cross-language parity: the browser (JavaScript) port of the generator,
scoring engine and evaluation must produce exactly the same output as the
Python backend for the same seed, scenario and rule version."""

import json
import os
import shutil
import subprocess
import unittest

from tests import helpers  # noqa: F401  (sets sys.path)
from shared.evaluation import evaluate
from shared.generator import SCENARIOS, generate_dataset
from shared.prng import Mulberry32
from shared.scoring import load_rules, score_dataset

NODE = shutil.which("node")
DUMP = os.path.join(helpers.ROOT, "tests", "js", "parity_dump.mjs")


def _canonical(obj):
    return json.loads(json.dumps(obj, sort_keys=True))


@unittest.skipIf(NODE is None, "node is not installed")
class ParityTest(unittest.TestCase):
    rules = load_rules()

    def _compare(self, scenario, seed, count):
        proc = subprocess.run([NODE, DUMP, scenario, str(seed), str(count)], capture_output=True, text=True,
                              timeout=60, check=True)
        js = json.loads(proc.stdout)
        py_data = generate_dataset(scenario, seed, count)
        self.assertEqual(_canonical(py_data), _canonical(js["dataset"]),
                         "generator output differs for %s/%s/%s" % (scenario, seed, count))
        for profile in self.rules["profiles"]:
            res = score_dataset(py_data["records"], self.rules, profile)
            self.assertEqual(_canonical(res), _canonical(js["results"][profile]),
                             "scoring differs for %s/%s/%s" % (scenario, seed, profile))
            self.assertEqual(_canonical(evaluate(res, py_data["labels"])), _canonical(js["evaluation"][profile]))
        rng = Mulberry32(seed)
        self.assertEqual([rng.next_u32() for _ in range(16)], js["prng"])

    def test_all_scenarios_default_seed(self):
        for scenario in SCENARIOS:
            with self.subTest(scenario=scenario):
                self._compare(scenario, 42, 100)

    def test_other_seeds_and_sizes(self):
        for scenario, seed, count in (("mixed", 0, 20), ("mixed", 7, 300), ("mixed", 4294967295, 150),
                                      ("repeated_entities", 2026, 120), ("missing_fields", 99, 60),
                                      ("invalid_timestamps", 123456, 100)):
            with self.subTest(scenario=scenario, seed=seed, count=count):
                self._compare(scenario, seed, count)

    def test_frontend_rules_copy_is_identical(self):
        with open(os.path.join(helpers.ROOT, "backend", "shared", "risk_rules.json"), "rb") as a, \
                open(os.path.join(helpers.ROOT, "frontend", "data", "risk_rules.json"), "rb") as b:
            self.assertEqual(a.read(), b.read(), "run: python scripts/sync_rules.py")


if __name__ == "__main__":
    unittest.main()
