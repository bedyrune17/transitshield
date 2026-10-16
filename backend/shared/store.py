"""Persistence layer.

``DynamoStore`` is the cloud implementation. ``MemoryStore`` implements the
same interface *and the same conditional-write semantics* so that the
service logic (idempotency, optimistic locking, leases) can be unit-tested
without AWS. The DynamoDB adapter itself is exercised by
``tests/integration``.

Table layout (see docs/ARCHITECTURE.md for access patterns):

* records  PK datasetId, SK recordId
    - datasetId="#DATASETS", recordId=<datasetId>  -> dataset metadata
    - datasetId=<id>,        recordId="#LABELS"    -> ground-truth labels (kept
      apart from scoring input)
    - datasetId=<id>,        recordId=<recordId>   -> synthetic record + result
* jobs     PK jobId   (job items, plus RATE#... rate-limit counters, TTL)
* cases    PK caseId
* audit    PK streamId, SK eventId  (append-only; conditional put)
"""

import copy
import time

DATASETS_PARTITION = "#DATASETS"
LABELS_KEY = "#LABELS"
HISTORY_CAP = 10
ACTIVE_JOB_STATUSES = ("QUEUED", "PROCESSING", "RETRY_SCHEDULED", "REDRIVEN")


class ConditionFailed(Exception):
    """A conditional write was rejected (conflict / duplicate / stale)."""


def _now():
    return int(time.time())


def _record_result_fields(result, job_id, processed_at):
    return {
        "processingStatus": "PROCESSED",
        "riskScore": result["score"],
        "riskLevel": result["riskLevel"],
        "flagged": result["flagged"],
        "triggeredRules": result["triggeredRules"],
        "findings": result["findings"],
        "scoringVersion": result["scoringVersion"],
        "scoringProfile": result["profile"],
        "processedAt": processed_at,
        "lastJobId": job_id,
    }


