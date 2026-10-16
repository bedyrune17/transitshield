"""Service-layer tests against MemoryStore, which implements the same
conditional-write semantics as the DynamoDB adapter."""

import unittest

from tests import helpers
from shared import service
from shared.service import PermanentJobError, RetryableError, ServiceError
from shared.store import MemoryStore

ANALYST = {"sub": "analyst-1", "username": "analyst-1", "groups": ["analysts"]}
ANALYST2 = {"sub": "analyst-2", "username": "analyst-2", "groups": ["analysts"]}
ADMIN = {"sub": "admin-1", "username": "admin-1", "groups": ["admins"]}
VIEWER = {"sub": "viewer-1", "username": "viewer-1", "groups": []}


def run_job(store, job_id, max_attempts=3):
    """Simulate SQS redelivery until the job settles. Returns statuses seen."""
    seen = []
    for receive in range(1, 10):
        try:
            outcome = service.process_job(store, job_id, receive)
            seen.append(outcome)
            return seen
        except (RetryableError, PermanentJobError) as err:
            status = service.record_job_failure(store, job_id, err, max_attempts, receive_count=receive)
            seen.append(status)
            if status != "RETRY_SCHEDULED":
                return seen
    return seen


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.queue = helpers.FakeQueue()
        self.meta, created = service.seed_dataset(self.store, ANALYST, "mixed", 42, 100)
        self.assertTrue(created)
        self.ds = self.meta["datasetId"]

    def test_seeding_is_idempotent(self):
        meta, created = service.seed_dataset(self.store, ANALYST, "mixed", 42, 100)
        self.assertFalse(created)
        self.assertEqual(meta["datasetId"], self.ds)
        self.assertEqual(len(self.store.list_records(self.ds)), self.meta["recordCount"])
        generated = [e for e in self.store.list_audit() if e["action"] == "DATASET_GENERATED"]
        self.assertEqual(len(generated), 1)

    def test_job_accepted_then_completed(self):
        job = service.submit_job(self.store, self.queue, ANALYST, self.ds)
        self.assertEqual(job["jobStatus"], "QUEUED")
        self.assertEqual(self.queue.messages, [{"jobId": job["jobId"], "datasetId": self.ds}])
        recs = service.with_live_status(self.store.list_records(self.ds), service.active_job_index(self.store, self.ds))
        self.assertTrue(all(r["processingStatus"] == "QUEUED" for r in recs))
        self.assertEqual(service.process_job(self.store, job["jobId"], 1), "SUCCEEDED")
        done = self.store.get_job(job["jobId"])
        self.assertEqual(done["jobStatus"], "SUCCEEDED")
        self.assertEqual(done["resultSummary"]["scored"], self.meta["recordCount"])
        recs = self.store.list_records(self.ds)
        self.assertTrue(all(r["processingStatus"] == "PROCESSED" and r["riskScore"] is not None for r in recs))

    def test_duplicate_delivery_creates_no_duplicates(self):
        job = service.submit_job(self.store, self.queue, ANALYST, self.ds)
        service.process_job(self.store, job["jobId"], 1)
        cases_before = len(self.store.list_cases())
        audit_before = len(self.store.list_audit())
        history_before = [len(r["processingHistory"]) for r in self.store.list_records(self.ds)]
        self.assertGreater(cases_before, 0, "expected HIGH-risk auto cases for this seed")
        # Same message delivered again (SQS at-least-once) and job forced back to a runnable state:
        self.assertEqual(service.process_job(self.store, job["jobId"], 2), "DUPLICATE_IGNORED")
        self.store.jobs[job["jobId"]]["jobStatus"] = "QUEUED"
        self.assertEqual(service.process_job(self.store, job["jobId"], 3), "SUCCEEDED")
        self.assertEqual(len(self.store.list_cases()), cases_before)
        self.assertEqual(len(self.store.list_audit()), audit_before)
        self.assertEqual([len(r["processingHistory"]) for r in self.store.list_records(self.ds)], history_before)

    def test_concurrent_delivery_respects_lease(self):
        job = service.submit_job(self.store, self.queue, ANALYST, self.ds)
        self.store.update_job(job["jobId"], {"jobStatus": "PROCESSING", "leaseUntil": 10 ** 12},
                              allowed_statuses=["QUEUED"])
        self.assertEqual(service.process_job(self.store, job["jobId"], 2), "LEASE_HELD_ELSEWHERE")

    def test_expired_lease_can_be_taken_over(self):
        job = service.submit_job(self.store, self.queue, ANALYST, self.ds)
        self.store.update_job(job["jobId"], {"jobStatus": "PROCESSING", "leaseUntil": 1},
                              allowed_statuses=["QUEUED"])
        self.assertEqual(service.process_job(self.store, job["jobId"], 2), "SUCCEEDED")

    def test_transient_failure_retries_then_succeeds(self):
        job = service.submit_job(self.store, self.queue, ANALYST, self.ds, ["SHP-0001"], "transient")
        self.assertEqual(run_job(self.store, job["jobId"]), ["RETRY_SCHEDULED", "RETRY_SCHEDULED", "SUCCEEDED"])
        final = self.store.get_job(job["jobId"])
        self.assertEqual(final["attemptCount"], 3)
        self.assertEqual([a["outcome"] for a in final["attempts"]], ["FAILED", "FAILED", "SUCCEEDED"])
        actions = [e["action"] for e in self.store.list_audit("JOB#" + job["jobId"])]
        self.assertEqual(actions.count("JOB_ATTEMPT_FAILED"), 2)

    def test_permanent_failure_dead_letters_and_recovers(self):
        dlq = helpers.FakeDlq()
        job = service.submit_job(self.store, self.queue, ANALYST, self.ds, ["SHP-0001"], "permanent")
        self.assertEqual(run_job(self.store, job["jobId"]), ["RETRY_SCHEDULED", "RETRY_SCHEDULED", "DEAD_LETTERED"])
        self.assertEqual(self.store.get_job(job["jobId"])["errorCode"], "SIMULATED_PERMANENT_FAILURE")
        # Dead-lettered jobs are not resumed by stray deliveries.
        self.assertEqual(service.process_job(self.store, job["jobId"], 4), "DEAD_LETTERED_IGNORED")
        dlq.messages.append({"jobId": job["jobId"]})
        dlq.messages.append({"jobId": "JOB-OTHER"})
        with self.assertRaises(ServiceError):
            service.recover_job(self.store, self.queue, VIEWER, job["jobId"], dlq)
        recovered = service.recover_job(self.store, self.queue, ANALYST, job["jobId"], dlq)
        self.assertEqual(recovered["jobStatus"], "REDRIVEN")
        self.assertEqual(dlq.messages, [{"jobId": "JOB-OTHER"}])
        self.assertEqual(run_job(self.store, job["jobId"]), ["SUCCEEDED"])
        with self.assertRaises(ServiceError) as ctx:
            service.recover_job(self.store, self.queue, ANALYST, job["jobId"], dlq)
        self.assertEqual(ctx.exception.code, "NOT_RECOVERABLE")

    def test_job_for_deleted_dataset_fails_without_retry(self):
        job = service.submit_job(self.store, self.queue, ANALYST, self.ds)
        self.store.delete_dataset(self.ds)
        self.assertEqual(run_job(self.store, job["jobId"]), ["FAILED"])

    def test_queue_outage_marks_job_failed(self):
        with self.assertRaises(ServiceError) as ctx:
            service.submit_job(self.store, helpers.FakeQueue(fail=True), ANALYST, self.ds)
        self.assertEqual(ctx.exception.status, 503)
        self.assertEqual([j["jobStatus"] for j in self.store.list_jobs()], ["FAILED"])

    def test_job_validation(self):
        for kwargs, code in (({"record_ids": ["SHP-9999"]}, "UNKNOWN_RECORD"),
                             ({"record_ids": []}, "VALIDATION_ERROR"),
                             ({"failure_mode": "explode"}, "VALIDATION_ERROR"),
                             ({"profile": "nope"}, "VALIDATION_ERROR")):
            with self.assertRaises(ServiceError) as ctx:
                service.submit_job(self.store, self.queue, ANALYST, self.ds, **kwargs)
            self.assertEqual(ctx.exception.code, code)
        with self.assertRaises(ServiceError) as ctx:
            service.submit_job(self.store, self.queue, ANALYST, "ds-mixed-s1-n20")
        self.assertEqual(ctx.exception.status, 404)

    def _open(self, actor=ANALYST, rid="SHP-0001"):
        case, created = service.open_case(self.store, actor, self.ds, rid)
        return case

    def test_viewer_cannot_modify_cases(self):
        case = self._open()
        for fn in (lambda: service.open_case(self.store, VIEWER, self.ds, "SHP-0002"),
                   lambda: service.transition_case(self.store, VIEWER, case["caseId"], "UNDER_REVIEW", None, 1),
                   lambda: service.add_comment(self.store, VIEWER, case["caseId"], "hi", 1),
                   lambda: service.submit_job(self.store, self.queue, VIEWER, self.ds),
                   lambda: service.reset_dataset(self.store, ANALYST, self.ds)):
            with self.assertRaises(ServiceError) as ctx:
                fn()
            self.assertEqual(ctx.exception.status, 403)

    def test_case_creation_is_idempotent(self):
        a = self._open()
        b, created = service.open_case(self.store, ANALYST2, self.ds, "SHP-0001")
        self.assertFalse(created)
        self.assertEqual(a["caseId"], b["caseId"])
        self.assertEqual(len([e for e in self.store.list_audit() if e["action"] == "CASE_CREATED"]), 1)

    def test_conflicting_updates_do_not_overwrite(self):
        case = self._open()
        first = service.transition_case(self.store, ANALYST, case["caseId"], "UNDER_REVIEW", None, 1)
        self.assertEqual(first["version"], 2)
        with self.assertRaises(ServiceError) as ctx:
            service.transition_case(self.store, ANALYST2, case["caseId"], "ESCALATED", None, 1)
        self.assertEqual(ctx.exception.code, "VERSION_CONFLICT")
        self.assertEqual(ctx.exception.details, {"currentVersion": 2})
        self.assertEqual(self.store.get_case(case["caseId"])["caseStatus"], "UNDER_REVIEW")
        with self.assertRaises(ServiceError):
            service.add_comment(self.store, ANALYST2, case["caseId"], "stale", 1)

    def test_case_lifecycle_and_history(self):
        case = self._open()
        c = service.transition_case(self.store, ANALYST, case["caseId"], "UNDER_REVIEW", None, 1)
        c = service.add_comment(self.store, ANALYST2, case["caseId"], "Checked the linked invoice.", c["version"])
        with self.assertRaises(ServiceError) as ctx:
            service.transition_case(self.store, ANALYST, case["caseId"], "DISMISSED", "", c["version"])
        self.assertEqual(ctx.exception.code, "REASON_REQUIRED")
        c = service.transition_case(self.store, ANALYST, case["caseId"], "DISMISSED",
                                    "Synthetic adjustment explained by freight charges", c["version"])
        self.assertEqual(c["resolutionReason"], "Synthetic adjustment explained by freight charges")
        _, history = service.get_case_with_history(self.store, case["caseId"])
        self.assertEqual([e["action"] for e in history],
                         ["CASE_CREATED", "CASE_STATUS_CHANGED", "CASE_COMMENT_ADDED", "CASE_STATUS_CHANGED"])
        self.assertEqual(history[2]["actorId"], "analyst-2")
        self.assertTrue(all(e["timestamp"] and e["caseId"] == case["caseId"] for e in history))

    def test_reset_removes_only_its_own_dataset(self):
        other, _ = service.seed_dataset(self.store, ANALYST, "normal", 7, 40)
        case = self._open()
        result = service.reset_dataset(self.store, ADMIN, self.ds)
        self.assertEqual(result["recordsRemoved"], self.meta["recordCount"])
        self.assertIsNone(self.store.get_dataset(self.ds))
        self.assertEqual(len(self.store.list_records(other["datasetId"])), other["recordCount"])
        archived = self.store.get_case(case["caseId"])
        self.assertTrue(archived["archived"], "cases are archived, never hard-deleted")
        self.assertTrue(any(e["action"] == "DATASET_RESET" for e in self.store.list_audit()))
        with self.assertRaises(ServiceError):
            service.transition_case(self.store, ANALYST, case["caseId"], "UNDER_REVIEW", None, archived["version"])

    def test_reset_refuses_while_jobs_active(self):
        service.submit_job(self.store, self.queue, ANALYST, self.ds)
        with self.assertRaises(ServiceError) as ctx:
            service.reset_dataset(self.store, ADMIN, self.ds)
        self.assertEqual(ctx.exception.code, "JOBS_ACTIVE")

    def test_dashboard_metrics_match_underlying_data(self):
        job = service.submit_job(self.store, self.queue, ANALYST, self.ds)
        service.process_job(self.store, job["jobId"], 1)
        failing = service.submit_job(self.store, self.queue, ANALYST, self.ds, ["MAN-0001"], "permanent")
        run_job(self.store, failing["jobId"])
        m = service.dataset_metrics(self.store, self.ds)
        recs = self.store.list_records(self.ds)
        self.assertEqual(m["totalRecords"], len(recs))
        self.assertEqual(m["processedRecords"], sum(1 for r in recs if r.get("riskScore") is not None))
        self.assertEqual(m["flaggedRecords"], sum(1 for r in recs if r.get("flagged")))
        self.assertEqual(sum(m["riskDistribution"].values()), len(recs))
        self.assertEqual(m["riskDistribution"]["HIGH"], sum(1 for r in recs if r["riskLevel"] == "HIGH"))
        self.assertEqual(m["highPriorityCases"], m["riskDistribution"]["HIGH"])
        self.assertEqual(m["failedJobs"], 1)
        self.assertEqual(m["failedAttempts"], 3)
        self.assertEqual(m["jobSuccessRate"], 0.5)
        self.assertEqual(m["pendingJobs"], 0)

    def test_cloud_evaluation_uses_stored_scores(self):
        job = service.submit_job(self.store, self.queue, ANALYST, self.ds)
        service.process_job(self.store, job["jobId"], 1)
        ev = service.dataset_evaluation(self.store, self.ds)
        self.assertEqual(ev["total"], self.meta["recordCount"])
        self.assertEqual(ev["truePositives"] + ev["falseNegatives"], self.meta["anomalousRecordCount"])
        self.assertEqual(ev["unscoredRecords"], 0)


if __name__ == "__main__":
    unittest.main()
