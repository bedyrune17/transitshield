"""Application service: the business operations behind the API and worker.

All functions take an explicit ``store`` (MemoryStore or DynamoStore) and,
where needed, a ``queue`` object with ``send(dict)``. The actor is always the
server-verified identity produced by ``auth.verify_access_token`` - never a
value supplied in a request body.
"""

import hashlib
import itertools
import time
import uuid

from . import cases as casewf
from .evaluation import evaluate
from .generator import SCENARIOS, GeneratorError, generate_dataset
from .scoring import load_rules, resolve_profile, score_dataset
from .store import ACTIVE_JOB_STATUSES, ConditionFailed
from .timeutil import format_ts, now_iso

JOB_TTL_SECONDS = 7 * 86400
LEASE_SECONDS = 60
MAX_RECORDS_PER_JOB = 300
FAILURE_MODES = ("none", "transient", "permanent")
TERMINAL_JOB_STATUSES = ("SUCCEEDED", "FAILED", "DEAD_LETTERED")

ROLE_VIEWER = "viewer"
ROLE_ANALYST = "analyst"
ROLE_ADMIN = "admin"

_RULES = None
_SEQ = itertools.count()


def rules():
    global _RULES
    if _RULES is None:
        _RULES = load_rules()
    return _RULES


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str, details=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


class RetryableError(Exception):
    """Processing failed in a way that a retry may fix."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class PermanentJobError(Exception):
    """Processing failed in a way that retrying cannot fix."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# --------------------------------------------------------------------------
# roles and audit
# --------------------------------------------------------------------------
def roles_for(actor) -> list:
    groups = set(actor.get("groups") or [])
    roles = [ROLE_VIEWER]
    if "analysts" in groups or "admins" in groups:
        roles.append(ROLE_ANALYST)
    if "admins" in groups:
        roles.append(ROLE_ADMIN)
    return roles


def require_role(actor, role):
    if role not in roles_for(actor):
        raise ServiceError(403, "FORBIDDEN", "Your account is not permitted to perform this action.")


def _event_id(idempotency_key: str) -> str:
    return "EVT-" + hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:24]


def audit(store, stream_id, action, actor_id, idempotency_key=None, case_id=None, record_id=None,
          dataset_id=None, job_id=None, metadata=None, timestamp=None):
    """Append an audit event. Deterministic keys make retries idempotent."""
    key = idempotency_key or ("uuid:" + uuid.uuid4().hex)
    ms = int(time.time() * 1000)
    event = {
        "streamId": stream_id,
        "eventId": _event_id(key),
        "action": action,
        "actorId": actor_id,
        "timestamp": timestamp or now_iso(),
        # Millisecond time plus a per-process sequence keeps events written in
        # the same second in the order they happened.
        "sortKey": "%013d.%06d" % (ms, next(_SEQ) % 1000000),
        "metadata": metadata or {},
    }
    for k, v in (("caseId", case_id), ("recordId", record_id), ("datasetId", dataset_id), ("jobId", job_id)):
        if v is not None:
            event[k] = v
    store.append_audit(event)
    return event


def audit_sort_key(event):
    return event.get("sortKey") or event.get("timestamp", "")


def actor_id(actor) -> str:
    return actor.get("sub") or "system"


# --------------------------------------------------------------------------
# datasets
# --------------------------------------------------------------------------
def dataset_summary(meta) -> dict:
    keep = ("datasetId", "scenario", "scenarioLabel", "scenarioDescription", "seed", "requestedCount",
            "recordCount", "generatorVersion", "anomalousRecordCount", "createdAt", "createdBy", "notice")
    return {k: meta.get(k) for k in keep if k in meta}


