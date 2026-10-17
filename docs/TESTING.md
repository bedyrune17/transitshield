# Testing

All automated tests run without AWS credentials except the opt-in
integration suite. Nothing is "mocked away": scoring, generation, token
verification (real RSA signatures with a key generated at test time), the
service layer's conditional writes and the handlers run for real; only AWS
endpoints are replaced by an in-memory store/queue that implements the same
conditional semantics as DynamoDB/SQS.

## How to run

```bash
python -m unittest discover -s tests/unit -t . -v      # Python (76 tests)
node --test tests/js/frontend.test.mjs                 # JavaScript (6 tests)
# Live AWS (opt-in; signs with your current AWS CLI credentials, in memory only)
TS_INTEGRATION=1 python -m unittest tests.integration.test_live_api -v   # (5 tests)
```

## Coverage of the required cases

| Requirement | Test |
|---|---|
| Valid record receives no flags | `test_scoring.test_valid_records_receive_no_flags` |
| Duplicate reference triggers the rule | `test_scoring.test_duplicate_reference_triggers_r02_on_both` |
| Mismatched value exposes the inconsistency (explanation text + evidence) | `test_scoring.test_mismatched_amount_is_explained` |
| Missing required fields handled safely | `test_scoring.test_missing_fields_handled_safely`, `test_unknown_record_type_is_handled` |
| Identical inputs + rule version ⇒ identical scores | `test_scoring.test_identical_inputs_produce_identical_output`, `test_generator.test_same_seed_is_reproducible` |
| Score bounded 0–100, categorisation | `test_scoring.test_score_is_bounded`, `test_level_categorisation` |
| Labels kept apart from scoring input | `test_generator.test_labels_are_separate_from_scoring_input` |
| Reprocessing a job creates no duplicate cases/audit events | `test_service.test_duplicate_delivery_creates_no_duplicates`, `test_api_worker.test_worker_handles_poison_and_duplicate_messages` |
| Concurrent duplicate delivery / lease | `test_service.test_concurrent_delivery_respects_lease`, `test_expired_lease_can_be_taken_over` |
| Invalid requests return suitable errors (invalid JSON, oversized, unknown fields, bad IDs, wrong method, unknown route, unknown record) | `test_api_worker.test_input_validation`, `test_unknown_record_is_404` |
| Expired / invalid token rejected | `test_auth.*` (expired, tampered, wrong key, unknown kid, wrong iss/client/token_use, alg none/HS256, malformed, JWKS caching/outage), `test_api_worker.test_missing_or_invalid_token_is_401` |
| Unauthorised users cannot modify cases | `test_service.test_viewer_cannot_modify_cases`, `test_api_worker.test_viewer_cannot_write`, `test_analyst_cannot_reset` |
| Identity taken from the token, never the body | `test_api_worker.test_identity_comes_from_token_not_body` |
| Conflicting case updates do not overwrite | `test_service.test_conflicting_updates_do_not_overwrite`, `test_api_worker.test_case_api_with_optimistic_locking` |
| Failed job retried, then dead-lettered per configuration; recovery | `test_service.test_transient_failure_retries_then_succeeds`, `test_permanent_failure_dead_letters_and_recovers`, `test_api_worker.test_worker_retry_backoff_then_success`, `test_worker_dead_letters_after_budget`, `test_worker_falls_back_to_redrive_policy_if_dlq_send_fails` |
| Dashboard metrics match the underlying data | `test_service.test_dashboard_metrics_match_underlying_data` |
| Evaluation metrics match a manually verified dataset; zero denominators | `test_evaluation_cases.test_manually_verified_small_dataset`, `test_zero_denominators_are_none` |
| Reset deletes only its own demo data | `test_service.test_reset_removes_only_its_own_dataset` |
| Rate limiting | `test_api_worker.test_rate_limit` |
| Browser engine identical to the backend | `test_parity` (14 scenario/seed/size combinations × 3 profiles: datasets, scores, explanations, evaluation, PRNG stream) |
| Browser SigV4 signer correct | `frontend.test.mjs` — AWS SigV4 test-suite "get-vanilla" vector |
| Local demo mode end to end (queue, retries, DLQ, recovery, locking, roles) | `frontend.test.mjs` local-provider tests |
| Deployed API rejects unsigned requests (IAM), CORS origins, forged/malformed tokens | `tests/integration/test_live_api.py` |

