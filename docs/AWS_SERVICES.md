# AWS services used

Five AWS services do real work in TransitShield; IAM and CloudFormation are
supporting infrastructure and are not counted.

## 1. AWS Lambda
* **`transitshield-api`** — the only HTTP entry point, exposed through a
  **Lambda Function URL** with `AuthType=AWS_IAM`. Routes: `/me`, `/config`,
  `/ops`, `/datasets[/{id}[/records[/{rid}]|/labels|/evaluation|/metrics]]`,
  `/jobs[/{id}[/recover]]`, `/cases[/{id}[/transition|/comments]]`, `/audit`.
  Verifies the Cognito access token, validates input, enforces roles and rate
  limits, reads/writes DynamoDB, sends jobs to SQS, reads SQS/CloudWatch for
  the live dashboard.
* **`transitshield-worker`** — triggered by the SQS event source mapping
  (batch size 5, `ReportBatchItemFailures`, `MaximumConcurrency` 2). Scores
  records, saves results, opens cases for HIGH risk, writes audit events,
  applies retry backoff and explicit dead-lettering, emits EMF metrics.
* Runtime python3.13 on arm64, 256 MB. Code has no third-party dependencies
  (boto3 is provided by the runtime; JWT verification is implemented with the
  standard library).

## 2. Amazon SQS
* `transitshield-jobs`: standard queue, 20 s long polling, visibility timeout
  180 s (6 × worker timeout), 1-day retention, SSE-SQS.
* `transitshield-dlq`: dead-letter queue, 4-day retention. Redrive policy on the
  main queue (`maxReceiveCount` 5) is the backstop; the worker dead-letters
  explicitly after 3 attempts so the recovery demo is deterministic.
* The API's **Recover** action removes a job's messages from the DLQ and
  re-queues it.

## 3. Amazon DynamoDB
Four provisioned-capacity tables (Standard class, 21 RCU / 21 WCU in total):
`transitshield-records`, `-jobs` (TTL), `-cases`, `-audit`. Conditional writes
implement idempotency (cases, audit events, job leases) and optimistic
locking (case `version`). See ARCHITECTURE.md for keys and access patterns.

## 4. Amazon Cognito
* **User pool** `transitshield-users` — Lite tier, email usernames, admin
  invitation only (no self sign-up), password policy ≥ 12 characters, email
  recovery, no SMS/MFA/advanced security. Groups: `analysts`, `admins`.
* **App client** `transitshield-web` — public client (no secret), OAuth
  Authorization Code grant, scopes `openid email`, exact callback/logout URLs,
  only `ALLOW_REFRESH_TOKEN_AUTH` (password sign-in only through the hosted
  UI), token revocation enabled, 60-minute access/ID tokens.
* **Hosted UI domain** (classic) for sign-in.
* **Identity pool** `transitshield_identities` — authenticated identities
  only, enhanced flow, server-side token check. Its role
  `transitshield-signed-in-user-role` may only call `lambda:InvokeFunctionUrl`
  on the API function (and `lambda:InvokeFunction` is granted through the
  function's resource policy only when invoked via the function URL).

## 5. Amazon CloudWatch
* **Logs:** `/aws/lambda/transitshield-api` and `-worker`, 3-day retention,
  structured JSON lines.
* **Metrics:** EMF namespace `TransitShield` (5 metrics), plus AWS/Lambda and
  AWS/SQS metrics.
* **Alarm:** `transitshield-dlq-not-empty` on the DLQ's visible messages; no
  notification action (no SNS needed) — its state is shown in the app.
* The API reads `GetQueueAttributes`, `DescribeAlarms` and
  `GetMetricStatistics` (cached 30 s) to show **genuine** AWS values, which the
  UI tags as *Live AWS* to distinguish them from application data and from
  local simulation.

## Considered and not used
API Gateway (its free allowance is no longer Always Free for new accounts),
S3 (not needed — direct Lambda code upload, Pages for hosting), SNS (an email
channel adds no value over the in-app alarm), EventBridge Scheduler (no
periodic work is needed), AWS Budgets (the Free plan already prevents
charges; a budget alert is not a cap).