def seed_dataset(store, actor, scenario, seed, count):
    require_role(actor, ROLE_ANALYST)
    if scenario not in SCENARIOS:
        raise ServiceError(400, "VALIDATION_ERROR", "Unknown scenario.", {"allowed": sorted(SCENARIOS)})
    try:
        data = generate_dataset(scenario, seed, count)
    except GeneratorError as err:
        raise ServiceError(400, "VALIDATION_ERROR", str(err))
    meta = data["meta"]
    existing = store.get_dataset(meta["datasetId"])
    if existing:
        return existing, False
    meta["createdAt"] = now_iso()
    meta["createdBy"] = actor_id(actor)
    created = store.create_dataset(meta, data["labels"], data["records"])
    if created:
        audit(store, "DATASET#" + meta["datasetId"], "DATASET_GENERATED", actor_id(actor),
              idempotency_key="dataset-generated:" + meta["datasetId"] + ":" + meta["createdAt"],
              dataset_id=meta["datasetId"],
              metadata={"scenario": scenario, "seed": seed, "recordCount": meta["recordCount"],
                        "plantedAnomalousRecords": meta["anomalousRecordCount"]})
        return meta, True
    return store.get_dataset(meta["datasetId"]), False


def reset_dataset(store, actor, dataset_id):
    """Demo reset: removes ONLY this synthetic dataset's records and labels.

    Cases are never hard-deleted - they are archived. Audit events are kept.
    """
    require_role(actor, ROLE_ADMIN)
    meta = store.get_dataset(dataset_id)
    if not meta:
        raise ServiceError(404, "NOT_FOUND", "Dataset not found.")
    if not str(meta.get("datasetId", "")).startswith("ds-") or meta.get("generatorVersion") is None:
        raise ServiceError(409, "NOT_DEMO_DATA", "Only generator-created demo datasets can be reset.")
    active = [j for j in store.list_jobs() if j.get("datasetId") == dataset_id
              and j.get("jobStatus") in ACTIVE_JOB_STATUSES]
    if active:
        raise ServiceError(409, "JOBS_ACTIVE", "Wait for active processing jobs on this dataset to finish.")
    removed = store.delete_dataset(dataset_id)
    archived = store.archive_cases_for_dataset(dataset_id, now_iso())
    audit(store, "DATASET#" + dataset_id, "DATASET_RESET", actor_id(actor), dataset_id=dataset_id,
          metadata={"recordsRemoved": removed, "casesArchived": archived})
    return {"datasetId": dataset_id, "recordsRemoved": removed, "casesArchived": archived}


def active_job_index(store, dataset_id):
    """recordId -> job status for jobs that are not finished (derived, no extra writes)."""
    idx = {}
    for j in store.list_jobs():
        if j.get("datasetId") != dataset_id or j.get("jobStatus") not in ACTIVE_JOB_STATUSES:
            continue
        status = "PROCESSING" if j["jobStatus"] == "PROCESSING" else "QUEUED"
        ids = j.get("recordIds")
        if ids is None:
            idx["*"] = status
        else:
            for rid in ids:
                idx[rid] = status
    return idx


def with_live_status(records, idx):
    for r in records:
        live = idx.get(r["recordId"]) or idx.get("*")
        if live:
            r["processingStatus"] = live
    return records


# --------------------------------------------------------------------------
# jobs
# --------------------------------------------------------------------------
def public_job(job) -> dict:
    hide = ("leaseUntil", "itemType", "expiresAt")
    out = {k: v for k, v in job.items() if k not in hide}
    if isinstance(out.get("recordIds"), list) and len(out["recordIds"]) > 25:
        out["recordIdsPreview"] = out["recordIds"][:25]
        out.pop("recordIds")
    return out


