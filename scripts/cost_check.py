"""Read-only cost & eligibility checks for the target account/region.

Verifies, using only read APIs:
  * DynamoDB: total provisioned RCU/WCU in the region (excluding this
    project's own tables) leaves room for TransitShield's 21 RCU / 21 WCU
    inside the 25/25 always-free allowance (per Region, per payer account).
  * CloudWatch: alarm count stays within the 10 free alarm metrics.
  * CloudWatch: custom metric count stays within the 10 free custom metrics
    (TransitShield emits 5 via Embedded Metric Format).
  * No unexpected resources already use TransitShield's names.
It cannot read the account's billing plan through the CLI; that was checked
in the Billing console and is recorded in docs/COST_SAFETY.md.

Usage:  python scripts/cost_check.py [--region ap-south-1]
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from awscli import DEFAULT_REGION, aws  # noqa: E402

OUR_TABLES = {"transitshield-records", "transitshield-jobs", "transitshield-cases", "transitshield-audit"}
OUR_RCU = 21
OUR_WCU = 21
FREE_RCU = 25
FREE_WCU = 25
OUR_ALARMS = 1
OUR_CUSTOM_METRICS = 5


def run_checks(region=DEFAULT_REGION, quiet=False):
    problems = []
    say = (lambda *a: None) if quiet else print

    tables = aws("dynamodb", "list-tables", region=region).get("TableNames", [])
    rcu = wcu = 0
    for t in tables:
        if t in OUR_TABLES:
            continue
        d = aws("dynamodb", "describe-table", "--table-name", t, region=region)["Table"]
        mode = (d.get("BillingModeSummary") or {}).get("BillingMode", "PROVISIONED")
        if mode == "PROVISIONED":
            rcu += d["ProvisionedThroughput"]["ReadCapacityUnits"]
            wcu += d["ProvisionedThroughput"]["WriteCapacityUnits"]
            for g in d.get("GlobalSecondaryIndexes", []) or []:
                rcu += g["ProvisionedThroughput"]["ReadCapacityUnits"]
                wcu += g["ProvisionedThroughput"]["WriteCapacityUnits"]
    say("- DynamoDB provisioned capacity used by OTHER tables in %s: %d RCU / %d WCU" % (region, rcu, wcu))
    if rcu + OUR_RCU > FREE_RCU or wcu + OUR_WCU > FREE_WCU:
        problems.append("DynamoDB: %d+%d RCU / %d+%d WCU would exceed the 25/25 always-free provisioned capacity"
                        % (rcu, OUR_RCU, wcu, OUR_WCU))
    else:
        say("  OK with TransitShield: %d RCU / %d WCU of 25/25 free" % (rcu + OUR_RCU, wcu + OUR_WCU))

    alarms = aws("cloudwatch", "describe-alarms", region=region).get("MetricAlarms", [])
    others = [a for a in alarms if not a["AlarmName"].startswith("transitshield-")]
    say("- CloudWatch alarms not owned by TransitShield in %s: %d" % (region, len(others)))
    if len(others) + OUR_ALARMS > 10:
        problems.append("CloudWatch: alarms would exceed the 10 free alarm metrics")

    metrics = aws("cloudwatch", "list-metrics", region=region).get("Metrics", [])
    custom = {(m["Namespace"], m["MetricName"], tuple(sorted((d["Name"], d["Value"]) for d in m.get("Dimensions", []))))
              for m in metrics if not m["Namespace"].startswith("AWS/") and m["Namespace"] != "TransitShield"}
    say("- Custom metrics not owned by TransitShield: %d" % len(custom))
    if len(custom) + OUR_CUSTOM_METRICS > 10:
        problems.append("CloudWatch: custom metrics would exceed the 10 free custom metrics")

    queues = aws("sqs", "list-queues", "--queue-name-prefix", "transitshield", region=region).get("QueueUrls", [])
    stacks = aws("cloudformation", "list-stacks", region=region).get("StackSummaries", [])
    ours = [s for s in stacks if s["StackName"] == "transitshield" and s["StackStatus"] != "DELETE_COMPLETE"]
    if queues and not ours:
        problems.append("SQS queues named transitshield* exist outside the TransitShield stack: %s" % queues)
    say("- Existing TransitShield stack: %s" % (ours[0]["StackStatus"] if ours else "none"))
    return problems


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default=DEFAULT_REGION)
    a = ap.parse_args()
    issues = run_checks(a.region)
    if issues:
        print("FAIL " + "\nFAIL ".join(issues))
        sys.exit(1)
    print("OK cost/eligibility checks passed for %s" % a.region)
