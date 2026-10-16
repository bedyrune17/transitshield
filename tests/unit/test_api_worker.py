"""API and worker Lambda handlers end to end, with an in-memory store, fake
queues and real signed tokens. Exercises routing, validation, auth, roles,
rate limits and the worker's retry / dead-letter decisions."""

import json
import unittest

from tests import helpers
from api import handler as api
from worker import handler as worker
from shared.store import MemoryStore


class FakeSqs:
    def __init__(self):
        self.backoffs = []
        self.dead = []
        self.fail_dlq = False

    def backoff(self, receipt, seconds):
        self.backoffs.append((receipt, seconds))

    def dead_letter(self, body):
        if self.fail_dlq:
            raise RuntimeError("dlq down")
        self.dead.append(body)


class Ctx:
    aws_request_id = "req-test"


class ApiWorkerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = helpers.test_key()
        cls.jwks = {"kid-1": helpers.jwk_for(cls.key, "kid-1")}

    def setUp(self):
        self.store = MemoryStore()
        self.queue = helpers.FakeQueue()
        self.dlq = helpers.FakeDlq()
        self.sqs = FakeSqs()
        api.configure(store=self.store, queue=self.queue, dlq=self.dlq, ops=None, require_iam=True,
                      auth={"region": helpers.REGION, "user_pool_id": helpers.POOL_ID,
                            "client_id": helpers.CLIENT_ID, "jwks": self.jwks})
        worker.configure(store=self.store, sqs=self.sqs)
        self.analyst = helpers.sign_jwt(self.key, "kid-1", helpers.access_claims("an-1", ["analysts"]))
        self.admin = helpers.sign_jwt(self.key, "kid-1", helpers.access_claims("ad-1", ["admins"]))
        self.viewer = helpers.sign_jwt(self.key, "kid-1", helpers.access_claims("vi-1", []))

    def call(self, method, path, body=None, token=None, raw=None, query=None, iam=True):
        event = {"rawPath": path, "requestContext": {"http": {"method": method}},
                 "headers": {"X-TransitShield-Token": token if token is not None else self.analyst},
                 "queryStringParameters": query}
        if iam:
            event["requestContext"]["authorizer"] = {"iam": {"userId": "AROATEST:CognitoIdentityCredentials"}}
        if raw is not None:
            event["body"] = raw
        elif body is not None:
            event["body"] = json.dumps(body)
        resp = api.handler(event, Ctx())
        return resp["statusCode"], json.loads(resp["body"])

    def deliver(self, receive_count=1, body=None):
        msgs = self.queue.messages
        self.queue.messages = []
        records = [{"messageId": "m%d" % i, "receiptHandle": "rh%d" % i, "body": json.dumps(body or m),
                    "attributes": {"ApproximateReceiveCount": str(receive_count)}} for i, m in enumerate(msgs)]
        return worker.handler({"Records": records}, None), msgs

    def seed(self):
        status, body = self.call("POST", "/datasets", {"scenario": "mixed", "seed": 42, "count": 100})
        self.assertEqual(status, 201, body)
        return body["dataset"]["datasetId"]

    # --- authentication / transport -------------------------------------------------
    def test_missing_or_invalid_token_is_401(self):
        self.assertEqual(self.call("GET", "/me", token="")[0], 401)
        self.assertEqual(self.call("GET", "/me", token="not.a.jwt")[0], 401)
        expired = helpers.sign_jwt(self.key, "kid-1", helpers.access_claims(exp=1))
        status, body = self.call("GET", "/me", token=expired)
        self.assertEqual((status, body["error"]["code"]), (401, "TOKEN_EXPIRED"))
        self.assertTrue(any(e["action"] == "AUTHENTICATION_FAILED" for e in self.store.list_audit()))

    def test_requests_without_iam_context_are_rejected(self):
        status, body = self.call("GET", "/me", iam=False)
        self.assertEqual((status, body["error"]["code"]), (401, "IAM_AUTH_REQUIRED"))

    def test_identity_comes_from_token_not_body(self):
        ds = self.seed()
        status, body = self.call("POST", "/cases", {"datasetId": ds, "recordId": "SHP-0001", "actorId": "evil"})
        self.assertEqual(status, 400)
        status, body = self.call("POST", "/cases", {"datasetId": ds, "recordId": "SHP-0001"})
        self.assertEqual(status, 201)
        self.assertEqual(body["case"]["createdBy"], "an-1")

    def test_me_reports_roles(self):
        status, body = self.call("GET", "/me", token=self.admin)
        self.assertEqual(status, 200)
        self.assertEqual(body["actor"]["roles"], ["viewer", "analyst", "admin"])

    # --- validation --------------------------------------------------------------------
    def test_input_validation(self):
        cases = [
            (("POST", "/datasets"), {"raw": "{not json"}, 400, "INVALID_JSON"),
            (("POST", "/datasets"), {"raw": "[1,2]"}, 400, "INVALID_BODY"),
            (("POST", "/datasets"), {"raw": json.dumps({"scenario": "mixed", "x": "y" * 9000})}, 413,
             "PAYLOAD_TOO_LARGE"),
            (("POST", "/datasets"), {"body": {"seed": 1}}, 400, "VALIDATION_ERROR"),
            (("POST", "/datasets"), {"body": {"scenario": "mixed", "count": 5000}}, 400, "VALIDATION_ERROR"),
            (("POST", "/datasets"), {"body": {"scenario": "evil"}}, 400, "VALIDATION_ERROR"),
            (("POST", "/datasets"), {"body": {"scenario": "mixed", "seed": "42"}}, 400, "VALIDATION_ERROR"),
            (("PUT", "/datasets"), {}, 405, "METHOD_NOT_ALLOWED"),
            (("GET", "/nowhere"), {}, 404, "NOT_FOUND"),
            (("GET", "/datasets/../../etc"), {}, 400, "VALIDATION_ERROR"),
            (("GET", "/datasets/ds-mixed-s1-n20/records/DROP-TABLE"), {}, 400, "VALIDATION_ERROR"),
            (("GET", "/datasets/ds-mixed-s1-n20"), {}, 404, "NOT_FOUND"),
            (("GET", "/jobs/JOB-0000000000000000"), {}, 404, "NOT_FOUND"),
            (("GET", "/audit"), {"query": {"stream": "bad stream!"}}, 400, "VALIDATION_ERROR"),
        ]
        for (method, path), kw, status, code in cases:
            with self.subTest(path=path, code=code):
                got_status, body = self.call(method, path, kw.get("body"), raw=kw.get("raw"), query=kw.get("query"))
                self.assertEqual((got_status, body["error"]["code"]), (status, code))
                self.assertIn("requestId", body)

    def test_unknown_record_is_404(self):
        ds = self.seed()
        status, body = self.call("GET", "/datasets/%s/records/SHP-9999" % ds)
        self.assertEqual((status, body["error"]["code"]), (404, "UNKNOWN_RECORD"))
        status, body = self.call("POST", "/jobs", {"datasetId": ds, "recordIds": ["SHP-9999"]})
        self.assertEqual((status, body["error"]["code"]), (404, "UNKNOWN_RECORD"))

    # --- authorization -----------------------------------------------------------------
    def test_viewer_cannot_write(self):
        ds = self.seed()
        for method, path, body in (("POST", "/datasets", {"scenario": "normal"}),
                                   ("POST", "/jobs", {"datasetId": ds}),
                                   ("POST", "/cases", {"datasetId": ds, "recordId": "SHP-0001"}),
                                   ("DELETE", "/datasets/" + ds, None)):
            with self.subTest(path=path):
                status, resp = self.call(method, path, body, token=self.viewer)
                self.assertEqual((status, resp["error"]["code"]), (403, "FORBIDDEN"))
        self.assertEqual(self.call("GET", "/datasets/%s/records" % ds, token=self.viewer)[0], 200)
        self.assertTrue(any(e["action"] == "AUTHORIZATION_DENIED" for e in self.store.list_audit()))

    def test_analyst_cannot_reset(self):
        ds = self.seed()
        self.assertEqual(self.call("DELETE", "/datasets/" + ds)[0], 403)
        self.assertEqual(self.call("DELETE", "/datasets/" + ds, token=self.admin)[0], 200)

    # --- full flow ---------------------------------------------------------------------
    def test_seed_submit_process_and_read(self):
        ds = self.seed()
        status, body = self.call("POST", "/jobs", {"datasetId": ds})
        self.assertEqual(status, 202)
        job_id = body["job"]["jobId"]
        self.assertEqual(body["job"]["jobStatus"], "QUEUED")
        status, body = self.call("GET", "/datasets/%s/records" % ds)
        self.assertTrue(all(r["processingStatus"] == "QUEUED" for r in body["records"]))
        result, _ = self.deliver()
        self.assertEqual(result, {"batchItemFailures": []})
        status, body = self.call("GET", "/jobs/" + job_id)
        self.assertEqual(body["job"]["jobStatus"], "SUCCEEDED")
        status, body = self.call("GET", "/datasets/%s/records/INV-0001" % ds)
        self.assertEqual(status, 200)
        self.assertIn("riskScore", body["record"])
        status, body = self.call("GET", "/datasets/%s/metrics" % ds)
        self.assertEqual(body["metrics"]["processedRecords"], body["metrics"]["totalRecords"])
        status, body = self.call("GET", "/datasets/%s/evaluation" % ds)
        self.assertEqual(status, 200)
        self.assertIsNotNone(body["evaluation"]["precision"])
        status, body = self.call("GET", "/audit", query={"limit": "5"})
        self.assertEqual(len(body["events"]), 5)

    def test_case_api_with_optimistic_locking(self):
        ds = self.seed()
        status, body = self.call("POST", "/cases", {"datasetId": ds, "recordId": "INV-0001"})
        cid = body["case"]["caseId"]
        status, body = self.call("POST", "/cases/%s/transition" % cid, {"toStatus": "UNDER_REVIEW", "expectedVersion": 1})
        self.assertEqual((status, body["case"]["version"]), (200, 2))
        status, body = self.call("POST", "/cases/%s/comments" % cid, {"text": "stale write", "expectedVersion": 1})
        self.assertEqual((status, body["error"]["code"]), (409, "VERSION_CONFLICT"))
        status, body = self.call("POST", "/cases/%s/comments" % cid, {"text": "Reviewed", "expectedVersion": 2})
        self.assertEqual(status, 200)
        status, body = self.call("GET", "/cases/" + cid)
        self.assertEqual([e["action"] for e in body["history"]],
                         ["CASE_CREATED", "CASE_STATUS_CHANGED", "CASE_COMMENT_ADDED"])

    def test_rate_limit(self):
        for i in range(10):
            status, _ = self.call("POST", "/datasets", {"scenario": "normal", "seed": i, "count": 20})
            self.assertIn(status, (201, 409))
        status, body = self.call("POST", "/datasets", {"scenario": "normal", "seed": 99, "count": 20})
        self.assertEqual((status, body["error"]["code"]), (429, "RATE_LIMITED"))

    # --- worker ------------------------------------------------------------------------
    def test_worker_retry_backoff_then_success(self):
        ds = self.seed()
        self.call("POST", "/jobs", {"datasetId": ds, "recordIds": ["SHP-0001"], "failureMode": "transient"})
        msg = self.queue.messages[0]
        for attempt, expected_backoff in ((1, 5), (2, 15)):
            self.queue.messages = [msg]
            result, _ = self.deliver(attempt)
            self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "m0"}]})
            self.assertEqual(self.sqs.backoffs[-1], ("rh0", expected_backoff))
        self.queue.messages = [msg]
        result, _ = self.deliver(3)
        self.assertEqual(result, {"batchItemFailures": []})
        self.assertEqual(self.store.get_job(msg["jobId"])["jobStatus"], "SUCCEEDED")

    def test_worker_dead_letters_after_budget(self):
        ds = self.seed()
        self.call("POST", "/jobs", {"datasetId": ds, "recordIds": ["SHP-0001"], "failureMode": "permanent"})
        msg = self.queue.messages[0]
        for attempt in (1, 2, 3):
            self.queue.messages = [msg]
            result, _ = self.deliver(attempt)
        self.assertEqual(result, {"batchItemFailures": []}, "acked after explicit dead-lettering")
        self.assertEqual(self.sqs.dead[0]["jobId"], msg["jobId"])
        self.assertEqual(self.sqs.dead[0]["errorCode"], "SIMULATED_PERMANENT_FAILURE")
        self.assertEqual(self.store.get_job(msg["jobId"])["jobStatus"], "DEAD_LETTERED")
        status, body = self.call("POST", "/jobs/%s/recover" % msg["jobId"])
        self.assertEqual((status, body["job"]["jobStatus"]), (202, "REDRIVEN"))
        result, _ = self.deliver(1)
        self.assertEqual(self.store.get_job(msg["jobId"])["jobStatus"], "SUCCEEDED")

    def test_worker_falls_back_to_redrive_policy_if_dlq_send_fails(self):
        ds = self.seed()
        self.call("POST", "/jobs", {"datasetId": ds, "recordIds": ["SHP-0001"], "failureMode": "permanent"})
        msg = self.queue.messages[0]
        self.sqs.fail_dlq = True
        for attempt in (1, 2, 3):
            self.queue.messages = [msg]
            result, _ = self.deliver(attempt)
        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "m0"}]})

    def test_worker_handles_poison_and_duplicate_messages(self):
        records = [{"messageId": "p1", "receiptHandle": "r", "body": "{oops", "attributes": {}},
                   {"messageId": "p2", "receiptHandle": "r", "body": json.dumps({"jobId": "../../x"}), "attributes": {}}]
        self.assertEqual(worker.handler({"Records": records}, None), {"batchItemFailures": []})
        self.assertEqual(len(self.sqs.dead), 2)
        ds = self.seed()
        self.call("POST", "/jobs", {"datasetId": ds})
        msg = self.queue.messages[0]
        self.deliver(1)
        audit_before = len(self.store.list_audit())
        self.queue.messages = [msg]
        result, _ = self.deliver(2)
        self.assertEqual(result, {"batchItemFailures": []})
        self.assertEqual(len(self.store.list_audit()), audit_before)


if __name__ == "__main__":
    unittest.main()
