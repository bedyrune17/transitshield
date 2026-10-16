"""List every AWS resource that belongs to TransitShield (read-only).

Sources: the CloudFormation stack's resource list, plus the Resource Groups
Tagging API filtered on Project=TransitShield (catches anything tagged but
outside the stack).

Usage:  python scripts/inventory.py [--region ap-south-1] [--markdown]
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from awscli import DEFAULT_REGION, STACK_NAME, AwsCliError, aws  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default=DEFAULT_REGION)
    ap.add_argument("--markdown", action="store_true")
    a = ap.parse_args()
    try:
        res = aws("cloudformation", "list-stack-resources", "--stack-name", STACK_NAME, region=a.region)
        rows = [(r["ResourceType"], r["LogicalResourceId"], r.get("PhysicalResourceId", ""), r["ResourceStatus"])
                for r in res.get("StackResourceSummaries", [])]
    except AwsCliError:
        rows = []
        print("(no CloudFormation stack named %s in %s)" % (STACK_NAME, a.region))
    tagged = aws("resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=Project,Values=TransitShield",
                 region=a.region).get("ResourceTagMappingList", [])
    if a.markdown:
        print("| Type | Logical ID | Physical ID | Status |\n|---|---|---|---|")
        for r in sorted(rows):
            print("| %s | %s | `%s` | %s |" % r)
    else:
        for r in sorted(rows):
            print("%-40s %-28s %-60s %s" % r)
    print("\nTagged Project=TransitShield (%d):" % len(tagged))
    for t in tagged:
        print("  " + t["ResourceARN"])


if __name__ == "__main__":
    main()
