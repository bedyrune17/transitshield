# Viva guide — answers grounded in this implementation

**Why did you choose a serverless architecture?**
The workload is bursty and tiny on average: an analyst generates a dataset,
submits a job, then reads results. Lambda, SQS, DynamoDB and Cognito charge per
request/usage and have Always Free allowances, so an idle demo costs nothing
and needs no servers to patch. There is no EC2, NAT or database instance that
would run (and bill) 24/7. Scaling, retries and high availability come from
the managed services; we spend our effort on the domain logic (rules,
idempotency, authorisation) instead of infrastructure.

**Why use SQS instead of processing each request synchronously?**
Scoring reads the whole dataset (duplicate and link rules need context) and
writes every result, which is slow relative to an HTTP request and can hit
DynamoDB throttling. With SQS the API only validates and enqueues, then
returns **202 Accepted** in milliseconds; the worker drains the queue at a
controlled rate (`MaximumConcurrency 2`, protecting the account's limit of 10
concurrent executions). The queue gives buffering under bursts, automatic
redelivery on failure, a dead-letter queue, and decoupling: the API stays
responsive even when the worker is failing (we demonstrate exactly that).

**What happens when a Lambda worker fails?**
`worker/handler.py` catches the error and calls `record_job_failure`. If the
attempt count in this recovery cycle is below 3, the job becomes
`RETRY_SCHEDULED`, the worker shortens that message's visibility to a backoff
(5 s, 15 s, 30 s) and returns it in `batchItemFailures`, so SQS redelivers only
that message. On the third failed attempt the job becomes `DEAD_LETTERED`, the
worker copies the message to the DLQ and acknowledges the original. A
non-retryable error (dataset deleted) marks the job `FAILED` without retries.
If the worker crashes or times out before it can record anything, the
message simply reappears after the 180 s visibility timeout; the queue's
redrive policy moves it to the DLQ after 5 receives.

**What is a dead-letter queue?**
A separate queue that holds messages that could not be processed successfully
after a bounded number of tries, so a "poison" message stops blocking or
wasting work. Ours is `transitshield-dlq` (4-day retention). A CloudWatch alarm
(`transitshield-dlq-not-empty`) turns to ALARM when it holds messages, and the
dashboard shows its depth and the alarm state live. The **Recover** action
clears the demo failure flag, removes that job's messages from the DLQ and
re-queues it — an operator "fix and redrive".

**How do retries cause duplicate-processing problems?**
SQS standard queues are at-least-once: the same message can be delivered
twice, and a retry re-runs code that may already have half-completed (for
example, a case was created but the job was not yet marked done). Naively
that would create duplicate cases, duplicate audit events, double-counted
history entries or a job completed twice.

**What is idempotency?**
An operation is idempotent if performing it more than once has the same
effect as performing it once. We make every side effect idempotent with
DynamoDB conditional writes and deterministic keys: case ID =
`CASE-<dataset>-<record>` with `attribute_not_exists`; audit event ID =
SHA-256 of an idempotency key such as `scoring-completed:<jobId>`; processing
history only appended when `lastJobId` differs; job transitions guarded by
status + lease + attempt number. A test re-delivers a completed job, forces it
to run again, and asserts the case and audit counts do not change.

**How is authentication different from authorisation?**
Authentication answers *who are you?* — Cognito verifies the password and
issues tokens; the API verifies the token's signature and claims.
Authorisation answers *what may you do?* — the API maps the verified
`cognito:groups` to roles (viewer / analyst / admin) and checks the role on
every write (e.g. only admins can reset a dataset). A signed-in viewer is
authenticated but not authorised to change cases; the API returns 403 and
records an `AUTHORIZATION_DENIED` audit event.

**What is the purpose of Cognito?**
Two parts. The **user pool** (Lite tier) stores the demo users, runs the
hosted sign-in page (Authorization Code + PKCE, no client secret in the
browser) and issues JWTs carrying group membership. The **identity pool**
exchanges a signed-in user's ID token for one-hour AWS credentials of a role
that can do only one thing: invoke our API's Function URL. That lets the
Function URL use `AWS_IAM`, so AWS rejects anonymous traffic before our code
or database is touched.