def submit_job(store, queue, actor, dataset_id, record_ids=None, failure_mode="none", profile=None, now=None):
    require_role(actor, ROLE_ANALYST)
    meta = store.get_dataset(dataset_id)
    if not meta:
        raise ServiceError(404, "NOT_FOUND", "Dataset not found.")
    if failure_mode not in FAILURE_MODES:
        raise ServiceError(400, "VALIDATION_ERROR", "failureMode must be one of none, transient, permanent.")
    if profile is not None:
        try:
            resolve_profile(rules(), profile)
        except ValueError:
            raise ServiceError(400, "VALIDATION_ERROR", "Unknown scoring profile.")
    if record_ids is not None:
        if not record_ids:
            raise ServiceError(400, "VALIDATION_ERROR", "recordIds must not be empty.")
        if len(record_ids) > MAX_RECORDS_PER_JOB:
            raise ServiceError(400, "VALIDATION_ERROR", "Too many recordIds in one job (max 300).")
        known = {r["recordId"] for r in store.list_records(dataset_id)}
        unknown = sorted(set(record_ids) - known)
        if unknown:
            raise ServiceError(404, "UNKNOWN_RECORD", "Some record IDs do not exist in this dataset.",
                               {"unknownRecordIds": unknown[:20]})
        record_ids = sorted(set(record_ids))
    now = now or time.time()
    created = format_ts(int(now))
    job_id = "JOB-" + uuid.uuid4().hex[:16].upper()
    job = {
        "jobId": job_id,
        "itemType": "JOB",
        "jobType": "SCORE_RECORDS" if record_ids is not None else "SCORE_DATASET",
        "datasetId": dataset_id,
        "recordIds": record_ids,
        "recordCount": len(record_ids) if record_ids is not None else meta.get("recordCount"),
        "failureMode": failure_mode,
        "profile": profile or rules()["defaultProfile"],
        "jobStatus": "QUEUED",
        "createdAt": created,
        "createdAtEpochMs": int(now * 1000),
        "updatedAt": created,
        "submittedBy": actor_id(actor),
        "attemptCount": 0,
        "attempts": [],
        "expiresAt": int(now) + JOB_TTL_SECONDS,
        "version": 1,
    }
    store.create_job(job)
    try:
        queue.send({"jobId": job_id, "datasetId": dataset_id})
    except Exception as err:  # the job must not claim to be queued if SQS rejected it
        store.update_job(job_id, {"jobStatus": "FAILED", "errorCode": "QUEUE_SEND_FAILED",
                                  "errorSummary": "The job could not be submitted to the queue.",
                                  "updatedAt": now_iso()}, allowed_statuses=["QUEUED"])
        raise ServiceError(503, "QUEUE_UNAVAILABLE", "The processing queue is unavailable; job marked FAILED.") from err
    audit(store, "JOB#" + job_id, "JOB_SUBMITTED", actor_id(actor), idempotency_key="job-submitted:" + job_id,
          dataset_id=dataset_id, job_id=job_id,
          metadata={"jobType": job["jobType"], "recordCount": job["recordCount"], "failureMode": failure_mode})
    return job


