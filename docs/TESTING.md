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

## Latest results (2026-10-16)

* Python unit tests: **76 passed**.
* JavaScript tests: **6 passed**.
* Live integration tests against the deployed stack: **5 passed**.
* Manual browser checks and the deployed smoke test: see the final report in
  the project README / submission notes.