**How does DynamoDB store the records?**
Table `transitshield-records` has partition key `datasetId` and sort key
`recordId`, so all records of a dataset are one Query and a single record is a
GetItem. Each item holds the synthetic `fields` map, `linkedEntityIds`, and
the latest result (`riskScore`, `riskLevel`, `triggeredRules`, `findings` with
explanations and evidence, `scoringVersion`, `processingHistory`,
`version`). Dataset metadata lives under the special partition `#DATASETS`,
and ground-truth labels under `<datasetId>/#LABELS`, deliberately apart from
the scoring input. Jobs, cases and audit events have their own tables. Capacity
is provisioned (21 RCU / 21 WCU total) to stay in the Always Free allowance.

**How does CloudWatch help diagnose failures?**
Both functions write structured JSON logs (request ID, route, status, latency,
job ID, error code — never tokens or full records) with 3-day retention, so
you can search a job ID in Logs Insights and see each attempt. The worker
emits Embedded-Metric-Format metrics (`JobsSucceeded`, `JobAttemptsFailed`,
`JobsDeadLettered`, `RecordsScored`, `ProcessingMs`). AWS/Lambda metrics show
invocations, errors, duration and throttles; AWS/SQS metrics feed the DLQ
alarm. The dashboard reads queue depth, alarm state and the worker's
last-hour Lambda metrics live and labels them **Live AWS**.

**Which services can generate charges?**
All of them beyond their free allowances: Lambda (requests, GB-seconds), SQS
(requests — idle event-source polling is the biggest consumer at ~0.65M/month
of the 1M free), DynamoDB (provisioned capacity above 25/25, storage above
25 GB), CloudWatch (logs above 5 GB, more than 10 custom metrics/alarms,
GetMetricData), Cognito (above 10,000 MAU, SMS, Plus tier). On this account's
**Free plan** none of that reaches the card; usage above Always Free would only
consume credits.

**How did you verify the cost constraints?**
On 2026-10-16 we (1) read the plan, credits and bill in the Billing console;
(2) read the current AWS pricing pages for every service; (3) ran
`scripts/cost_check.py`, which reads the account and confirms DynamoDB
capacity headroom (other tables use 0 provisioned units), alarm and custom
metric counts; (4) chose configurations that fit the allowances (provisioned
DynamoDB, Lite Cognito, 3-day log retention, no S3/API Gateway/KMS keys); and
(5) built the gate into `deploy.py`, which aborts if any check fails. The
dated table is in `docs/COST_SAFETY.md`.

**What are the limitations of the synthetic risk model?**
The rules detect only the generic inconsistencies we planted (duplicates,
mismatches, broken links, bad dates, missing fields, concentration). Weights
and thresholds are hand-set, not learned or validated; tolerances trade
precision for recall (see the profile comparison). The generator's "normal"
variation is simplistic, so evaluation numbers are optimistic compared with
real data. Concentration and reference rules depend on dataset size. There is
no notion of intent, context or legitimate business reasons.

**Why is a high risk score not proof of a crime?**
The score counts data inconsistencies in fictional documents under arbitrary
demo weights. Real inconsistencies usually have innocent causes — typos,
freight adjustments, partial payments, currency conversion, late paperwork.
Even our own evaluation shows false positives (legitimate 5.5–7 % freight
adjustments flagged by the 5 % tolerance). A score only prioritises human
review; the case workflow requires an analyst's documented decision, and the
UI says explicitly that a connection or a score is not evidence of wrongdoing.

**How would the system scale if traffic increased?**
Lambda scales concurrent executions automatically; we would raise the
worker's `MaximumConcurrency` (and request a higher account concurrency
quota). SQS absorbs bursts without changes. DynamoDB would move to on-demand
or auto-scaled provisioned capacity, add GSIs (cases by status, audit by day,
jobs by dataset) to replace scans, and paginate APIs. Scoring would be
partitioned per manifest group instead of whole-dataset reads. The static
frontend is already served from a CDN (GitHub Pages).

**What security improvements would be needed before real-world deployment?**
Deploy with an IAM Identity Center least-privilege role, not root; enable MFA
for users (TOTP) and Cognito threat protection; move to a custom domain with
WAF or API Gateway throttling; store tokens in memory with a backend-for-
frontend or refresh-token rotation; add KMS customer-managed keys and
point-in-time recovery; make the audit log tamper-evident (hash chaining or a
write-once store) and stream it to a separate account; formal data
classification, retention and privacy controls; penetration testing; and
model governance (validated rules, bias review, human-in-the-loop policy).