def process_job(store, job_id, receive_count, now_fn=None, log=None):
    """Worker entry point for one queue message.

    Returns an outcome string. Raises RetryableError / PermanentJobError on
    failure (the worker decides whether to retry or dead-letter).
    """
    now_fn = now_fn or time.time
    log = log or (lambda *a, **k: None)
    job = store.get_job(job_id)
    if job is None:
        return "JOB_NOT_FOUND"
    if job["jobStatus"] in ("SUCCEEDED", "FAILED"):
        return "DUPLICATE_IGNORED"
    if job["jobStatus"] == "DEAD_LETTERED":
        # Only an operator recovery (status REDRIVEN) may resume this job.
        return "DEAD_LETTERED_IGNORED"

    start = now_fn()
    started_iso = format_ts(int(start))
    try:
        job = store.update_job(
            job_id,
            {"jobStatus": "PROCESSING", "leaseUntil": int(start) + LEASE_SECONDS, "updatedAt": started_iso,
             "startedAt": job.get("startedAt") or started_iso},
            allowed_statuses=["QUEUED", "RETRY_SCHEDULED", "REDRIVEN"],
            lease_expired_before=int(start),
            increment_attempt=True,
            append_attempt={"attempt": job.get("attemptCount", 0) + 1, "startedAt": started_iso,
                            "receiveCount": receive_count, "outcome": "STARTED"},
        )
    except ConditionFailed:
        return "LEASE_HELD_ELSEWHERE"
    attempt = job["attemptCount"]

    if job.get("failureMode") == "transient" and attempt <= 2:
        raise RetryableError("SIMULATED_TRANSIENT_FAILURE",
                             "Controlled demo failure (transient): attempt %d of the job fails on purpose." % attempt)
    if job.get("failureMode") == "permanent":
        raise RetryableError("SIMULATED_PERMANENT_FAILURE",
                             "Controlled demo failure (permanent): every attempt fails until an operator recovers it.")

    dataset_id = job["datasetId"]
    if not store.get_dataset(dataset_id):
        raise PermanentJobError("DATASET_NOT_FOUND", "The dataset for this job no longer exists.")
    records = store.list_records(dataset_id)
    if not records:
        raise PermanentJobError("EMPTY_DATASET", "The dataset contains no records.")

    cfg = rules()
    results = score_dataset(records, cfg, job.get("profile"), only_ids=job.get("recordIds"))
    processed_at = format_ts(int(now_fn()))
    for res in results:
        store.save_record_result(dataset_id, res, job_id, processed_at)

    auto_level = cfg["autoCaseMinLevel"]
    levels = [lv["name"] for lv in resolve_profile(cfg, job.get("profile"))["levels"]]
    auto_rank = levels.index(auto_level)
    cases_created = 0
    for res in results:
        if levels.index(res["riskLevel"]) >= auto_rank:
            case, created = _create_case(store, "system:worker", dataset_id, res["recordId"], res, origin="AUTO",
                                         job_id=job_id)
            if created:
                cases_created += 1

    flagged = sum(1 for r in results if r["flagged"])
    by_level = {}
    for r in results:
        by_level[r["riskLevel"]] = by_level.get(r["riskLevel"], 0) + 1
    end = now_fn()
    summary = {"scored": len(results), "flagged": flagged, "byLevel": by_level, "casesCreated": cases_created,
               "scoringVersion": results[0]["scoringVersion"] if results else None}
    audit(store, "JOB#" + job_id, "SCORING_COMPLETED", "system:worker",
          idempotency_key="scoring-completed:" + job_id, dataset_id=dataset_id, job_id=job_id,
          metadata={"scored": len(results), "flagged": flagged, "byLevel": by_level,
                    "flaggedRecordIds": [r["recordId"] for r in results if r["flagged"]][:50]})
    completed_iso = format_ts(int(end))
    try:
        store.update_job(
            job_id,
            {"jobStatus": "SUCCEEDED", "completedAt": completed_iso, "updatedAt": completed_iso,
             "processingMs": int((end - start) * 1000),
             "durationMs": int(end * 1000) - int(job.get("createdAtEpochMs", int(start * 1000))),
             "resultSummary": summary, "errorCode": None, "errorSummary": None,
             "lastAttemptPatch": {"outcome": "SUCCEEDED", "endedAt": completed_iso}},
            allowed_statuses=["PROCESSING"], expect_attempt=attempt,
        )
    except ConditionFailed:
        log("job completion lost lease", jobId=job_id)
        return "COMPLETED_LEASE_LOST"
    return "SUCCEEDED"


