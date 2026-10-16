"""TransitShield worker Lambda (SQS event source).

For each message: validate -> score -> persist -> complete, via
``service.process_job``. Failure handling:

* Retryable failure with attempts left: the job becomes RETRY_SCHEDULED, the
  message's visibility is shortened to a small backoff, and the message is
  reported in ``batchItemFailures`` so SQS redelivers only that message.
* Retry budget exhausted (MAX_ATTEMPTS): the job becomes DEAD_LETTERED and the
  worker copies the message to the DLQ, then acknowledges it. The queue's own
  redrive policy (maxReceiveCount, larger than MAX_ATTEMPTS) remains as a
  backstop for crashes and timeouts where this code never gets to run.
* Non-retryable failure (e.g. dataset deleted): job FAILED, message acked.

Duplicate deliveries are harmless: a SUCCEEDED job is ignored, a job being
processed under a live lease is skipped, and every write is idempotent.
"""

import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from shared import service  # noqa: E402
from shared.service import PermanentJobError, RetryableError  # noqa: E402

RE_JOB = re.compile(r"^JOB-[0-9A-F]{16}$")
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))
BACKOFF_SECONDS = [5, 15, 30]

_deps = {}


def configure(**kwargs):
    _deps.clear()
    _deps.update(kwargs)


class _Sqs:
    def __init__(self, queue_url, dlq_url):
        import boto3
        self.client = boto3.client("sqs")
        self.queue_url = queue_url
        self.dlq_url = dlq_url

    def backoff(self, receipt_handle, seconds):
        self.client.change_message_visibility(QueueUrl=self.queue_url, ReceiptHandle=receipt_handle,
                                              VisibilityTimeout=seconds)

    def dead_letter(self, body):
        self.client.send_message(QueueUrl=self.dlq_url, MessageBody=json.dumps(body, separators=(",", ":")))


def deps():
    if not _deps:
        from shared.store import DynamoStore
        _deps["store"] = DynamoStore(os.environ["RECORDS_TABLE"], os.environ["JOBS_TABLE"],
                                     os.environ["CASES_TABLE"], os.environ["AUDIT_TABLE"],
                                     region=os.environ.get("AWS_REGION"))
        _deps["sqs"] = _Sqs(os.environ["QUEUE_URL"], os.environ["DLQ_URL"])
    return _deps


_LEVELS = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}


def log(level, message, **fields):
    if _LEVELS.get(level, 20) < _LEVELS.get(os.environ.get("LOG_LEVEL", "INFO"), 20):
        return
    entry = {"level": level, "message": message, "service": "worker"}
    entry.update(fields)
    print(json.dumps(entry, default=str, separators=(",", ":")))


def emit_metrics(**values):
    """CloudWatch Embedded Metric Format: one log line -> custom metrics.

    Five metric names on a single dimension (Service=worker), within the
    CloudWatch free tier of 10 custom metrics.
    """
    names = [k for k, v in values.items() if v is not None]
    if not names or os.environ.get("EMF_ENABLED", "true") != "true":
        return
    doc = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [{
                "Namespace": "TransitShield",
                "Dimensions": [["Service"]],
                "Metrics": [{"Name": n, "Unit": "Milliseconds" if n == "ProcessingMs" else "Count"} for n in names],
            }],
        },
        "Service": "worker",
    }
    for n in names:
        doc[n] = values[n]
    print(json.dumps(doc, separators=(",", ":")))


def _handle_one(msg, d):
    message_id = msg.get("messageId")
    receive_count = int((msg.get("attributes") or {}).get("ApproximateReceiveCount", "1"))
    try:
        body = json.loads(msg.get("body") or "")
    except ValueError:
        body = None
    if not isinstance(body, dict) or not isinstance(body.get("jobId"), str) or not RE_JOB.match(body["jobId"]):
        log("ERROR", "poison message moved to DLQ", messageId=message_id)
        d["sqs"].dead_letter({"poison": True, "messageId": message_id, "reason": "MALFORMED_MESSAGE"})
        return True
    job_id = body["jobId"]
    started = time.time()
    try:
        outcome = service.process_job(d["store"], job_id, receive_count, log=lambda m, **f: log("WARN", m, **f))
        took = int((time.time() - started) * 1000)
        log("INFO", "job processed", jobId=job_id, outcome=outcome, receiveCount=receive_count, ms=took)
        if outcome == "SUCCEEDED":
            job = d["store"].get_job(job_id) or {}
            emit_metrics(JobsSucceeded=1, RecordsScored=(job.get("resultSummary") or {}).get("scored"),
                         ProcessingMs=took)
        return True
    except (RetryableError, PermanentJobError, Exception) as err:
        if not isinstance(err, (RetryableError, PermanentJobError)):
            log("ERROR", "unexpected processing error", jobId=job_id, errorType=type(err).__name__)
            err = RetryableError("INTERNAL_ERROR", "Unexpected processing error (" + type(err).__name__ + ").")
        status = service.record_job_failure(d["store"], job_id, err, MAX_ATTEMPTS, receive_count=receive_count)
        log("WARN", "job attempt failed", jobId=job_id, errorCode=err.code, newStatus=status,
            receiveCount=receive_count)
        emit_metrics(JobAttemptsFailed=1)
        if status == "RETRY_SCHEDULED":
            job = d["store"].get_job(job_id) or {}
            n = max(0, job.get("attemptCount", 1) - job.get("attemptBase", 0) - 1)
            try:
                d["sqs"].backoff(msg["receiptHandle"], BACKOFF_SECONDS[min(n, len(BACKOFF_SECONDS) - 1)])
            except Exception as backoff_err:  # falls back to the queue's visibility timeout
                log("WARN", "backoff not applied", errorType=type(backoff_err).__name__)
            return False
        if status == "DEAD_LETTERED":
            try:
                d["sqs"].dead_letter(dict(body, deadLetteredAt=service.now_iso(), errorCode=err.code))
            except Exception as dlq_err:
                log("ERROR", "explicit dead-letter failed; relying on redrive policy",
                    errorType=type(dlq_err).__name__)
                return False
            emit_metrics(JobsDeadLettered=1)
            return True
        return True  # FAILED (non-retryable) or job missing: acknowledge


def handler(event, context):
    d = deps()
    failures = []
    for msg in event.get("Records", []):
        if not _handle_one(msg, d):
            failures.append({"itemIdentifier": msg.get("messageId")})
    return {"batchItemFailures": failures}
