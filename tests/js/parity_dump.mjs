// Emits generator + scoring + evaluation output as JSON for the Python
// parity test (tests/unit/test_parity.py). Usage:
//   node tests/js/parity_dump.mjs <scenario> <seed> <count>
import { readFileSync } from 'node:fs';
import { generateDataset } from '../../frontend/js/core/generator.js';
import { scoreDataset } from '../../frontend/js/core/scoring.js';
import { evaluate } from '../../frontend/js/core/evaluation.js';
import { Mulberry32 } from '../../frontend/js/core/prng.js';

const rules = JSON.parse(readFileSync(new URL('../../backend/shared/risk_rules.json', import.meta.url), 'utf-8'));
const [scenario, seed, count] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const data = generateDataset(scenario, seed, count);
const out = { dataset: data, results: {}, evaluation: {} };
for (const profile of Object.keys(rules.profiles)) {
  const res = scoreDataset(data.records, rules, profile);
  out.results[profile] = res;
  out.evaluation[profile] = evaluate(res, data.labels);
}
const rng = new Mulberry32(seed);
out.prng = Array.from({ length: 16 }, () => rng.nextU32());
process.stdout.write(JSON.stringify(out));