def record_job_failure(store, job_id, err, max_attempts, receive_count=None, now=None):
    """Persist a failed attempt and decide what happens next.

    Returns the new job status: RETRY_SCHEDULED (the message goes back to the
    queue), DEAD_LETTERED (retry budget exhausted - the worker moves the
    message to the DLQ) or FAILED (non-retryable). The retry budget counts
    attempts since the last operator recovery (``attemptBase``).
    """
    now = now or time.time()
    ts = format_ts(int(now))
    code = getattr(err, "code", "INTERNAL_ERROR")
    message = getattr(err, "message", "Unexpected processing error.")
    job = store.get_job(job_id)
    if job is None:
        return None
    cycle_attempt = job.get("attemptCount", 0) - job.get("attemptBase", 0)
    if isinstance(err, PermanentJobError):
        status = "FAILED"
    elif cycle_attempt >= max_attempts:
        status = "DEAD_LETTERED"
    else:
        status = "RETRY_SCHEDULED"
    try:
        store.update_job(job_id, {"jobStatus": status, "errorCode": code, "errorSummary": message[:300],
                                  "updatedAt": ts, "leaseUntil": 0,
                                  "lastAttemptPatch": {"outcome": "FAILED", "endedAt": ts, "errorCode": code}},
                         allowed_statuses=["PROCESSING"])
    except ConditionFailed:
        return job.get("jobStatus")
    attempt = job.get("attemptCount", 0)
    action = {"FAILED": "JOB_FAILED", "DEAD_LETTERED": "JOB_DEAD_LETTERED",
              "RETRY_SCHEDULED": "JOB_ATTEMPT_FAILED"}[status]
    audit(store, "JOB#" + job_id, action, "system:worker",
          idempotency_key="job-failure:" + job_id + ":" + str(attempt), dataset_id=job.get("datasetId"),
          job_id=job_id, metadata={"attempt": attempt, "attemptInCycle": cycle_attempt,
                                   "maxAttempts": max_attempts, "receiveCount": receive_count,
                                   "errorCode": code})
    return status


def recover_job(store, queue, actor, job_id, dlq=None):
    """Operator recovery for a dead-lettered (or failed) job: clear the demo
    failure flag, purge this job's copies from the DLQ and re-queue it."""
    require_role(actor, ROLE_ANALYST)
    job = store.get_job(job_id)
    if job is None:
        raise ServiceError(404, "NOT_FOUND", "Job not found.")
    if job["jobStatus"] not in ("DEAD_LETTERED", "FAILED"):
        raise ServiceError(409, "NOT_RECOVERABLE", "Only dead-lettered or failed jobs can be recovered.")
    previous_error = job.get("errorCode")
    try:
        job = store.update_job(job_id, {"jobStatus": "REDRIVEN", "failureMode": "none", "updatedAt": now_iso(),
                                        "recoveredBy": actor_id(actor), "attemptBase": job.get("attemptCount", 0),
                                        "errorCode": None, "errorSummary": None},
                               allowed_statuses=["DEAD_LETTERED", "FAILED"])
    except ConditionFailed:
        raise ServiceError(409, "CONFLICT", "The job changed; refresh and try again.")
    removed = dlq.remove_job_messages(job_id) if dlq is not None else 0
    queue.send({"jobId": job_id, "datasetId": job["datasetId"], "redrive": True})
    audit(store, "JOB#" + job_id, "JOB_RECOVERY_REQUESTED", actor_id(actor),
          idempotency_key="job-recovered:" + job_id + ":" + str(job.get("version")), dataset_id=job["datasetId"],
          job_id=job_id, metadata={"dlqMessagesRemoved": removed, "previousError": previous_error})
    return job


