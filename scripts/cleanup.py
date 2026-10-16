"""Remove ONLY the TransitShield resources from AWS.

Safety:
  * --account must match the CLI's account; region is explicit.
  * Only the CloudFormation stack named 'transitshield' is deleted, and only
    if it carries the tag Project=TransitShield.
  * Nothing else is touched. After deletion the script lists anything still
    tagged Project=TransitShield so it can be reviewed manually.
  * Requires --yes (no interactive prompt that could be skipped by accident).

Usage:  python scripts/cleanup.py --account 123456789012 --yes
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from awscli import DEFAULT_REGION, STACK_NAME, AwsCliError, aws, require_account  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default=DEFAULT_REGION)
    ap.add_argument("--account", default=os.environ.get("TS_EXPECTED_ACCOUNT"))
    ap.add_argument("--yes", action="store_true", help="actually delete (otherwise dry run)")
    a = ap.parse_args()
    require_account(a.account, a.region)
    try:
        st = aws("cloudformation", "describe-stacks", "--stack-name", STACK_NAME, region=a.region)["Stacks"][0]
    except AwsCliError:
        print("No stack named %s in %s; nothing to delete." % (STACK_NAME, a.region))
        return
    tags = {t["Key"]: t["Value"] for t in st.get("Tags", [])}
    if tags.get("Project") != "TransitShield":
        print("Stack %s is not tagged Project=TransitShield; refusing to delete it." % STACK_NAME)
        sys.exit(2)
    res = aws("cloudformation", "list-stack-resources", "--stack-name", STACK_NAME, region=a.region)
    print("Stack %s (%s) contains:" % (STACK_NAME, st["StackStatus"]))
    for r in res.get("StackResourceSummaries", []):
        print("  - %-34s %s" % (r["ResourceType"], r.get("PhysicalResourceId", "")))
    if not a.yes:
        print("\nDry run. Re-run with --yes to delete exactly these resources.")
        return
    aws("cloudformation", "delete-stack", "--stack-name", STACK_NAME, region=a.region, expect_json=False)
    print("Deleting ... (waiting for CloudFormation)")
    aws("cloudformation", "wait", "stack-delete-complete", "--stack-name", STACK_NAME, region=a.region, expect_json=False)
    left = aws("resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=Project,Values=TransitShield",
               region=a.region).get("ResourceTagMappingList", [])
    print("OK stack deleted.")
    if left:
        print("Still tagged Project=TransitShield (tag index can lag a few minutes; review manually):")
        for t in left:
            print("  " + t["ResourceARN"])
    else:
        print("OK no remaining resources tagged Project=TransitShield in %s." % a.region)
    print("Local build artefacts (build/) and frontend/js/config.js values can be reset with: git checkout frontend/js/config.js")


if __name__ == "__main__":
    main()