# --------------------------------------------------------------------------
# In-memory implementation
# --------------------------------------------------------------------------
class MemoryStore:
    def __init__(self):
        self.datasets = {}
        self.labels = {}
        self.records = {}
        self.jobs = {}
        self.cases = {}
        self.audit = {}
        self.rate = {}
        self.write_count = 0

    # datasets -------------------------------------------------------------
    def create_dataset(self, meta, labels, records):
        if meta["datasetId"] in self.datasets:
            return False
        self.datasets[meta["datasetId"]] = copy.deepcopy(meta)
        self.labels[meta["datasetId"]] = copy.deepcopy(labels)
        bucket = {}
        for r in records:
            item = copy.deepcopy(r)
            item.setdefault("processingStatus", "UNPROCESSED")
            item.setdefault("version", 1)
            item.setdefault("processingHistory", [])
            bucket[r["recordId"]] = item
        self.records[meta["datasetId"]] = bucket
        self.write_count += 2 + len(records)
        return True

    def get_dataset(self, dataset_id):
        m = self.datasets.get(dataset_id)
        return copy.deepcopy(m) if m else None

    def list_datasets(self):
        return [copy.deepcopy(m) for m in self.datasets.values()]

    def get_labels(self, dataset_id):
        return copy.deepcopy(self.labels.get(dataset_id, []))

    def delete_dataset(self, dataset_id):
        removed = len(self.records.get(dataset_id, {}))
        self.datasets.pop(dataset_id, None)
        self.labels.pop(dataset_id, None)
        self.records.pop(dataset_id, None)
        return removed

    # records ----------------------------------------------------------------
    def list_records(self, dataset_id):
        return [copy.deepcopy(r) for r in self.records.get(dataset_id, {}).values()]

    def get_record(self, dataset_id, record_id):
        r = self.records.get(dataset_id, {}).get(record_id)
        return copy.deepcopy(r) if r else None

    def save_record_result(self, dataset_id, result, job_id, processed_at):
        rec = self.records.get(dataset_id, {}).get(result["recordId"])
        if rec is None:
            raise ConditionFailed("record not found")
        rec.update(copy.deepcopy(_record_result_fields(result, job_id, processed_at)))
        hist = rec.setdefault("processingHistory", [])
        if not any(h.get("jobId") == job_id for h in hist):
            hist.append({"jobId": job_id, "processedAt": processed_at, "score": result["score"],
                         "riskLevel": result["riskLevel"], "scoringVersion": result["scoringVersion"]})
            del hist[:-HISTORY_CAP]
        rec["version"] = rec.get("version", 1) + 1
        self.write_count += 1

    # jobs -------------------------------------------------------------------
    def create_job(self, job):
        if job["jobId"] in self.jobs:
            raise ConditionFailed("job exists")
        self.jobs[job["jobId"]] = copy.deepcopy(job)
        self.write_count += 1

    def get_job(self, job_id):
        j = self.jobs.get(job_id)
        return copy.deepcopy(j) if j else None

    def list_jobs(self):
        return [copy.deepcopy(j) for j in self.jobs.values()]

    def update_job(self, job_id, updates, allowed_statuses=None, lease_expired_before=None,
                   expect_attempt=None, append_attempt=None, increment_attempt=False):
        """Conditional job update.

        Succeeds when the job exists and (status in ``allowed_statuses``) OR
        (status == PROCESSING and leaseUntil < ``lease_expired_before``).
        ``expect_attempt`` additionally requires attemptCount to match.
        """
        job = self.jobs.get(job_id)
        if job is None:
            raise ConditionFailed("job not found")
        ok = True
        if allowed_statuses is not None:
            ok = job.get("jobStatus") in allowed_statuses
            if not ok and lease_expired_before is not None:
                ok = job.get("jobStatus") == "PROCESSING" and job.get("leaseUntil", 0) < lease_expired_before
        if ok and expect_attempt is not None:
            ok = job.get("attemptCount", 0) == expect_attempt
        if not ok:
            raise ConditionFailed("job state changed")
        if increment_attempt:
            job["attemptCount"] = job.get("attemptCount", 0) + 1
        if append_attempt is not None:
            job.setdefault("attempts", []).append(copy.deepcopy(append_attempt))
        for k, v in updates.items():
            if k == "lastAttemptPatch":
                if job.get("attempts"):
                    job["attempts"][-1].update(copy.deepcopy(v))
                continue
            job[k] = copy.deepcopy(v)
        job["version"] = job.get("version", 0) + 1
        self.write_count += 1
        return copy.deepcopy(job)

    # cases ------------------------------------------------------------------
    def create_case(self, case):
        if case["caseId"] in self.cases:
            return False
        self.cases[case["caseId"]] = copy.deepcopy(case)
        self.write_count += 1
        return True

    def get_case(self, case_id):
        c = self.cases.get(case_id)
        return copy.deepcopy(c) if c else None

    def list_cases(self):
        return [copy.deepcopy(c) for c in self.cases.values()]

    def update_case(self, case_id, expected_version, updates):
        case = self.cases.get(case_id)
        if case is None or case.get("version") != expected_version:
            raise ConditionFailed("version conflict")
        case.update(copy.deepcopy(updates))
        case["version"] = expected_version + 1
        self.write_count += 1
        return copy.deepcopy(case)

    def archive_cases_for_dataset(self, dataset_id, now_iso):
        n = 0
        for case in self.cases.values():
            if case.get("datasetId") == dataset_id and not case.get("archived"):
                case["archived"] = True
                case["archivedAt"] = now_iso
                case["version"] = case.get("version", 1) + 1
                n += 1
        return n

    # audit ------------------------------------------------------------------
    def append_audit(self, event):
        stream = self.audit.setdefault(event["streamId"], {})
        if event["eventId"] in stream:
            return False
        stream[event["eventId"]] = copy.deepcopy(event)
        self.write_count += 1
        return True

    def list_audit(self, stream_id=None):
        if stream_id is not None:
            return [copy.deepcopy(e) for e in self.audit.get(stream_id, {}).values()]
        out = []
        for stream in self.audit.values():
            out.extend(copy.deepcopy(e) for e in stream.values())
        return out

    # rate limiting ----------------------------------------------------------
    def consume_rate(self, key, limit, window_seconds, now=None):
        now = now if now is not None else _now()
        window = now // window_seconds
        full = key + "#" + str(window)
        count = self.rate.get(full, 0)
        if count >= limit:
            return False
        self.rate[full] = count + 1
        return True


# --------------------------------------------------------------------------
# DynamoDB implementation
# --------------------------------------------------------------------------
def _plain(value):
    """Convert DynamoDB Decimals back to ints (we never store floats)."""
    from decimal import Decimal
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