# --------------------------------------------------------------------------
# cases
# --------------------------------------------------------------------------
def _create_case(store, creator, dataset_id, record_id, result, origin, job_id=None):
    cid = casewf.case_id_for(dataset_id, record_id)
    ts = now_iso()
    case = {
        "caseId": cid,
        "datasetId": dataset_id,
        "recordId": record_id,
        "caseStatus": casewf.NEW,
        "origin": origin,
        "priority": "HIGH" if result and result.get("riskLevel") == "HIGH" else "NORMAL",
        "riskScoreAtOpen": result.get("score") if result else None,
        "riskLevelAtOpen": result.get("riskLevel") if result else None,
        "assignedActor": None,
        "createdAt": ts,
        "updatedAt": ts,
        "createdBy": creator,
        "resolutionReason": None,
        "commentCount": 0,
        "archived": False,
        "version": 1,
    }
    created = store.create_case(case)
    if created:
        audit(store, "CASE#" + cid, "CASE_CREATED", creator, idempotency_key="case-created:" + cid,
              case_id=cid, record_id=record_id, dataset_id=dataset_id, job_id=job_id,
              metadata={"origin": origin, "riskScore": case["riskScoreAtOpen"], "riskLevel": case["riskLevelAtOpen"]})
        return case, True
    return store.get_case(cid), False


def open_case(store, actor, dataset_id, record_id):
    require_role(actor, ROLE_ANALYST)
    rec = store.get_record(dataset_id, record_id)
    if rec is None:
        raise ServiceError(404, "UNKNOWN_RECORD", "Record not found in this dataset.")
    result = None
    if rec.get("riskScore") is not None:
        result = {"score": rec["riskScore"], "riskLevel": rec.get("riskLevel")}
    case, created = _create_case(store, actor_id(actor), dataset_id, record_id, result, origin="MANUAL")
    return case, created


def get_case_with_history(store, case_id):
    case = store.get_case(case_id)
    if case is None:
        raise ServiceError(404, "NOT_FOUND", "Case not found.")
    history = sorted(store.list_audit("CASE#" + case_id), key=audit_sort_key)
    return case, history


def transition_case(store, actor, case_id, to_status, reason, expected_version):
    require_role(actor, ROLE_ANALYST)
    case = store.get_case(case_id)
    if case is None:
        raise ServiceError(404, "NOT_FOUND", "Case not found.")
    if case.get("archived"):
        raise ServiceError(409, "CASE_ARCHIVED", "Archived cases are read-only.")
    if case["version"] != expected_version:
        raise ServiceError(409, "VERSION_CONFLICT", "The case was changed by someone else. Reload and retry.",
                           {"currentVersion": case["version"]})
    try:
        text = casewf.check_transition(case["caseStatus"], to_status, reason)
    except casewf.TransitionError as err:
        raise ServiceError(400 if err.code != "INVALID_TRANSITION" else 409, err.code, err.message)
    ts = now_iso()
    updates = {"caseStatus": to_status, "updatedAt": ts, "assignedActor": actor_id(actor)}
    if to_status in casewf.CLOSED:
        updates["resolutionReason"] = text
        updates["closedAt"] = ts
    elif case["caseStatus"] in casewf.CLOSED:
        updates["resolutionReason"] = None
        updates["reopenReason"] = text
    try:
        updated = store.update_case(case_id, expected_version, updates)
    except ConditionFailed:
        current = store.get_case(case_id)
        raise ServiceError(409, "VERSION_CONFLICT", "The case was changed by someone else. Reload and retry.",
                           {"currentVersion": current["version"] if current else None})
    audit(store, "CASE#" + case_id, "CASE_STATUS_CHANGED", actor_id(actor),
          idempotency_key="case-status:" + case_id + ":v" + str(expected_version), case_id=case_id,
          record_id=case["recordId"], dataset_id=case["datasetId"],
          metadata={"from": case["caseStatus"], "to": to_status, "reason": text or None, "version": updated["version"]})
    return updated


