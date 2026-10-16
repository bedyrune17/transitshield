"""TransitShield API Lambda (invoked through a Lambda Function URL).

Security layers, outermost first:
1. Function URL AuthType=AWS_IAM: AWS rejects unsigned requests before this
   code runs. Only Cognito identity-pool credentials of signed-in users can
   sign requests (see infrastructure/template.yaml).
2. This handler verifies the Cognito *access token* (X-TransitShield-Token
   header) - signature, issuer, expiry, token_use and client_id - and takes
   the actor identity and groups only from the verified token.
3. Role checks per operation, strict input validation, body-size limits,
   method allow-lists and per-user rate limits.
"""

import json
import os
import re
import sys
import time
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from shared import service  # noqa: E402
from shared.auth import AuthError, verify_access_token  # noqa: E402
from shared.generator import SCENARIOS, dataset_id_for  # noqa: E402
from shared.service import ServiceError  # noqa: E402

MAX_BODY_BYTES = 8 * 1024
TOKEN_HEADER = "x-transitshield-token"

RE_DATASET = re.compile(r"^ds-[a-z-]{3,40}-s\d{1,10}-n\d{2,3}$")
RE_RECORD = re.compile(r"^(MAN|SHP|INV|TXN)-\d{4}$")
RE_JOB = re.compile(r"^JOB-[0-9A-F]{16}$")
RE_CASE = re.compile(r"^CASE-ds-[a-z-]{3,40}-s\d{1,10}-n\d{2,3}-(MAN|SHP|INV|TXN)-\d{4}$")
RE_STREAM = re.compile(r"^(CASE|JOB|DATASET|SECURITY)#[A-Za-z0-9#:_-]{1,120}$")

RATE_LIMITS = {
    "seed": (10, 3600),
    "job": (30, 600),
    "case": (120, 600),
    "recover": (20, 600),
    "reset": (10, 3600),
}
GLOBAL_JOB_LIMIT = (300, 3600)

_deps = {}


# --------------------------------------------------------------------------
# dependencies (lazily built from environment; injectable for tests)
# --------------------------------------------------------------------------
def configure(**kwargs):
    _deps.clear()
    _deps.update(kwargs)


def _env(name, default=None):
    return os.environ.get(name, default)


class SqsQueue:
    def __init__(self, url, client=None):
        import boto3
        self.url = url
        self.client = client or boto3.client("sqs")

    def send(self, body):
        self.client.send_message(QueueUrl=self.url, MessageBody=json.dumps(body, separators=(",", ":")))


class SqsDeadLetterQueue(SqsQueue):
    def remove_job_messages(self, job_id, rounds=3):
        removed = 0
        for _ in range(rounds):
            resp = self.client.receive_message(QueueUrl=self.url, MaxNumberOfMessages=10, WaitTimeSeconds=0,
                                               VisibilityTimeout=5)
            msgs = resp.get("Messages", [])
            if not msgs:
                break
            for m in msgs:
                try:
                    body = json.loads(m["Body"])
                except ValueError:
                    continue
                if isinstance(body, dict) and body.get("jobId") == job_id:
                    self.client.delete_message(QueueUrl=self.url, ReceiptHandle=m["ReceiptHandle"])
                    removed += 1
        return removed


class LiveOps:
    """Reads genuine AWS-side state for the dashboard (cached briefly)."""

    def __init__(self, queue_url, dlq_url, alarm_name, worker_fn, region):
        self.queue_url = queue_url
        self.dlq_url = dlq_url
        self.alarm_name = alarm_name
        self.worker_fn = worker_fn
        self.region = region
        self._cache = None
        self._at = 0

    def snapshot(self):
        if self._cache and time.time() - self._at < 30:
            return dict(self._cache, cached=True)
        import boto3
        from datetime import datetime, timedelta, timezone
        sqs = boto3.client("sqs", region_name=self.region)
        cw = boto3.client("cloudwatch", region_name=self.region)
        names = ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible",
                 "ApproximateNumberOfMessagesDelayed"]

        def attrs(url):
            a = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=names)["Attributes"]
            return {"visible": int(a.get(names[0], 0)), "inFlight": int(a.get(names[1], 0)),
                    "delayed": int(a.get(names[2], 0))}

        out = {"source": "aws", "region": self.region, "fetchedAt": service.now_iso()}
        try:
            out["queue"] = attrs(self.queue_url)
            out["deadLetterQueue"] = attrs(self.dlq_url)
        except Exception as err:  # report, do not hide
            out["queueError"] = type(err).__name__
        try:
            alarms = cw.describe_alarms(AlarmNames=[self.alarm_name]).get("MetricAlarms", [])
            out["dlqAlarm"] = {"name": self.alarm_name, "state": alarms[0]["StateValue"]} if alarms else None
        except Exception as err:
            out["alarmError"] = type(err).__name__
        try:
            end = datetime.now(timezone.utc)
            start = end - timedelta(hours=1)
            metrics = {}
            for metric, stat in (("Invocations", "Sum"), ("Errors", "Sum"), ("Duration", "Average"),
                                 ("Throttles", "Sum")):
                resp = cw.get_metric_statistics(Namespace="AWS/Lambda", MetricName=metric,
                                                Dimensions=[{"Name": "FunctionName", "Value": self.worker_fn}],
                                                StartTime=start, EndTime=end, Period=3600, Statistics=[stat])
                pts = resp.get("Datapoints", [])
                metrics[metric] = round(pts[0][stat], 2) if pts else 0
            out["workerLambdaLastHour"] = metrics
        except Exception as err:
            out["metricsError"] = type(err).__name__
        self._cache = out
        self._at = time.time()
        return dict(out, cached=False)


