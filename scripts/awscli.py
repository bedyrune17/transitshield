"""Minimal helpers around the AWS CLI (no boto3 needed on the dev machine).

Credentials come from the CLI's own configuration (for example the
short-lived credentials created by `aws login`). This module never reads,
prints or stores credentials.
"""

import json
import shutil
import subprocess
import sys

DEFAULT_REGION = "ap-south-1"
STACK_NAME = "transitshield"
PROJECT_TAG = ("Project", "TransitShield")


class AwsCliError(RuntimeError):
    pass


def aws(*args, region=DEFAULT_REGION, expect_json=True, check=True):
    exe = shutil.which("aws")
    if not exe:
        raise AwsCliError("AWS CLI v2 not found on PATH")
    cmd = [exe, *args, "--region", region]
    if expect_json:
        cmd += ["--output", "json"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise AwsCliError("aws %s failed: %s" % (" ".join(args[:2]), proc.stderr.strip()[-800:]))
    if not expect_json:
        return proc.stdout
    out = proc.stdout.strip()
    return json.loads(out) if out else {}


def caller_identity(region=DEFAULT_REGION):
    return aws("sts", "get-caller-identity", region=region)


def require_account(expected, region=DEFAULT_REGION):
    """Abort unless the CLI is pointed at the expected account."""
    ident = caller_identity(region)
    if not expected:
        print("Refusing to continue: pass --account <12-digit id> so the target account is explicit.")
        sys.exit(2)
    if ident["Account"] != expected:
        print("Refusing to continue: CLI account %s does not match --account %s." % (ident["Account"], expected))
        sys.exit(2)
    return ident


def stack_outputs(region=DEFAULT_REGION, stack=STACK_NAME):
    res = aws("cloudformation", "describe-stacks", "--stack-name", stack, region=region)
    st = res["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in st.get("Outputs", [])}, st