def add_comment(store, actor, case_id, text, expected_version):
    require_role(actor, ROLE_ANALYST)
    body = text.strip() if isinstance(text, str) else ""
    if not body:
        raise ServiceError(400, "VALIDATION_ERROR", "Comment text is required.")
    if len(body) > casewf.MAX_COMMENT:
        raise ServiceError(400, "VALIDATION_ERROR", "Comments are limited to 1000 characters.")
    case = store.get_case(case_id)
    if case is None:
        raise ServiceError(404, "NOT_FOUND", "Case not found.")
    if case.get("archived"):
        raise ServiceError(409, "CASE_ARCHIVED", "Archived cases are read-only.")
    try:
        updated = store.update_case(case_id, expected_version,
                                    {"commentCount": case.get("commentCount", 0) + 1, "updatedAt": now_iso()})
    except ConditionFailed:
        current = store.get_case(case_id)
        raise ServiceError(409, "VERSION_CONFLICT", "The case was changed by someone else. Reload and retry.",
                           {"currentVersion": current["version"] if current else None})
    audit(store, "CASE#" + case_id, "CASE_COMMENT_ADDED", actor_id(actor),
          idempotency_key="case-comment:" + case_id + ":v" + str(expected_version), case_id=case_id,
          record_id=case["recordId"], dataset_id=case["datasetId"], metadata={"text": body})
    return updated


# --------------------------------------------------------------------------
# dashboard metrics and evaluation
# --------------------------------------------------------------------------
def dataset_metrics(store, dataset_id):
    records = store.list_records(dataset_id) if dataset_id else []
    idx = active_job_index(store, dataset_id) if dataset_id else {}
    with_live_status(records, idx)
    jobs = [j for j in store.list_jobs() if dataset_id is None or j.get("datasetId") == dataset_id]
    cases = [c for c in store.list_cases() if not c.get("archived")
             and (dataset_id is None or c.get("datasetId") == dataset_id)]
    dist = {"NONE": 0, "LOW": 0, "MEDIUM": 0, "HIGH": 0}
    processed = flagged = 0
    for r in records:
        if r.get("riskLevel") in dist and r.get("processingStatus") == "PROCESSED":
            dist[r["riskLevel"]] += 1
        if r.get("riskScore") is not None:
            processed += 1
            if r.get("flagged"):
                flagged += 1
    finished = [j for j in jobs if j.get("jobStatus") in TERMINAL_JOB_STATUSES]
    succeeded = sum(1 for j in finished if j["jobStatus"] == "SUCCEEDED")
    failed_attempts = sum(1 for j in jobs for a in (j.get("attempts") or []) if a.get("outcome") == "FAILED")
    return {
        "datasetId": dataset_id,
        "totalRecords": len(records),
        "processedRecords": processed,
        "flaggedRecords": flagged,
        "pendingJobs": sum(1 for j in jobs if j.get("jobStatus") in ACTIVE_JOB_STATUSES),
        "riskDistribution": dist,
        "highPriorityCases": sum(1 for c in cases if c.get("priority") == "HIGH"
                                 and c.get("caseStatus") not in casewf.CLOSED),
        "casesAwaitingReview": sum(1 for c in cases if c.get("caseStatus") in (casewf.NEW, casewf.UNDER_REVIEW,
                                                                                casewf.ESCALATED)),
        "casesResolved": sum(1 for c in cases if c.get("caseStatus") == casewf.RESOLVED),
        "casesDismissed": sum(1 for c in cases if c.get("caseStatus") == casewf.DISMISSED),
        "failedJobs": sum(1 for j in jobs if j.get("jobStatus") in ("FAILED", "DEAD_LETTERED")),
        "failedAttempts": failed_attempts,
        "jobSuccessRate": (succeeded / len(finished)) if finished else None,
        "finishedJobs": len(finished),
    }


def dataset_evaluation(store, dataset_id):
    """Evaluate the stored (cloud-computed) scores against the stored labels."""
    records = store.list_records(dataset_id)
    labels = store.get_labels(dataset_id)
    scored = [{"recordId": r["recordId"], "flagged": bool(r.get("flagged"))}
              for r in records if r.get("riskScore") is not None]
    result = evaluate(scored, labels)
    result["unscoredRecords"] = len(records) - len(scored)
    profiles = sorted({r.get("scoringProfile") for r in records if r.get("scoringProfile")})
    result["profilesInStoredScores"] = profiles
    return result