def deps():
    if not _deps:
        from shared.store import DynamoStore
        region = _env("AWS_REGION", "ap-south-1")
        _deps["store"] = DynamoStore(_env("RECORDS_TABLE"), _env("JOBS_TABLE"), _env("CASES_TABLE"),
                                     _env("AUDIT_TABLE"), region=region)
        _deps["queue"] = SqsQueue(_env("QUEUE_URL"))
        _deps["dlq"] = SqsDeadLetterQueue(_env("DLQ_URL"))
        _deps["ops"] = LiveOps(_env("QUEUE_URL"), _env("DLQ_URL"), _env("DLQ_ALARM_NAME"),
                               _env("WORKER_FUNCTION_NAME"), region)
        _deps["auth"] = {"region": _env("COGNITO_REGION", region), "user_pool_id": _env("USER_POOL_ID"),
                         "client_id": _env("APP_CLIENT_ID")}
        _deps["require_iam"] = _env("REQUIRE_IAM_AUTH", "true") == "true"
    return _deps


# --------------------------------------------------------------------------
# responses and logging
# --------------------------------------------------------------------------
_LEVELS = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}


def log(level, message, **fields):
    if _LEVELS.get(level, 20) < _LEVELS.get(os.environ.get("LOG_LEVEL", "INFO"), 20):
        return
    entry = {"level": level, "message": message, "service": "api"}
    entry.update(fields)
    print(json.dumps(entry, default=str, separators=(",", ":")))


def respond(status, body, request_id):
    payload = dict(body)
    payload["requestId"] = request_id
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff"},
        "body": json.dumps(payload, default=str, separators=(",", ":")),
    }


def error(status, code, message, request_id, details=None):
    err = {"code": code, "message": message}
    if details is not None:
        err["details"] = details
    return respond(status, {"error": err}, request_id)


class BadRequest(Exception):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details


# --------------------------------------------------------------------------
# input validation helpers
# --------------------------------------------------------------------------
def parse_body(event):
    raw = event.get("body")
    if raw is None or raw == "":
        return {}
    if event.get("isBase64Encoded"):
        import base64
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except Exception:
            raise BadRequest("INVALID_BODY", "Request body is not valid UTF-8.")
    if len(raw.encode("utf-8")) > MAX_BODY_BYTES:
        raise BadRequest("PAYLOAD_TOO_LARGE", "Request body exceeds 8 KB.", status=413)
    try:
        body = json.loads(raw)
    except ValueError:
        raise BadRequest("INVALID_JSON", "Request body is not valid JSON.")
    if not isinstance(body, dict):
        raise BadRequest("INVALID_BODY", "Request body must be a JSON object.")
    return body


def only_keys(body, allowed, required=()):
    unknown = sorted(set(body) - set(allowed))
    if unknown:
        raise BadRequest("VALIDATION_ERROR", "Unknown field(s): " + ", ".join(unknown[:5]) + ".")
    missing = [k for k in required if k not in body]
    if missing:
        raise BadRequest("VALIDATION_ERROR", "Missing required field(s): " + ", ".join(missing) + ".")


def want_int(body, key, lo, hi, default=None):
    v = body.get(key, default)
    if not isinstance(v, int) or isinstance(v, bool) or v < lo or v > hi:
        raise BadRequest("VALIDATION_ERROR", key + " must be an integer between %d and %d." % (lo, hi))
    return v