## Latest results

* Python unit tests: **76 passed** (locally and in GitHub Actions on Linux).
* JavaScript tests: **6 passed** (locally and in GitHub Actions).
* Live integration tests against the deployed stack: **5 passed** (2026-10-16).

## Deployed smoke test (2026-10-17, live site + AWS, signed-in admin user)

| # | Check | Result |
|---|---|---|
| 1 | Authenticate (Cognito hosted UI, Auth Code + PKCE) | Pass — redirect carried `code_challenge_method=S256`; `/me` returned the verified identity and roles viewer/analyst/admin |
| 2 | Reject unauthorised requests | Pass — unsigned requests 403 from AWS IAM; signed requests with missing/forged/`alg:none`/unknown-key/forged-signature tokens 401 from the function (integration suite) |
| 3 | Load dashboard | Pass — live SQS depth, DLQ depth, alarm state and worker Lambda metrics shown with the *Live AWS* tag |
| 4 | Seed a dataset | Pass — `ds-mixed-s42-n100`, 98 records, 22 planted (identical to local mode) |
| 5–7 | Submit job; pending state; completed state | Pass — 202 Accepted, records shown *Queued*, all 98 *Processed* by the SQS-triggered worker ≈ 5.6 s after submission |
| 8 | Score and explanations | Pass — e.g. SHP-0019: R07 (+30) + R08 (+30) = 60 HIGH with text explanations; auto-case opened by `system:worker` |
| 9 | Case workflow | Pass — New → Under review → comment → Escalated → Resolved (reason required), version 5 |
| 9b | Concurrent update | Pass — a second client moved the case to v2; the UI's stale comment (v1) was rejected with 409 VERSION_CONFLICT, the draft text was kept, then posted after reload |
| 10 | Audit trail | Pass — 42 events, exactly the expected count (no duplicates despite retries); actors are the verified user ID or `system:worker` |
| 11 | Controlled failure + recovery | Pass — transient job failed twice and succeeded on attempt 3 (20.6 s, matching 5 s + 15 s backoff); permanent job DEAD_LETTERED after 3 attempts, message present in `transitshield-dlq`; see recovery row below |
| 11b | Alarm and recovery | Pass — CloudWatch alarm `transitshield-dlq-not-empty` went to ALARM once SQS published the DLQ depth (shown live in the app); **Recover** cleared the flag, removed the DLQ message (`dlqMessagesRemoved: 1` in the audit event) and re-queued the job, which succeeded on attempt 4. Audit timeline: attempt 1 → +5 s → attempt 2 → +15 s → attempt 3 → dead-lettered → recovered → scored |
| 11c | CloudWatch custom metrics (EMF) | Pass — last hour: JobsSucceeded 13, JobAttemptsFailed 5, JobsDeadLettered 1, RecordsScored 110 — matching the application's job records exactly; worker Lambda Errors 0 (controlled failures are reported per message, not as crashes) |
| 12 | Evaluation metrics | Pass — cloud-stored scores: TP 20 / FP 0 / TN 76 / FN 2, precision 100 %, recall 90.9 % — identical to the Python test suite and local mode |
| 13 | Burst (small load) test | Pass — 10 jobs accepted in 3.7 s; drained with worker concurrency cap 2; submit→done 0.3–2.9 s; all succeeded |
| 14 | Logs | Pass — structured JSON lines; no token material found (`eyJ` search returned 0) |
| 15 | Local mode without AWS | Pass — local demo mode works on the same live site and offline via `scripts/serve_frontend.py` |

Hardening applied after the smoke test: the DLQ clean-up in **Recover** now
long-polls for 1 s instead of short polling, because short polling samples
only some SQS servers and can miss the few messages a DLQ holds (redeployed;
live integration suite re-run: 5 passed).

Bug found and fixed during the smoke test: the "App data" source tag used the
CSS class `app`, which also matched the root layout rule
`.app { min-height: 100vh }`, stretching page headers in AWS mode. Modifier
classes are now prefixed (`tag-app`, `tag-aws`, `tag-sim`).