class DynamoStore:
    def __init__(self, records_table, jobs_table, cases_table, audit_table, region=None, resource=None):
        import boto3
        from botocore.config import Config
        cfg = Config(retries={"max_attempts": 10, "mode": "adaptive"}, connect_timeout=3, read_timeout=8)
        ddb = resource or boto3.resource("dynamodb", region_name=region, config=cfg)
        self.records = ddb.Table(records_table)
        self.jobs = ddb.Table(jobs_table)
        self.cases = ddb.Table(cases_table)
        self.audit = ddb.Table(audit_table)
        self._ddb = ddb

    @staticmethod
    def _is_conditional(err):
        code = getattr(err, "response", {}).get("Error", {}).get("Code")
        return code in ("ConditionalCheckFailedException", "TransactionCanceledException")

    def _query_all(self, table, **kwargs):
        items = []
        while True:
            resp = table.query(**kwargs)
            items.extend(resp.get("Items", []))
            lek = resp.get("LastEvaluatedKey")
            if not lek:
                return items
            kwargs["ExclusiveStartKey"] = lek

    def _scan_all(self, table, **kwargs):
        items = []
        while True:
            resp = table.scan(**kwargs)
            items.extend(resp.get("Items", []))
            lek = resp.get("LastEvaluatedKey")
            if not lek:
                return items
            kwargs["ExclusiveStartKey"] = lek

    # datasets -------------------------------------------------------------
    def create_dataset(self, meta, labels, records):
        from botocore.exceptions import ClientError
        item = dict(meta)
        item["datasetId"] = DATASETS_PARTITION
        item["recordId"] = meta["datasetId"]
        item["realDatasetId"] = meta["datasetId"]
        try:
            self.records.put_item(Item=item, ConditionExpression="attribute_not_exists(recordId)")
        except ClientError as err:
            if self._is_conditional(err):
                return False
            raise
        with self.records.batch_writer() as batch:
            batch.put_item(Item={"datasetId": meta["datasetId"], "recordId": LABELS_KEY, "labels": labels})
            for r in records:
                rec = dict(r)
                rec.setdefault("processingStatus", "UNPROCESSED")
                rec.setdefault("version", 1)
                rec.setdefault("processingHistory", [])
                batch.put_item(Item=rec)
        return True

    @staticmethod
    def _meta_from_item(item):
        m = _plain(item)
        m["datasetId"] = m.pop("realDatasetId", m.get("recordId"))
        m.pop("recordId", None)
        return m

    def get_dataset(self, dataset_id):
        resp = self.records.get_item(Key={"datasetId": DATASETS_PARTITION, "recordId": dataset_id})
        item = resp.get("Item")
        return self._meta_from_item(item) if item else None

    def list_datasets(self):
        from boto3.dynamodb.conditions import Key
        items = self._query_all(self.records, KeyConditionExpression=Key("datasetId").eq(DATASETS_PARTITION))
        return [self._meta_from_item(i) for i in items]

    def get_labels(self, dataset_id):
        resp = self.records.get_item(Key={"datasetId": dataset_id, "recordId": LABELS_KEY})
        item = resp.get("Item")
        return _plain(item["labels"]) if item else []

    def delete_dataset(self, dataset_id):
        from boto3.dynamodb.conditions import Key
        keys = self._query_all(self.records, KeyConditionExpression=Key("datasetId").eq(dataset_id),
                               ProjectionExpression="datasetId, recordId")
        removed = 0
        with self.records.batch_writer() as batch:
            for k in keys:
                batch.delete_item(Key={"datasetId": k["datasetId"], "recordId": k["recordId"]})
                if not k["recordId"].startswith("#"):
                    removed += 1
            batch.delete_item(Key={"datasetId": DATASETS_PARTITION, "recordId": dataset_id})
        return removed

    # records ----------------------------------------------------------------
    def list_records(self, dataset_id):
        from boto3.dynamodb.conditions import Key
        items = self._query_all(self.records, KeyConditionExpression=Key("datasetId").eq(dataset_id)
                                & Key("recordId").gt("#~"))
        return [_plain(i) for i in items]

    def get_record(self, dataset_id, record_id):
        if record_id.startswith("#"):
            return None
        resp = self.records.get_item(Key={"datasetId": dataset_id, "recordId": record_id})
        item = resp.get("Item")
        return _plain(item) if item else None

    def save_record_result(self, dataset_id, result, job_id, processed_at):
        from botocore.exceptions import ClientError
        fields = _record_result_fields(result, job_id, processed_at)
        names = {}
        values = {":one": 1, ":job": job_id}
        sets = []
        for i, (k, v) in enumerate(fields.items()):
            names["#f%d" % i] = k
            values[":v%d" % i] = v
            sets.append("#f%d = :v%d" % (i, i))
        entry = {"jobId": job_id, "processedAt": processed_at, "score": result["score"],
                 "riskLevel": result["riskLevel"], "scoringVersion": result["scoringVersion"]}
        key = {"datasetId": dataset_id, "recordId": result["recordId"]}
        # First delivery for this job: append history. A duplicate delivery of
        # the same job (lastJobId already equal) only rewrites identical fields.
        try:
            self.records.update_item(
                Key=key,
                UpdateExpression="SET " + ", ".join(sets)
                + ", #v = if_not_exists(#v, :zero) + :one, #h = list_append(if_not_exists(#h, :empty), :entry)",
                ConditionExpression="attribute_exists(recordId) AND (attribute_not_exists(lastJobId) OR lastJobId <> :job)",
                ExpressionAttributeNames=dict(names, **{"#v": "version", "#h": "processingHistory"}),
                ExpressionAttributeValues=dict(values, **{":zero": 0, ":empty": [], ":entry": [entry]}),
            )
        except ClientError as err:
            if not self._is_conditional(err):
                raise
            self.records.update_item(
                Key=key,
                UpdateExpression="SET " + ", ".join(sets),
                ConditionExpression="attribute_exists(recordId)",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues={k: v for k, v in values.items() if k.startswith(":v")},
            )
            return
        # Trim history to the cap (rare; best effort, idempotent).
        rec = self.get_record(dataset_id, result["recordId"])
        if rec and len(rec.get("processingHistory", [])) > HISTORY_CAP:
            self.records.update_item(
                Key=key, UpdateExpression="SET processingHistory = :h",
                ExpressionAttributeValues={":h": rec["processingHistory"][-HISTORY_CAP:]})

    # jobs -------------------------------------------------------------------
    def create_job(self, job):
        from botocore.exceptions import ClientError
        try:
            self.jobs.put_item(Item=job, ConditionExpression="attribute_not_exists(jobId)")
        except ClientError as err:
            if self._is_conditional(err):
                raise ConditionFailed("job exists")
            raise

    def get_job(self, job_id):
        item = self.jobs.get_item(Key={"jobId": job_id}, ConsistentRead=True).get("Item")
        if not item or item.get("itemType") != "JOB":
            return None
        return _plain(item)

    def list_jobs(self):
        from boto3.dynamodb.conditions import Attr
        return [_plain(i) for i in self._scan_all(self.jobs, FilterExpression=Attr("itemType").eq("JOB"))]

    def update_job(self, job_id, updates, allowed_statuses=None, lease_expired_before=None,
                   expect_attempt=None, append_attempt=None, increment_attempt=False):
        from botocore.exceptions import ClientError
        names = {"#st": "jobStatus", "#ver": "version"}
        values = {":one": 1, ":zero": 0}
        sets = ["#ver = if_not_exists(#ver, :zero) + :one"]
        i = 0
        last_patch = None
        for k, v in updates.items():
            if k == "lastAttemptPatch":
                last_patch = v
                continue
            names["#u%d" % i] = k
            values[":u%d" % i] = v
            sets.append("#u%d = :u%d" % (i, i))
            i += 1
        if increment_attempt:
            names["#ac"] = "attemptCount"
            sets.append("#ac = if_not_exists(#ac, :zero) + :one")
        if append_attempt is not None:
            names["#at"] = "attempts"
            values[":newatt"] = [append_attempt]
            values[":emptyl"] = []
            sets.append("#at = list_append(if_not_exists(#at, :emptyl), :newatt)")
        conds = ["attribute_exists(jobId)"]
        if allowed_statuses is not None:
            opts = []
            for n, s in enumerate(allowed_statuses):
                values[":s%d" % n] = s
                opts.append("#st = :s%d" % n)
            clause = "(" + " OR ".join(opts) + ")"
            if lease_expired_before is not None:
                values[":processing"] = "PROCESSING"
                values[":lease"] = lease_expired_before
                clause = "(" + clause + " OR (#st = :processing AND leaseUntil < :lease))"
            conds.append(clause)
        if expect_attempt is not None:
            names["#ac2"] = "attemptCount"
            values[":expatt"] = expect_attempt
            conds.append("#ac2 = :expatt")
        try:
            resp = self.jobs.update_item(
                Key={"jobId": job_id},
                UpdateExpression="SET " + ", ".join(sets),
                ConditionExpression=" AND ".join(conds),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )
        except ClientError as err:
            if self._is_conditional(err):
                raise ConditionFailed("job state changed")
            raise
        job = _plain(resp["Attributes"])
        if last_patch and job.get("attempts"):
            idx = len(job["attempts"]) - 1
            pn = {"#at": "attempts"}
            pv = {}
            ps = []
            for n, (k, v) in enumerate(last_patch.items()):
                pn["#p%d" % n] = k
                pv[":p%d" % n] = v
                ps.append("#at[%d].#p%d = :p%d" % (idx, n, n))
            resp = self.jobs.update_item(Key={"jobId": job_id}, UpdateExpression="SET " + ", ".join(ps),
                                         ExpressionAttributeNames=pn, ExpressionAttributeValues=pv,
                                         ReturnValues="ALL_NEW")
            job = _plain(resp["Attributes"])
        return job

    # cases ------------------------------------------------------------------
    def create_case(self, case):
        from botocore.exceptions import ClientError
        try:
            self.cases.put_item(Item=case, ConditionExpression="attribute_not_exists(caseId)")
            return True
        except ClientError as err:
            if self._is_conditional(err):
                return False
            raise

    def get_case(self, case_id):
        item = self.cases.get_item(Key={"caseId": case_id}, ConsistentRead=True).get("Item")
        return _plain(item) if item else None

    def list_cases(self):
        return [_plain(i) for i in self._scan_all(self.cases)]

    def update_case(self, case_id, expected_version, updates):
        from botocore.exceptions import ClientError
        names = {"#ver": "version"}
        values = {":expected": expected_version, ":next": expected_version + 1}
        sets = ["#ver = :next"]
        for i, (k, v) in enumerate(updates.items()):
            names["#u%d" % i] = k
            values[":u%d" % i] = v
            sets.append("#u%d = :u%d" % (i, i))
        try:
            resp = self.cases.update_item(
                Key={"caseId": case_id},
                UpdateExpression="SET " + ", ".join(sets),
                ConditionExpression="attribute_exists(caseId) AND #ver = :expected",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )
        except ClientError as err:
            if self._is_conditional(err):
                raise ConditionFailed("version conflict")
            raise
        return _plain(resp["Attributes"])

    def archive_cases_for_dataset(self, dataset_id, now_iso):
        from boto3.dynamodb.conditions import Attr
        items = self._scan_all(self.cases, FilterExpression=Attr("datasetId").eq(dataset_id)
                               & Attr("archived").ne(True))
        for c in items:
            self.cases.update_item(
                Key={"caseId": c["caseId"]},
                UpdateExpression="SET archived = :t, archivedAt = :now, #ver = #ver + :one",
                ExpressionAttributeNames={"#ver": "version"},
                ExpressionAttributeValues={":t": True, ":now": now_iso, ":one": 1},
            )
        return len(items)

    # audit ------------------------------------------------------------------
    def append_audit(self, event):
        from botocore.exceptions import ClientError
        try:
            self.audit.put_item(Item=event, ConditionExpression="attribute_not_exists(eventId)")
            return True
        except ClientError as err:
            if self._is_conditional(err):
                return False
            raise

    def list_audit(self, stream_id=None):
        from boto3.dynamodb.conditions import Key
        if stream_id is not None:
            return [_plain(i) for i in self._query_all(self.audit,
                                                       KeyConditionExpression=Key("streamId").eq(stream_id))]
        return [_plain(i) for i in self._scan_all(self.audit)]

    # rate limiting ----------------------------------------------------------
    def consume_rate(self, key, limit, window_seconds, now=None):
        from botocore.exceptions import ClientError
        now = now if now is not None else _now()
        window = now // window_seconds
        try:
            self.jobs.update_item(
                Key={"jobId": "RATE#" + key + "#" + str(window)},
                UpdateExpression="SET itemType = :rt, expiresAt = :exp ADD hits :one",
                ConditionExpression="attribute_not_exists(hits) OR hits < :limit",
                ExpressionAttributeValues={":rt": "RATE", ":exp": (window + 2) * window_seconds,
                                           ":one": 1, ":limit": limit},
            )
            return True
        except ClientError as err:
            if self._is_conditional(err):
                return False
            raise
