# Cost safety and eligibility

**Checks performed on 2026-10-16** (account plan, region, prices and free-tier
terms). Re-check before reusing this project later: AWS offers change.

## 1. Account and plan (checked in the AWS Billing console)

| Item | Finding |
|---|---|
| Account plan | **AWS Free plan** (console banner: *"Your free plan account does not get charged. Credits cover your free plan costs."*) |
| Credits | One "AWS Free Tier" credit of USD 100, start 2026-08-06, expiry 2027-08-06; about USD 68 estimated remaining on 2026-10-16. Part had already been used by **pre-existing, unrelated resources** in the account (EC2, VPC, Glue, S3), not by TransitShield. |
| Free plan rules (aws.amazon.com/free) | No charges unless the account is upgraded to the Paid plan. The plan ends 6 months after account creation or when credits run out, whichever is first; the account is then suspended (data kept 90 days) unless upgraded. **We did not and will not upgrade the plan.** |
| Region | `ap-south-1` (Mumbai). Lambda, SQS, DynamoDB, Cognito (user pools + identity pools) and CloudWatch are all available there. |
| CLI access | Short-lived console-derived credentials via `aws login` (no access keys created). Note: the console session is the **root** user; see "Residual risks". |

**Out-of-pocket cost: USD 0, guaranteed by the Free plan** (it cannot bill a
card while it stays on the Free plan). Separately, the design is sized to stay
inside the **Always Free** allowances, which (per aws.amazon.com/free) apply on
both plans and do not need credits.

## 2. Service-by-service classification

Status key: **AF** = verified covered by an Always Free allowance at our
usage; **CR** = would only consume Free-plan credits; **PB** = potentially
billable; **NV** = not verified.

| Service / feature | Configuration | Free allowance (source: AWS pricing page, 2026-10-16) | Expected usage | Status |
|---|---|---|---|---|
| AWS Lambda (2 functions, arm64, 256 MB) | API 10 s timeout, worker 30 s | 1M requests + 400,000 GB-s / month | well below 10k requests and 1,000 GB-s / month for a demo | **AF** |
| Lambda Function URL (AWS_IAM) | 1 URL | no separate function-URL charge on the pricing page; requests are Lambda requests | unsigned requests are rejected by IAM before invocation | **AF** |
| Amazon SQS (2 standard queues, SSE-SQS) | long polling 20 s | 1M requests / month, all regions | idle event-source polling **measured at 360 empty receives/hour ≈ 0.26M / 30 days** (CloudWatch `NumberOfEmptyReceives`, 2026-10-17) + a few thousand app requests | **AF** (largest consumer; pause option below) |
| Amazon DynamoDB (4 tables, PROVISIONED, Standard class) | 21 RCU / 21 WCU total, no GSIs, no auto scaling, no PITR, TTL on jobs | 25 RCU, 25 WCU, 25 GB storage **per Region per payer account** (provisioned capacity) | well under 1 GB | **AF** — `scripts/cost_check.py` verified 0 RCU/WCU used by other tables in ap-south-1 (the only other table is on-demand) |
| DynamoDB TTL deletes | jobs + rate counters | TTL deletes are free | — | **AF** |
| Amazon Cognito user pool | **Lite** tier, no SMS, no MFA, no advanced security, classic hosted UI | 10,000 MAU / month (Lite or Essentials), does not expire | 1–5 users | **AF** |
| Cognito identity pool | authenticated identities only | "provided at no charge" | — | **AF** |
| Cognito default email (COGNITO_DEFAULT) | invitation email | daily-capped AWS-managed sending; pricing page does not state a price for the default option | 1 email sent | **NV** — worst case a fraction of a cent at SES rates, covered by Free-plan credits, **not** out of pocket |
| CloudWatch Logs | 2 log groups, **3-day retention** | 5 GB ingestion + 5 GB archive storage | a few MB | **AF** |
| CloudWatch custom metrics (EMF) | 5 metric names, 1 dimension | 10 custom metrics | 5 | **AF** (cost_check verified 0 other custom metrics) |
| CloudWatch alarm | 1 standard-resolution alarm (DLQ depth) | 10 alarm metrics | 1 (+1 pre-existing unrelated alarm) | **AF** |
| CloudWatch API (GetMetricStatistics, DescribeAlarms) | dashboard reads, cached 30 s in the API | 1M API requests (excludes GetMetricData) | a few thousand | **AF** |
| AWS CloudFormation | 1 stack, AWS::* resource types only | no charge for AWS-namespace resource handlers | — | **AF** |
| IAM | 3 roles | IAM has no charge | — | **AF** |
| GitHub Pages | public repository | free for public repositories | — | free (not AWS) |