def want_id(value, regex, what):
    if not isinstance(value, str) or not regex.match(value):
        raise BadRequest("VALIDATION_ERROR", "Invalid " + what + ".", status=400)
    return value


def rate_limit(store, actor, bucket):
    limit, window = RATE_LIMITS[bucket]
    if not store.consume_rate(bucket + "#" + actor["sub"], limit, window):
        raise BadRequest("RATE_LIMITED", "Too many requests of this kind; try again later.", status=429)


# --------------------------------------------------------------------------
# routes
# --------------------------------------------------------------------------
def route(method, path, event, actor, d):
    store = d["store"]
    q = event.get("queryStringParameters") or {}
    parts = [p for p in path.split("/") if p]

    if parts == ["me"] and method == "GET":
        return 200, {"actor": {"sub": actor["sub"], "username": actor["username"], "groups": actor["groups"],
                               "roles": service.roles_for(actor)}}

    if parts == ["config"] and method == "GET":
        return 200, {"rules": service.rules(),
                     "scenarios": [{"id": k, "label": v["label"], "description": v["description"]}
                                   for k, v in SCENARIOS.items()]}

    if parts == ["ops"] and method == "GET":
        return 200, {"ops": d["ops"].snapshot() if d.get("ops") else None}

    if parts == ["datasets"]:
        if method == "GET":
            return 200, {"datasets": sorted((service.dataset_summary(m) for m in store.list_datasets()),
                                            key=lambda m: m.get("createdAt") or "", reverse=True)}
        if method == "POST":
            body = parse_body(event)
            only_keys(body, ("scenario", "seed", "count"), ("scenario",))
            if not isinstance(body["scenario"], str) or body["scenario"] not in SCENARIOS:
                raise BadRequest("VALIDATION_ERROR", "Unknown scenario.")
            seed = want_int(body, "seed", 0, 4294967295, default=42)
            count = want_int(body, "count", 20, 300, default=100)
            service.require_role(actor, service.ROLE_ANALYST)
            rate_limit(store, actor, "seed")
            target = dataset_id_for(body["scenario"], seed, count)
            if len(store.list_datasets()) >= 8 and not store.get_dataset(target):
                raise BadRequest("DATASET_LIMIT", "At most 8 demo datasets may exist; reset one first.", status=409)
            meta, created = service.seed_dataset(store, actor, body["scenario"], seed, count)
            return (201 if created else 200), {"dataset": service.dataset_summary(meta), "created": created}
        raise BadRequest("METHOD_NOT_ALLOWED", "Method not allowed.", status=405)

    if len(parts) >= 2 and parts[0] == "datasets":
        dataset_id = want_id(parts[1], RE_DATASET, "dataset ID")
        if len(parts) == 2:
            if method == "GET":
                meta = store.get_dataset(dataset_id)
                if not meta:
                    raise ServiceError(404, "NOT_FOUND", "Dataset not found.")
                return 200, {"dataset": meta}
            if method == "DELETE":
                service.require_role(actor, service.ROLE_ADMIN)
                rate_limit(store, actor, "reset")
                return 200, {"reset": service.reset_dataset(store, actor, dataset_id)}
            raise BadRequest("METHOD_NOT_ALLOWED", "Method not allowed.", status=405)
        if method != "GET":
            raise BadRequest("METHOD_NOT_ALLOWED", "Method not allowed.", status=405)
        sub = parts[2]
        if sub == "records" and len(parts) == 3:
            if not store.get_dataset(dataset_id):
                raise ServiceError(404, "NOT_FOUND", "Dataset not found.")
            records = service.with_live_status(store.list_records(dataset_id),
                                               service.active_job_index(store, dataset_id))
            records.sort(key=lambda r: r["recordId"])
            return 200, {"records": records}
        if sub == "records" and len(parts) == 4:
            record_id = want_id(parts[3], RE_RECORD, "record ID")
            rec = store.get_record(dataset_id, record_id)
            if rec is None:
                raise ServiceError(404, "UNKNOWN_RECORD", "Record not found in this dataset.")
            service.with_live_status([rec], service.active_job_index(store, dataset_id))
            case = store.get_case(service.casewf.case_id_for(dataset_id, record_id))
            return 200, {"record": rec, "case": case}
        if sub == "labels" and len(parts) == 3:
            return 200, {"labels": store.get_labels(dataset_id)}
        if sub == "evaluation" and len(parts) == 3:
            return 200, {"evaluation": service.dataset_evaluation(store, dataset_id)}
        if sub == "metrics" and len(parts) == 3:
            return 200, {"metrics": service.dataset_metrics(store, dataset_id)}
        raise BadRequest("NOT_FOUND", "Route not found.", status=404)

    if parts == ["jobs"]:
        if method == "GET":
            ds = q.get("datasetId")
            jobs = [j for j in store.list_jobs() if not ds or j.get("datasetId") == ds]
            jobs.sort(key=lambda j: j.get("createdAtEpochMs", 0), reverse=True)
            return 200, {"jobs": [service.public_job(j) for j in jobs[:100]]}
        if method == "POST":
            body = parse_body(event)
            only_keys(body, ("datasetId", "recordIds", "failureMode", "profile"), ("datasetId",))
            dataset_id = want_id(body["datasetId"], RE_DATASET, "dataset ID")
            record_ids = body.get("recordIds")
            if record_ids is not None:
                if not isinstance(record_ids, list) or not all(isinstance(r, str) and RE_RECORD.match(r)
                                                               for r in record_ids):
                    raise BadRequest("VALIDATION_ERROR", "recordIds must be a list of record IDs.")
            mode = body.get("failureMode", "none")
            if not isinstance(mode, str):
                raise BadRequest("VALIDATION_ERROR", "failureMode must be a string.")
            profile = body.get("profile")
            if profile is not None and not isinstance(profile, str):
                raise BadRequest("VALIDATION_ERROR", "profile must be a string.")
            service.require_role(actor, service.ROLE_ANALYST)
            rate_limit(store, actor, "job")
            if not store.consume_rate("GLOBAL#jobs", GLOBAL_JOB_LIMIT[0], GLOBAL_JOB_LIMIT[1]):
                raise BadRequest("RATE_LIMITED", "The demo's global job budget is used up; try later.", status=429)
            job = service.submit_job(store, d["queue"], actor, dataset_id, record_ids, mode, profile)
            return 202, {"job": service.public_job(job), "accepted": True}
        raise BadRequest("METHOD_NOT_ALLOWED", "Method not allowed.", status=405)

    if len(parts) >= 2 and parts[0] == "jobs":
        job_id = want_id(parts[1], RE_JOB, "job ID")
        if len(parts) == 2 and method == "GET":
            job = store.get_job(job_id)
            if not job:
                raise ServiceError(404, "NOT_FOUND", "Job not found.")
            return 200, {"job": service.public_job(job)}
        if len(parts) == 3 and parts[2] == "recover" and method == "POST":
            parse_body(event)
            service.require_role(actor, service.ROLE_ANALYST)
            rate_limit(store, actor, "recover")
            job = service.recover_job(store, d["queue"], actor, job_id, d.get("dlq"))
            return 202, {"job": service.public_job(job)}
        raise BadRequest("METHOD_NOT_ALLOWED", "Method not allowed.", status=405)

    if parts == ["cases"]:
        if method == "GET":
            ds = q.get("datasetId")
            cases = [c for c in store.list_cases() if (not ds or c.get("datasetId") == ds)
                     and (q.get("includeArchived") == "true" or not c.get("archived"))]
            cases.sort(key=lambda c: c.get("updatedAt") or "", reverse=True)
            return 200, {"cases": cases}
        if method == "POST":
            body = parse_body(event)
            only_keys(body, ("datasetId", "recordId"), ("datasetId", "recordId"))
            dataset_id = want_id(body["datasetId"], RE_DATASET, "dataset ID")
            record_id = want_id(body["recordId"], RE_RECORD, "record ID")
            service.require_role(actor, service.ROLE_ANALYST)
            rate_limit(store, actor, "case")
            case, created = service.open_case(store, actor, dataset_id, record_id)
            return (201 if created else 200), {"case": case, "created": created}
        raise BadRequest("METHOD_NOT_ALLOWED", "Method not allowed.", status=405)

    if len(parts) >= 2 and parts[0] == "cases":
        case_id = want_id(parts[1], RE_CASE, "case ID")
        if len(parts) == 2 and method == "GET":
            case, history = service.get_case_with_history(store, case_id)
            record = store.get_record(case["datasetId"], case["recordId"])
            return 200, {"case": case, "history": history, "record": record}
        if len(parts) == 3 and method == "POST" and parts[2] in ("transition", "comments"):
            body = parse_body(event)
            service.require_role(actor, service.ROLE_ANALYST)
            rate_limit(store, actor, "case")
            if parts[2] == "transition":
                only_keys(body, ("toStatus", "reason", "expectedVersion"), ("toStatus", "expectedVersion"))
                version = want_int(body, "expectedVersion", 1, 10 ** 6)
                if not isinstance(body["toStatus"], str):
                    raise BadRequest("VALIDATION_ERROR", "toStatus must be a string.")
                reason = body.get("reason")
                if reason is not None and not isinstance(reason, str):
                    raise BadRequest("VALIDATION_ERROR", "reason must be a string.")
                case = service.transition_case(store, actor, case_id, body["toStatus"], reason, version)
            else:
                only_keys(body, ("text", "expectedVersion"), ("text", "expectedVersion"))
                version = want_int(body, "expectedVersion", 1, 10 ** 6)
                case = service.add_comment(store, actor, case_id, body["text"], version)
            return 200, {"case": case}
        raise BadRequest("METHOD_NOT_ALLOWED", "Method not allowed.", status=405)

    if parts == ["audit"] and method == "GET":
        stream = q.get("stream")
        if stream is not None and not RE_STREAM.match(stream):
            raise BadRequest("VALIDATION_ERROR", "Invalid audit stream.")
        try:
            limit = int(q.get("limit", "200"))
        except ValueError:
            raise BadRequest("VALIDATION_ERROR", "limit must be an integer.")
        limit = max(1, min(limit, 500))
        events = store.list_audit(stream)
        events.sort(key=service.audit_sort_key, reverse=True)
        return 200, {"events": events[:limit], "total": len(events)}

    raise BadRequest("NOT_FOUND", "Route not found.", status=404)


