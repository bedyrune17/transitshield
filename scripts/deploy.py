"""Deploy TransitShield to AWS (CloudFormation + direct Lambda code upload).

Safety gates (all must pass before anything is created or changed):
  1. --account must equal the account the AWS CLI is authenticated to.
  2. The region is explicit (default ap-south-1).
  3. scripts/cost_check.py's checks pass (DynamoDB always-free capacity
     headroom in the region, alarm count, no conflicting resources).
  4. The local unit-test suite passes (skip with --skip-tests).
No S3 bucket is used: Lambda code is uploaded with UpdateFunctionCode.

Usage:
  python scripts/deploy.py deploy --account 123456789012
  python scripts/deploy.py create-user --account 123456789012 --email you@example.edu --groups analysts,admins
  python scripts/deploy.py pause-worker|resume-worker --account 123456789012
  python scripts/deploy.py outputs
"""

import argparse
import datetime
import hashlib
import io
import json
import os
import subprocess
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from awscli import DEFAULT_REGION, STACK_NAME, AwsCliError, aws, require_account, stack_outputs  # noqa: E402
import cost_check  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
TEMPLATE = os.path.join(ROOT, "infrastructure", "template.yaml")
CONFIG_JS = os.path.join(ROOT, "frontend", "js", "config.js")


def build_zip(name, entry_dir):
    """api.zip / worker.zip containing <entry_dir>/ and shared/ (no third-party deps)."""
    os.makedirs(BUILD, exist_ok=True)
    path = os.path.join(BUILD, name + ".zip")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for pkg in (entry_dir, "shared"):
            base = os.path.join(ROOT, "backend", pkg)
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = [d for d in dirnames if d != "__pycache__"]
                for fn in sorted(filenames):
                    if fn.endswith((".py", ".json")):
                        full = os.path.join(dirpath, fn)
                        arc = os.path.relpath(full, os.path.join(ROOT, "backend")).replace(os.sep, "/")
                        info = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))  # reproducible zip
                        info.external_attr = 0o644 << 16
                        with open(full, "rb") as fh:
                            zf.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
    with open(path, "wb") as fh:
        fh.write(buf.getvalue())
    return path


def run_tests():
    print("- running unit tests ...")
    proc = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests/unit", "-t", "."], cwd=ROOT,
                          capture_output=True, text=True)
    tail = (proc.stderr or proc.stdout).strip().splitlines()[-3:]
    print("  " + " | ".join(tail))
    if proc.returncode != 0:
        print("Unit tests failed; not deploying.")
        sys.exit(1)


def write_frontend_config(out, region):
    cfg = {
        "region": region,
        "userPoolId": out["UserPoolId"],
        "userPoolClientId": out["UserPoolClientId"],
        "identityPoolId": out["IdentityPoolId"],
        "cognitoDomain": out["CognitoDomain"],
        "apiUrl": out["ApiUrl"],
        "apiAuthType": out.get("ApiAuthType", "AWS_IAM"),
        "stackName": STACK_NAME,
        "deployedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    body = ["// Public, NON-SECRET frontend configuration. Written by scripts/deploy.py",
            "// after a successful AWS deployment. These identifiers are safe to publish:",
            "// they do not grant access on their own - every API call must still be",
            "// signed with short-lived identity-pool credentials of a signed-in user AND",
            "// carry a Cognito access token that the API verifies server-side.",
            "// Leave values empty to run in local demo mode only.",
            "export default {"]
    for k, v in cfg.items():
        body.append("  %s: %s," % (k, json.dumps(v)))
    body.append("};")
    with open(CONFIG_JS, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(body) + "\n")
    print("- wrote frontend/js/config.js (public identifiers only)")


