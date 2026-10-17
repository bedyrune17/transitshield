# Deployment

## Prerequisites
* AWS CLI v2 (≥ 2.32 for `aws login`), Python ≥ 3.11, Node ≥ 20 (tests only).
* An AWS account whose plan and free allowances you have checked
  (see [COST_SAFETY.md](COST_SAFETY.md)).
* No access keys are needed: `aws login` turns your console session into
  short-lived CLI credentials that refresh automatically.

## Procedure (what was actually run, 2026-10-16)

```bash
aws login --region ap-south-1                    # browser approval; temporary credentials
python scripts/cost_check.py                     # read-only gate (capacity, alarms, metrics, name clashes)
python scripts/deploy.py deploy --account <id>   # gate + unit tests + package + CloudFormation + code upload
python scripts/deploy.py create-user --account <id> --email <user> --groups analysts,admins
TS_INTEGRATION=1 python -m unittest tests.integration.test_live_api -v
git push origin main                             # GitHub Actions: tests, then GitHub Pages
```

`deploy.py deploy` performs, in order:
1. `sts get-caller-identity` → refuses unless the account equals `--account`;
2. `cost_check.run_checks()` → refuses on any problem;
3. the Python unit-test suite;
4. builds `build/api.zip` and `build/worker.zip` (backend code only, no
   third-party packages, reproducible timestamps);
5. `aws cloudformation deploy` of `infrastructure/template.yaml` with the
   stack tag `Project=TransitShield` (`CAPABILITY_NAMED_IAM`);
6. `aws lambda update-function-code` for both functions (direct upload — no S3
   bucket) and waits for the update;
7. writes the **public** identifiers to `frontend/js/config.js`.

The Cognito hosted-UI domain prefix is derived from a hash of the account ID,
so the public frontend does not reveal the account number. A user pool can
only have one domain; the script therefore changes a domain in two steps
(remove, then add).

**If the invitation email never arrives** (institutional mail systems often
filter `no-reply@verificationemail.com`), set the password directly from
your own terminal — the prompt is hidden and the password is never echoed,
logged or stored:
```powershell
& .\scripts\set_cognito_password.ps1 -UserPoolId <pool-id> -Email <user>
```
Note: the hosted UI's "Forgot your password?" cannot help a user who has never
signed in (status `FORCE_CHANGE_PASSWORD`); Cognito sends no code in that state.

Other commands:
```bash
python scripts/deploy.py outputs                       # stack status + outputs
python scripts/deploy.py pause-worker  --account <id>  # stop idle SQS polling (jobs wait in the queue)
python scripts/deploy.py resume-worker --account <id>
python scripts/inventory.py                            # every TransitShield resource
python scripts/cleanup.py --account <id> [--yes]       # delete only the TransitShield stack
```

## Resources created (stack `transitshield`, region `ap-south-1`)

All tagged `Project=TransitShield` where the service supports tags.

| Type | Name |
|---|---|
| DynamoDB table (8 RCU / 8 WCU) | `transitshield-records` |
| DynamoDB table (4 / 4, TTL `expiresAt`) | `transitshield-jobs` |
| DynamoDB table (4 / 4) | `transitshield-cases` |
| DynamoDB table (5 / 5) | `transitshield-audit` |
| SQS queue (SSE-SQS, visibility 180 s, retention 1 day, redrive → DLQ after 5) | `transitshield-jobs` |
| SQS queue (SSE-SQS, retention 4 days) | `transitshield-dlq` |
| Lambda function (python3.13, arm64, 256 MB, 10 s) + Function URL (AWS_IAM, CORS) | `transitshield-api` |
| Lambda function (python3.13, arm64, 256 MB, 30 s) | `transitshield-worker` |
| Lambda event source mapping (batch 5, partial batch failures, max concurrency 2) | queue → worker |
| Lambda permissions (InvokeFunctionUrl with AuthType AWS_IAM; InvokeFunction only via function URL) | for the signed-in-user role |
| CloudWatch log groups (3-day retention) | `/aws/lambda/transitshield-api`, `/aws/lambda/transitshield-worker` |
| CloudWatch alarm (DLQ visible > 0, no actions) | `transitshield-dlq-not-empty` |
| Cognito user pool (Lite, admin-invite only) + groups `analysts`, `admins` | `transitshield-users` |
| Cognito user pool client (public, code flow, no secret) | `transitshield-web` |
| Cognito hosted UI domain (classic) | `transitshield-<hash>.auth.ap-south-1.amazoncognito.com` |
| Cognito identity pool (authenticated only) + role attachment | `transitshield_identities` |
| IAM roles | `transitshield-api-role`, `transitshield-worker-role`, `transitshield-signed-in-user-role` |

Live endpoints are listed in `frontend/js/config.js` (public identifiers).

## GitHub Pages

`.github/workflows/pages.yml` runs both test suites on every push to `main`
and, only if they pass, publishes the `frontend/` folder to GitHub Pages
(`https://bedyrune17.github.io/transitshield/`). No AWS credentials or other
secrets are stored in GitHub. The Pages origin and callback URL are
registered in the Cognito app client and the Function URL CORS settings.