def _audit_auth_failure(store, code, method, path):
    try:
        if store.consume_rate("auth-failure-audit", 200, 86400):
            day = time.strftime("%Y-%m-%d", time.gmtime())
            service.audit(store, "SECURITY#" + day, "AUTHENTICATION_FAILED", "anonymous",
                          metadata={"reason": code, "method": method, "path": path[:80]})
    except Exception as err:  # auditing must never turn a 401 into a 500
        log("WARN", "auth failure audit skipped", error=type(err).__name__)


def handler(event, context):
    started = time.time()
    request_id = getattr(context, "aws_request_id", None) or str(uuid.uuid4())
    http = (event.get("requestContext") or {}).get("http") or {}
    method = (http.get("method") or "GET").upper()
    path = event.get("rawPath") or "/"
    d = deps()
    status = 500
    actor = None
    try:
        if method not in ("GET", "POST", "DELETE"):
            raise BadRequest("METHOD_NOT_ALLOWED", "Method not allowed.", status=405)
        if path == "/health" and method == "GET":
            status = 200
            return respond(200, {"status": "ok"}, request_id)
        if d.get("require_iam") and not ((event.get("requestContext") or {}).get("authorizer") or {}).get("iam"):
            raise AuthError("IAM_AUTH_REQUIRED", "Request was not authenticated with AWS IAM.")
        headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        token = headers.get(TOKEN_HEADER, "")
        if token.lower().startswith("bearer "):
            token = token[7:]
        a = d["auth"]
        actor = verify_access_token(token, region=a["region"], user_pool_id=a["user_pool_id"],
                                    client_id=a["client_id"], jwks=a.get("jwks"))
        status, body = route(method, path, event, actor, d)
        return respond(status, body, request_id)
    except AuthError as err:
        status = 401
        _audit_auth_failure(d["store"], err.code, method, path)
        return error(401, err.code, err.message, request_id)
    except BadRequest as err:
        status = err.status
        return error(err.status, err.code, err.message, request_id, err.details)
    except ServiceError as err:
        status = err.status
        if err.status == 403 and actor:
            try:
                service.audit(d["store"], "SECURITY#" + time.strftime("%Y-%m-%d", time.gmtime()),
                              "AUTHORIZATION_DENIED", actor["sub"], metadata={"method": method, "path": path[:80]})
            except Exception:
                pass
        return error(err.status, err.code, err.message, request_id, err.details)
    except Exception as err:
        status = 500
        log("ERROR", "unhandled error", requestId=request_id, errorType=type(err).__name__, path=path)
        return error(500, "INTERNAL_ERROR", "An unexpected error occurred.", request_id)
    finally:
        log("INFO", "request", requestId=request_id, method=method, path=path, status=status,
            actor=(actor or {}).get("sub"), latencyMs=int((time.time() - started) * 1000))