def cmd_deploy(args):
    ident = require_account(args.account, args.region)
    print("- target account %s, region %s, caller %s" % (ident["Account"], args.region, ident["Arn"].split(":")[-1]))
    problems = cost_check.run_checks(args.region, quiet=False)
    if problems:
        print("Cost/eligibility gate failed:\n  - " + "\n  - ".join(problems))
        sys.exit(3)
    if not args.skip_tests:
        run_tests()
    api_zip = build_zip("api", "api")
    worker_zip = build_zip("worker", "worker")
    print("- packaged %s (%d KB), %s (%d KB)" % (os.path.basename(api_zip), os.path.getsize(api_zip) // 1024,
                                                  os.path.basename(worker_zip), os.path.getsize(worker_zip) // 1024))
    # Domain prefix is derived from (not equal to) the account ID so the public
    # frontend config does not reveal the account number.
    prefix = "transitshield-" + hashlib.sha256(ident["Account"].encode()).hexdigest()[:10]
    params = ["CognitoDomainPrefix=" + prefix, "ApiAuthType=" + args.auth_type]
    print("- deploying CloudFormation stack '%s' (this can take a few minutes) ..." % STACK_NAME)
    first = list(params)
    try:
        existing, _ = stack_outputs(args.region)
        current = existing.get("CognitoDomain", "").split(".")[0]
        if current and current != prefix:
            first[0] = "CognitoDomainPrefix=" + current  # change the domain in a separate step below
    except AwsCliError:
        pass
    aws("cloudformation", "deploy", "--template-file", TEMPLATE, "--stack-name", STACK_NAME,
        "--capabilities", "CAPABILITY_NAMED_IAM", "--no-fail-on-empty-changeset",
        "--tags", "Project=TransitShield", "--parameter-overrides", *first,
        region=args.region, expect_json=False)
    out, _ = stack_outputs(args.region)
    if out.get("CognitoDomain", "").split(".")[0] != prefix:
        # A user pool holds one domain, so a prefix change is remove-then-add.
        print("- Cognito domain differs from %s; recreating it in two steps ..." % prefix)
        aws("cloudformation", "deploy", "--template-file", TEMPLATE, "--stack-name", STACK_NAME,
            "--capabilities", "CAPABILITY_NAMED_IAM", "--no-fail-on-empty-changeset", "--tags", "Project=TransitShield",
            "--parameter-overrides", "CognitoDomainPrefix=", "ApiAuthType=" + args.auth_type,
            region=args.region, expect_json=False)
        aws("cloudformation", "deploy", "--template-file", TEMPLATE, "--stack-name", STACK_NAME,
            "--capabilities", "CAPABILITY_NAMED_IAM", "--no-fail-on-empty-changeset", "--tags", "Project=TransitShield",
            "--parameter-overrides", *params, region=args.region, expect_json=False)
        out, _ = stack_outputs(args.region)
    for fn, zpath in ((out["ApiFunctionName"], api_zip), (out["WorkerFunctionName"], worker_zip)):
        print("- uploading code to %s ..." % fn)
        aws("lambda", "update-function-code", "--function-name", fn, "--zip-file", "fileb://" + zpath, region=args.region)
        aws("lambda", "wait", "function-updated-v2", "--function-name", fn, region=args.region, expect_json=False)
    write_frontend_config(out, args.region)
    print("OK deployed. API: %s" % out["ApiUrl"])


def cmd_outputs(args):
    out, st = stack_outputs(args.region)
    print(json.dumps({"StackStatus": st["StackStatus"], **out}, indent=2))


def cmd_worker(args, enabled):
    require_account(args.account, args.region)
    out, _ = stack_outputs(args.region)
    aws("lambda", "update-event-source-mapping", "--uuid", out["WorkerEventSourceMappingId"],
        "--enabled" if enabled else "--no-enabled", region=args.region)
    print("OK worker trigger %s (queued jobs %s)." % ("enabled" if enabled else "paused",
                                                   "will be processed" if enabled else "wait in SQS until resumed"))


def cmd_create_user(args):
    require_account(args.account, args.region)
    out, _ = stack_outputs(args.region)
    pool = out["UserPoolId"]
    # Cognito generates the temporary password and emails it to the user; this
    # script never sees or prints a password.
    aws("cognito-idp", "admin-create-user", "--user-pool-id", pool, "--username", args.email,
        "--user-attributes", "Name=email,Value=" + args.email, "Name=email_verified,Value=true",
        "--desired-delivery-mediums", "EMAIL", region=args.region)
    for g in [x for x in args.groups.split(",") if x]:
        aws("cognito-idp", "admin-add-user-to-group", "--user-pool-id", pool, "--username", args.email,
            "--group-name", g, region=args.region, expect_json=False)
    print("OK invited %s (groups: %s). Cognito emailed a temporary password." % (args.email, args.groups))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("deploy", "outputs", "pause-worker", "resume-worker", "create-user"):
        sp = sub.add_parser(name)
        sp.add_argument("--region", default=DEFAULT_REGION)
        sp.add_argument("--account", default=os.environ.get("TS_EXPECTED_ACCOUNT"))
        if name == "deploy":
            sp.add_argument("--skip-tests", action="store_true")
            sp.add_argument("--auth-type", choices=["AWS_IAM", "NONE"], default="AWS_IAM")
        if name == "create-user":
            sp.add_argument("--email", required=True)
            sp.add_argument("--groups", default="analysts")
    args = p.parse_args()
    try:
        if args.cmd == "deploy":
            cmd_deploy(args)
        elif args.cmd == "outputs":
            cmd_outputs(args)
        elif args.cmd == "pause-worker":
            cmd_worker(args, False)
        elif args.cmd == "resume-worker":
            cmd_worker(args, True)
        elif args.cmd == "create-user":
            cmd_create_user(args)
    except AwsCliError as err:
        print("ERROR:", err)
        sys.exit(1)


if __name__ == "__main__":
    main()
