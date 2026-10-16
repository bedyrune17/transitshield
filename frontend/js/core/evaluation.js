// Evaluation against planted synthetic ground truth (port of
// backend/shared/evaluation.py). Measures recovery of PLANTED patterns only.

const ratio = (num, den) => (den === 0 ? null : num / den);

export function evaluate(results, labels) {
  const byLabel = new Map(labels.map((l) => [l.recordId, l]));
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let unlabeled = 0;
  const perPattern = new Map();
  const misses = [];
  const falseAlarms = [];
  for (const res of results) {
    const lab = byLabel.get(res.recordId);
    if (!lab) {
      unlabeled += 1;
      continue;
    }
    const actual = Boolean(lab.isAnomalous);
    const predicted = Boolean(res.flagged);
    if (actual && predicted) tp += 1;
    else if (actual && !predicted) {
      fn += 1;
      misses.push(res.recordId);
    } else if (predicted) {
      fp += 1;
      falseAlarms.push(res.recordId);
    } else tn += 1;
    if (actual) {
      for (const pattern of lab.patterns) {
        if (!perPattern.has(pattern)) perPattern.set(pattern, { pattern, records: 0, detected: 0 });
        const stat = perPattern.get(pattern);
        stat.records += 1;
        if (predicted) stat.detected += 1;
      }
    }
  }
  const patterns = [...perPattern.keys()].sort().map((name) => {
    const stat = perPattern.get(name);
    stat.recall = ratio(stat.detected, stat.records);
    return stat;
  });
  const total = tp + fp + tn + fn;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  let f1 = null;
  if (precision !== null && recall !== null && precision + recall > 0) {
    f1 = (2 * precision * recall) / (precision + recall);
  }
  return {
    total,
    unlabeled,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision,
    recall,
    falsePositiveRate: ratio(fp, fp + tn),
    accuracy: ratio(tp + tn, total),
    f1,
    byPattern: patterns,
    falseNegativeIds: misses.sort(),
    falsePositiveIds: falseAlarms.sort(),
  };
}
