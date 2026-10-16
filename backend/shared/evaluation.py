"""Evaluate scoring results against the planted synthetic ground truth.

These metrics only describe how well the demo rules recover patterns that
were deliberately planted in fictional data. They say nothing about
real-world detection performance.
"""


def _ratio(num: int, den: int):
    return None if den == 0 else num / den


def evaluate(results, labels) -> dict:
    """``results``: scoring outputs (need recordId + flagged).
    ``labels``: ground-truth entries (recordId, isAnomalous, patterns)."""
    by_label = {lab["recordId"]: lab for lab in labels}
    tp = fp = tn = fn = 0
    unlabeled = 0
    per_pattern = {}
    misses = []
    false_alarms = []
    for res in results:
        lab = by_label.get(res["recordId"])
        if lab is None:
            unlabeled += 1
            continue
        actual = bool(lab["isAnomalous"])
        predicted = bool(res["flagged"])
        if actual and predicted:
            tp += 1
        elif actual and not predicted:
            fn += 1
            misses.append(res["recordId"])
        elif predicted:
            fp += 1
            false_alarms.append(res["recordId"])
        else:
            tn += 1
        if actual:
            for pattern in lab["patterns"]:
                stat = per_pattern.setdefault(pattern, {"pattern": pattern, "records": 0, "detected": 0})
                stat["records"] += 1
                if predicted:
                    stat["detected"] += 1
    patterns = []
    for name in sorted(per_pattern):
        stat = per_pattern[name]
        stat["recall"] = _ratio(stat["detected"], stat["records"])
        patterns.append(stat)
    total = tp + fp + tn + fn
    precision = _ratio(tp, tp + fp)
    recall = _ratio(tp, tp + fn)
    f1 = None
    if precision is not None and recall is not None and (precision + recall) > 0:
        f1 = 2 * precision * recall / (precision + recall)
    return {
        "total": total,
        "unlabeled": unlabeled,
        "truePositives": tp,
        "falsePositives": fp,
        "trueNegatives": tn,
        "falseNegatives": fn,
        "precision": precision,
        "recall": recall,
        "falsePositiveRate": _ratio(fp, fp + tn),
        "accuracy": _ratio(tp + tn, total),
        "f1": f1,
        "byPattern": patterns,
        "falseNegativeIds": sorted(misses),
        "falsePositiveIds": sorted(false_alarms),
    }