**Not used (deliberately):** API Gateway (12-month offers became credits on the
new plan), S3 (no artifact bucket — code is uploaded directly to Lambda),
Bedrock, Textract, SageMaker, EC2, RDS, NAT gateways, KMS customer keys, SNS
(no notification channel is needed; the alarm state is shown in the app),
EventBridge, AWS Budgets (a budget alert is not a spending cap, and the Free
plan already prevents charges).

## 3. Safeguards implemented in the project

1. **Resource inventory:** `python scripts/inventory.py` (stack resources +
   everything tagged `Project=TransitShield`). See `docs/DEPLOYMENT.md`.
2. **Tags:** every taggable resource carries `Project=TransitShield` (template
   tags + stack-level tag).
3. **Account/region gate:** `deploy.py`, `cleanup.py` and the worker
   pause/resume commands refuse to run unless `--account` equals the CLI's
   account; the region is explicit (`ap-south-1`).
4. **Cost/eligibility gate:** `scripts/cost_check.py` runs before every
   deploy (DynamoDB capacity headroom, alarm and custom-metric counts,
   conflicting resources). Deploy aborts on any problem.
5. **This document** lists limits, assumptions and residual risks.
6. **Scoped cleanup:** `scripts/cleanup.py` deletes only the stack named
   `transitshield` and only if it is tagged `Project=TransitShield`; it is a dry
   run unless `--yes` is given.
7. **Local mode** needs no AWS at all.
8. **No idle billable resources:** no instances, NAT, provisioned concurrency,
   or paid storage classes. Log retention 3 days. Job items expire (TTL 7 days).
9. **No automatic plan upgrade** anywhere; the scripts never touch billing.
10. **Abuse limits:** unsigned traffic is rejected by IAM before invocation;
    per-user rate limits (datasets 10/h, jobs 30/10 min, case writes 120/10 min)
    plus a global cap of 300 jobs/hour; ≤ 8 datasets × ≤ 300 records; body
    ≤ 8 KB; worker concurrency capped at 2.

## 4. Known usage drivers and how to reduce them

* **Idle SQS polling.** A Lambda SQS event source long-polls the queue even
  when it is empty. The documentation does not give an idle poller count, so we
  measured it: the queue's `NumberOfEmptyReceives` metric shows a steady **360
  per hour** over 12 idle hours (two 20-second long-poll connections), i.e.
  ~8,640 per day ≈ **0.26M per 30 days** — about a quarter of the 1M free
  requests and the largest share of our SQS usage. When not demonstrating,
  pause it:
  `python scripts/deploy.py pause-worker --account <id>` (jobs then wait in
  the queue) and `resume-worker` before a demo.
* **DynamoDB throughput.** Scoring 300 records consumes ~300–600 WCU, which
  the 8 WCU records table absorbs using burst capacity (up to 300 s of unused
  capacity) and adaptive client retries. Large repeated loads would only be
  throttled (slower), never billed, because capacity is fixed.

## 5. Residual risks and assumptions

* Pricing pages were read on 2026-10-16. AWS can change free-tier terms.
* The Always Free allowances are shared with other workloads in the same
  account; the pre-existing unrelated resources (a running t3.micro EC2
  instance, VPC, Glue, S3) are **outside this project** and do consume
  credits. They were not modified.
* If the account is ever upgraded to the Paid plan, usage above Always Free
  would be billed. The design keeps typical demo usage far below the limits.
* The Cognito default email cost is not stated by AWS (see table).
* CLI deployment used the root user's console session (short-lived). Best
  practice is an IAM Identity Center user with a least-privilege deployment
  permission set; creating one would change account settings and was not
  done without authorisation.
