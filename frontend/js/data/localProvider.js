// Local demo provider: the whole backend workflow, in the browser.
//
// Mirrors backend/shared/service.py (same generator, scoring engine, case
// state machine, idempotency rules and retry budget) and simulates the SQS
// queue + worker with timers. Everything here is labelled SIMULATED in the
// UI - none of it is cloud data. State persists in localStorage when the
// browser allows it, and silently stays in memory otherwise.

import { generateDataset, SCENARIOS, datasetIdFor, GeneratorError } from '../core/generator.js';
import { scoreDataset, resolveProfile } from '../core/scoring.js';
import { evaluate } from '../core/evaluation.js';
import { checkTransition, caseIdFor, CLOSED, TransitionError, MAX_COMMENT } from '../core/cases.js';
import { formatTs, nowIso } from '../core/timeutil.js';
import { ApiError } from './errors.js';

const STORAGE_KEY = 'transitshield.local.v1';
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2000, 4000, 6000]; // cloud worker uses 5/15/30 s; shortened for the local demo
const VISIBILITY_MS = 20000;
const WORKERS = 2; // mirrors the SQS event source MaximumConcurrency
const ACTIVE = ['QUEUED', 'PROCESSING', 'RETRY_SCHEDULED', 'REDRIVEN'];
const TERMINAL = ['SUCCEEDED', 'FAILED', 'DEAD_LETTERED'];
const ROLES = {
  admin: ['admins'],
  analyst: ['analysts'],
  viewer: [],
};

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emptyState() {
  return { datasets: {}, labels: {}, records: {}, jobs: {}, cases: {}, audit: [], queue: [], dlq: [], seq: 0, role: 'admin' };
}

function hashKey(s) {
  // FNV-1a 32-bit x2 -> stable event id for idempotent audit writes
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(s.length - 1 - i), 2246822519) >>> 0;
  }
  return 'EVT-' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function randomHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

class RetryableError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
class PermanentJobError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class LocalProvider {
  /** options.latencyMs / options.backoffMs / options.tickMs shorten timings (used by tests). */
  constructor(rules, options = {}) {
    this.mode = 'local';
    this.isLive = false;
    this.rules = rules;
    this.latencyMs = options.latencyMs;
    this.backoffMs = options.backoffMs || BACKOFF_MS;
    this.state = this.load();
    this.busy = 0;
    this.listeners = new Set();
    this.storageWarning = null;
    this.timer = setInterval(() => this.pump(), options.tickMs || 250);
  }

  // ------------------------------------------------------------ persistence
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.datasets) {
          // Messages that were in flight when the tab closed become visible again (like SQS).
          for (const m of s.queue || []) m.visibleAt = 0;
          for (const j of Object.values(s.jobs || {})) if (j.jobStatus === 'PROCESSING') j.leaseUntil = 0;
          return Object.assign(emptyState(), s);
        }
      }
    } catch (e) { /* storage unavailable or corrupt: start fresh in memory */ }
    return emptyState();
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      this.storageWarning = null;
    } catch (e) {
      this.storageWarning = 'Browser storage is unavailable or full; local demo data will not survive a reload.';
    }
    this.listeners.forEach((fn) => { try { fn(); } catch (e) { /* listener errors are not fatal */ } });
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  destroy() { clearInterval(this.timer); }

  // ------------------------------------------------------------ identity
  actor() {
    const role = this.state.role || 'admin';
    return { sub: 'local-demo-' + role, username: 'Local demo ' + role, groups: ROLES[role] || [] };
  }

  roles(actor = this.actor()) {
    const g = new Set(actor.groups);
    const r = ['viewer'];
    if (g.has('analysts') || g.has('admins')) r.push('analyst');
    if (g.has('admins')) r.push('admin');
    return r;
  }

  require(role) {
    if (!this.roles().includes(role)) {
      this.audit('SECURITY#' + nowIso().slice(0, 10), 'AUTHORIZATION_DENIED', this.actor().sub, { metadata: { role } });
      this.save();
      throw new ApiError(403, 'FORBIDDEN', 'Your account is not permitted to perform this action.');
    }
  }

  async setRole(role) {
    if (!ROLES[role]) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown role.');
    this.state.role = role;
    this.save();
  }

  async getIdentity() {
    const a = this.actor();
    return { sub: a.sub, username: a.username, groups: a.groups, roles: this.roles(a), simulated: true };
  }

  // ------------------------------------------------------------ audit
  audit(streamId, action, actorId, { key, caseId, recordId, datasetId, jobId, metadata } = {}) {
    const eventId = hashKey(key || 'uuid:' + randomHex(12));
    if (this.state.audit.some((e) => e.streamId === streamId && e.eventId === eventId)) return false;
    this.state.seq += 1;
    const ev = {
      streamId, eventId, action, actorId, timestamp: nowIso(),
      sortKey: String(Date.now()).padStart(13, '0') + '.' + String(this.state.seq).padStart(6, '0'),
      metadata: metadata || {},
    };
    if (caseId) ev.caseId = caseId;
    if (recordId) ev.recordId = recordId;
    if (datasetId) ev.datasetId = datasetId;
    if (jobId) ev.jobId = jobId;
    this.state.audit.push(ev);
    return true;
  }

  // ------------------------------------------------------------ config & datasets
  async getConfig() {
    return { rules: clone(this.rules), scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, ...s })) };
  }

  summary(m) {
    const keep = ['datasetId', 'scenario', 'scenarioLabel', 'scenarioDescription', 'seed', 'requestedCount',
      'recordCount', 'generatorVersion', 'anomalousRecordCount', 'createdAt', 'createdBy', 'notice'];
    const out = {};
    keep.forEach((k) => { if (m[k] !== undefined) out[k] = m[k]; });
    return out;
  }

  async listDatasets() {
    return Object.values(this.state.datasets).map((m) => this.summary(m))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async seedDataset({ scenario, seed = 42, count = 100 }) {
    this.require('analyst');
    let data;
    try {
      data = generateDataset(scenario, seed, count);
    } catch (e) {
      if (e instanceof GeneratorError) throw new ApiError(400, 'VALIDATION_ERROR', e.message);
      throw e;
    }
    const id = data.meta.datasetId;
    if (this.state.datasets[id]) return { dataset: this.summary(this.state.datasets[id]), created: false };
    if (Object.keys(this.state.datasets).length >= 8) {
      throw new ApiError(409, 'DATASET_LIMIT', 'At most 8 demo datasets may exist; reset one first.');
    }
    const meta = data.meta;
    meta.createdAt = nowIso();
    meta.createdBy = this.actor().sub;
    this.state.datasets[id] = meta;
    this.state.labels[id] = data.labels;
    const bucket = {};
    for (const r of data.records) {
      bucket[r.recordId] = { ...r, processingStatus: 'UNPROCESSED', version: 1, processingHistory: [] };
    }
    this.state.records[id] = bucket;
    this.audit('DATASET#' + id, 'DATASET_GENERATED', this.actor().sub, {
      key: 'dataset-generated:' + id + ':' + meta.createdAt, datasetId: id,
      metadata: { scenario, seed, recordCount: meta.recordCount, plantedAnomalousRecords: meta.anomalousRecordCount },
    });
    this.save();
    return { dataset: this.summary(meta), created: true };
  }

  async getDataset(id) {
    const m = this.state.datasets[id];
    if (!m) throw new ApiError(404, 'NOT_FOUND', 'Dataset not found.');
    return clone(m);
  }

  async resetDataset(id) {
    this.require('admin');
    if (!this.state.datasets[id]) throw new ApiError(404, 'NOT_FOUND', 'Dataset not found.');
    if (Object.values(this.state.jobs).some((j) => j.datasetId === id && ACTIVE.includes(j.jobStatus))) {
      throw new ApiError(409, 'JOBS_ACTIVE', 'Wait for active processing jobs on this dataset to finish.');
    }
    const removed = Object.keys(this.state.records[id] || {}).length;
    delete this.state.datasets[id];
    delete this.state.labels[id];
    delete this.state.records[id];
    let archived = 0;
    for (const c of Object.values(this.state.cases)) {
      if (c.datasetId === id && !c.archived) {
        c.archived = true;
        c.archivedAt = nowIso();
        c.version += 1;
        archived += 1;
      }
    }
    this.audit('DATASET#' + id, 'DATASET_RESET', this.actor().sub, { datasetId: id, metadata: { recordsRemoved: removed, casesArchived: archived } });
    this.save();
    return { datasetId: id, recordsRemoved: removed, casesArchived: archived };
  }

  /** Clears ALL local demo state (browser only). */
  async wipeLocalData() {
    this.state = emptyState();
    this.save();
  }

  // ------------------------------------------------------------ records
  liveIndex(datasetId) {
    const idx = {};
    for (const j of Object.values(this.state.jobs)) {
      if (j.datasetId !== datasetId || !ACTIVE.includes(j.jobStatus)) continue;
      const st = j.jobStatus === 'PROCESSING' ? 'PROCESSING' : 'QUEUED';
      if (!j.recordIds) idx['*'] = st;
      else j.recordIds.forEach((r) => { idx[r] = st; });
    }
    return idx;
  }

  withLive(datasetId, recs) {
    const idx = this.liveIndex(datasetId);
    return recs.map((r) => {
      const live = idx[r.recordId] || idx['*'];
      return live ? { ...r, processingStatus: live } : r;
    });
  }

  async listRecords(datasetId) {
    if (!this.state.datasets[datasetId]) throw new ApiError(404, 'NOT_FOUND', 'Dataset not found.');
    const recs = Object.values(this.state.records[datasetId] || {}).sort((a, b) => a.recordId.localeCompare(b.recordId));
    return clone(this.withLive(datasetId, recs));
  }

  async getRecord(datasetId, recordId) {
    const rec = (this.state.records[datasetId] || {})[recordId];
    if (!rec) throw new ApiError(404, 'UNKNOWN_RECORD', 'Record not found in this dataset.');
    return { record: clone(this.withLive(datasetId, [rec])[0]), case: clone(this.state.cases[caseIdFor(datasetId, recordId)] || null) };
  }

  async getLabels(datasetId) {
    return clone(this.state.labels[datasetId] || []);
  }

  // ------------------------------------------------------------ jobs
  publicJob(j) {
    const out = clone(j);
    delete out.leaseUntil;
    return out;
  }

  async listJobs(datasetId) {
    return Object.values(this.state.jobs)
      .filter((j) => !datasetId || j.datasetId === datasetId)
      .sort((a, b) => b.createdAtEpochMs - a.createdAtEpochMs)
      .slice(0, 100)
      .map((j) => this.publicJob(j));
  }

  async getJob(jobId) {
    const j = this.state.jobs[jobId];
    if (!j) throw new ApiError(404, 'NOT_FOUND', 'Job not found.');
    return this.publicJob(j);
  }

  async submitJob({ datasetId, recordIds = null, failureMode = 'none', profile = null }) {
    this.require('analyst');
    const meta = this.state.datasets[datasetId];
    if (!meta) throw new ApiError(404, 'NOT_FOUND', 'Dataset not found.');
    if (!['none', 'transient', 'permanent'].includes(failureMode)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'failureMode must be one of none, transient, permanent.');
    }
    if (profile) {
      try { resolveProfile(this.rules, profile); } catch (e) { throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown scoring profile.'); }
    }
    if (recordIds) {
      if (!recordIds.length) throw new ApiError(400, 'VALIDATION_ERROR', 'recordIds must not be empty.');
      const known = this.state.records[datasetId];
      const unknown = recordIds.filter((r) => !known[r]);
      if (unknown.length) throw new ApiError(404, 'UNKNOWN_RECORD', 'Some record IDs do not exist in this dataset.', { unknownRecordIds: unknown.slice(0, 20) });
      recordIds = [...new Set(recordIds)].sort();
    }
    const now = Date.now();
    const jobId = 'JOB-' + randomHex(8);
    const job = {
      jobId, jobType: recordIds ? 'SCORE_RECORDS' : 'SCORE_DATASET', datasetId, recordIds,
      recordCount: recordIds ? recordIds.length : meta.recordCount, failureMode,
      profile: profile || this.rules.defaultProfile, jobStatus: 'QUEUED', createdAt: formatTs(Math.floor(now / 1000)),
      createdAtEpochMs: now, updatedAt: formatTs(Math.floor(now / 1000)), submittedBy: this.actor().sub,
      attemptCount: 0, attempts: [], version: 1,
    };
    this.state.jobs[jobId] = job;
    this.state.queue.push({ messageId: randomHex(6), body: { jobId, datasetId }, visibleAt: now + (this.latencyMs !== undefined ? 0 : 300), receiveCount: 0 });
    this.audit('JOB#' + jobId, 'JOB_SUBMITTED', this.actor().sub, {
      key: 'job-submitted:' + jobId, datasetId, jobId,
      metadata: { jobType: job.jobType, recordCount: job.recordCount, failureMode },
    });
    this.save();
    return this.publicJob(job);
  }

  async recoverJob(jobId) {
    this.require('analyst');
    const job = this.state.jobs[jobId];
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'Job not found.');
    if (!['DEAD_LETTERED', 'FAILED'].includes(job.jobStatus)) {
      throw new ApiError(409, 'NOT_RECOVERABLE', 'Only dead-lettered or failed jobs can be recovered.');
    }
    const previousError = job.errorCode;
    Object.assign(job, { jobStatus: 'REDRIVEN', failureMode: 'none', updatedAt: nowIso(), recoveredBy: this.actor().sub,
      attemptBase: job.attemptCount, errorCode: null, errorSummary: null });
    job.version += 1;
    const before = this.state.dlq.length;
    this.state.dlq = this.state.dlq.filter((m) => m.body.jobId !== jobId);
    this.state.queue.push({ messageId: randomHex(6), body: { jobId, datasetId: job.datasetId, redrive: true }, visibleAt: Date.now() + 300, receiveCount: 0 });
    this.audit('JOB#' + jobId, 'JOB_RECOVERY_REQUESTED', this.actor().sub, {
      key: 'job-recovered:' + jobId + ':' + job.version, datasetId: job.datasetId, jobId,
      metadata: { dlqMessagesRemoved: before - this.state.dlq.length, previousError },
    });
    this.save();
    return this.publicJob(job);
  }

  async getOps() {
    const now = Date.now();
    const visible = this.state.queue.filter((m) => m.visibleAt <= now).length;
    const delayed = this.state.queue.filter((m) => m.visibleAt > now && m.receiveCount === 0).length;
    return {
      source: 'simulated',
      fetchedAt: nowIso(),
      queue: { visible, inFlight: this.state.queue.length - visible - delayed, delayed },
      deadLetterQueue: { visible: this.state.dlq.length, inFlight: 0, delayed: 0 },
      dlqAlarm: { name: 'simulated-dlq-alarm', state: this.state.dlq.length > 0 ? 'ALARM' : 'OK' },
      workers: WORKERS,
      busyWorkers: this.busy,
    };
  }

  // ------------------------------------------------------------ simulated worker
  pump() {
    const now = Date.now();
    while (this.busy < WORKERS) {
      const msg = this.state.queue.find((m) => m.visibleAt <= now);
      if (!msg) return;
      msg.receiveCount += 1;
      msg.visibleAt = now + VISIBILITY_MS;
      this.busy += 1;
      this.handleMessage(msg).finally(() => { this.busy -= 1; this.save(); });
    }
  }

  removeMessage(msg) {
    this.state.queue = this.state.queue.filter((m) => m !== msg);
  }

  async handleMessage(msg) {
    const jobId = msg.body.jobId;
    try {
      await this.processJob(jobId, msg.receiveCount);
      this.removeMessage(msg);
    } catch (err) {
      const e = err instanceof RetryableError || err instanceof PermanentJobError ? err
        : new RetryableError('INTERNAL_ERROR', 'Unexpected processing error (' + (err && err.name) + ').');
      const status = this.recordFailure(jobId, e, msg.receiveCount);
      if (status === 'RETRY_SCHEDULED') {
        const job = this.state.jobs[jobId];
        const n = Math.max(0, job.attemptCount - (job.attemptBase || 0) - 1);
        msg.visibleAt = Date.now() + this.backoffMs[Math.min(n, this.backoffMs.length - 1)];
      } else {
        this.removeMessage(msg);
        if (status === 'DEAD_LETTERED') this.state.dlq.push({ messageId: msg.messageId, body: { ...msg.body, errorCode: e.code, deadLetteredAt: nowIso() } });
      }
    }
  }

  async processJob(jobId, receiveCount) {
    let job = this.state.jobs[jobId];
    if (!job || ['SUCCEEDED', 'FAILED', 'DEAD_LETTERED'].includes(job.jobStatus)) return;
    const start = Date.now();
    const runnable = ['QUEUED', 'RETRY_SCHEDULED', 'REDRIVEN'].includes(job.jobStatus)
      || (job.jobStatus === 'PROCESSING' && (job.leaseUntil || 0) < Math.floor(start / 1000));
    if (!runnable) return;
    const startedIso = formatTs(Math.floor(start / 1000));
    job.attemptCount += 1;
    Object.assign(job, { jobStatus: 'PROCESSING', leaseUntil: Math.floor(start / 1000) + 60, updatedAt: startedIso, startedAt: job.startedAt || startedIso });
    job.attempts.push({ attempt: job.attemptCount, startedAt: startedIso, receiveCount, outcome: 'STARTED' });
    job.version += 1;
    this.save();
    await sleep(this.latencyMs !== undefined ? this.latencyMs : 700 + Math.floor(Math.random() * 900)); // simulated latency
    job = this.state.jobs[jobId];
    if (!job) return;
    const attempt = job.attemptCount;
    if (job.failureMode === 'transient' && attempt <= 2) {
      throw new RetryableError('SIMULATED_TRANSIENT_FAILURE', 'Controlled demo failure (transient): attempt ' + attempt + ' of the job fails on purpose.');
    }
    if (job.failureMode === 'permanent') {
      throw new RetryableError('SIMULATED_PERMANENT_FAILURE', 'Controlled demo failure (permanent): every attempt fails until an operator recovers it.');
    }
    const datasetId = job.datasetId;
    if (!this.state.datasets[datasetId]) throw new PermanentJobError('DATASET_NOT_FOUND', 'The dataset for this job no longer exists.');
    const bucket = this.state.records[datasetId];
    const records = Object.values(bucket);
    if (!records.length) throw new PermanentJobError('EMPTY_DATASET', 'The dataset contains no records.');
    const results = scoreDataset(records, this.rules, job.profile, job.recordIds);
    const processedAt = nowIso();
    for (const res of results) {
      const rec = bucket[res.recordId];
      Object.assign(rec, {
        processingStatus: 'PROCESSED', riskScore: res.score, riskLevel: res.riskLevel, flagged: res.flagged,
        triggeredRules: res.triggeredRules, findings: res.findings, scoringVersion: res.scoringVersion,
        scoringProfile: res.profile, processedAt, lastJobId: jobId,
      });
      if (!rec.processingHistory.some((x) => x.jobId === jobId)) {
        rec.processingHistory.push({ jobId, processedAt, score: res.score, riskLevel: res.riskLevel, scoringVersion: res.scoringVersion });
        rec.processingHistory = rec.processingHistory.slice(-10);
      }
      rec.version += 1;
    }
    const levels = resolveProfile(this.rules, job.profile).levels.map((l) => l.name);
    const autoRank = levels.indexOf(this.rules.autoCaseMinLevel);
    let casesCreated = 0;
    for (const res of results) {
      if (levels.indexOf(res.riskLevel) >= autoRank) {
        if (this.createCase('system:worker', datasetId, res.recordId, res, 'AUTO', jobId)) casesCreated += 1;
      }
    }
    const byLevel = {};
    results.forEach((r) => { byLevel[r.riskLevel] = (byLevel[r.riskLevel] || 0) + 1; });
    const flagged = results.filter((r) => r.flagged).length;
    this.audit('JOB#' + jobId, 'SCORING_COMPLETED', 'system:worker', {
      key: 'scoring-completed:' + jobId, datasetId, jobId,
      metadata: { scored: results.length, flagged, byLevel, flaggedRecordIds: results.filter((r) => r.flagged).map((r) => r.recordId).slice(0, 50) },
    });
    const end = Date.now();
    const completedIso = formatTs(Math.floor(end / 1000));
    Object.assign(job, {
      jobStatus: 'SUCCEEDED', completedAt: completedIso, updatedAt: completedIso, processingMs: end - start,
      durationMs: end - job.createdAtEpochMs, errorCode: null, errorSummary: null, leaseUntil: 0,
      resultSummary: { scored: results.length, flagged, byLevel, casesCreated, scoringVersion: results[0] ? results[0].scoringVersion : null },
    });
    Object.assign(job.attempts[job.attempts.length - 1], { outcome: 'SUCCEEDED', endedAt: completedIso });
    job.version += 1;
  }

  recordFailure(jobId, err, receiveCount) {
    const job = this.state.jobs[jobId];
    if (!job || job.jobStatus !== 'PROCESSING') return job ? job.jobStatus : null;
    const ts = nowIso();
    const cycle = job.attemptCount - (job.attemptBase || 0);
    let status = 'RETRY_SCHEDULED';
    if (err instanceof PermanentJobError) status = 'FAILED';
    else if (cycle >= MAX_ATTEMPTS) status = 'DEAD_LETTERED';
    Object.assign(job, { jobStatus: status, errorCode: err.code, errorSummary: String(err.message).slice(0, 300), updatedAt: ts, leaseUntil: 0 });
    Object.assign(job.attempts[job.attempts.length - 1], { outcome: 'FAILED', endedAt: ts, errorCode: err.code });
    job.version += 1;
    const action = { FAILED: 'JOB_FAILED', DEAD_LETTERED: 'JOB_DEAD_LETTERED', RETRY_SCHEDULED: 'JOB_ATTEMPT_FAILED' }[status];
    this.audit('JOB#' + jobId, action, 'system:worker', {
      key: 'job-failure:' + jobId + ':' + job.attemptCount, datasetId: job.datasetId, jobId,
      metadata: { attempt: job.attemptCount, attemptInCycle: cycle, maxAttempts: MAX_ATTEMPTS, receiveCount, errorCode: err.code },
    });
    return status;
  }

  // ------------------------------------------------------------ cases
  createCase(creator, datasetId, recordId, result, origin, jobId) {
    const caseId = caseIdFor(datasetId, recordId);
    if (this.state.cases[caseId]) return false;
    const ts = nowIso();
    this.state.cases[caseId] = {
      caseId, datasetId, recordId, caseStatus: 'NEW', origin,
      priority: result && result.riskLevel === 'HIGH' ? 'HIGH' : 'NORMAL',
      riskScoreAtOpen: result ? result.score : null, riskLevelAtOpen: result ? result.riskLevel : null,
      assignedActor: null, createdAt: ts, updatedAt: ts, createdBy: creator, resolutionReason: null,
      commentCount: 0, archived: false, version: 1,
    };
    this.audit('CASE#' + caseId, 'CASE_CREATED', creator, {
      key: 'case-created:' + caseId, caseId, recordId, datasetId, jobId,
      metadata: { origin, riskScore: result ? result.score : null, riskLevel: result ? result.riskLevel : null },
    });
    return true;
  }

  async listCases(datasetId, { includeArchived = false } = {}) {
    return clone(Object.values(this.state.cases)
      .filter((c) => (!datasetId || c.datasetId === datasetId) && (includeArchived || !c.archived))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
  }

  async openCase(datasetId, recordId) {
    this.require('analyst');
    const rec = (this.state.records[datasetId] || {})[recordId];
    if (!rec) throw new ApiError(404, 'UNKNOWN_RECORD', 'Record not found in this dataset.');
    const result = rec.riskScore !== undefined && rec.riskScore !== null ? { score: rec.riskScore, riskLevel: rec.riskLevel } : null;
    const created = this.createCase(this.actor().sub, datasetId, recordId, result, 'MANUAL');
    this.save();
    return { case: clone(this.state.cases[caseIdFor(datasetId, recordId)]), created };
  }

  async getCase(caseId) {
    const c = this.state.cases[caseId];
    if (!c) throw new ApiError(404, 'NOT_FOUND', 'Case not found.');
    const history = this.state.audit.filter((e) => e.streamId === 'CASE#' + caseId)
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    const rec = (this.state.records[c.datasetId] || {})[c.recordId] || null;
    return { case: clone(c), history: clone(history), record: clone(rec) };
  }

  guardCase(caseId, expectedVersion) {
    const c = this.state.cases[caseId];
    if (!c) throw new ApiError(404, 'NOT_FOUND', 'Case not found.');
    if (c.archived) throw new ApiError(409, 'CASE_ARCHIVED', 'Archived cases are read-only.');
    if (c.version !== expectedVersion) {
      throw new ApiError(409, 'VERSION_CONFLICT', 'The case was changed by someone else. Reload and retry.', { currentVersion: c.version });
    }
    return c;
  }

  async transitionCase(caseId, toStatus, reason, expectedVersion) {
    this.require('analyst');
    const c = this.guardCase(caseId, expectedVersion);
    let text;
    try {
      text = checkTransition(c.caseStatus, toStatus, reason);
    } catch (e) {
      if (e instanceof TransitionError) throw new ApiError(e.code === 'INVALID_TRANSITION' ? 409 : 400, e.code, e.message);
      throw e;
    }
    const from = c.caseStatus;
    const ts = nowIso();
    Object.assign(c, { caseStatus: toStatus, updatedAt: ts, assignedActor: this.actor().sub });
    if (CLOSED.includes(toStatus)) Object.assign(c, { resolutionReason: text, closedAt: ts });
    else if (CLOSED.includes(from)) Object.assign(c, { resolutionReason: null, reopenReason: text });
    c.version = expectedVersion + 1;
    this.audit('CASE#' + caseId, 'CASE_STATUS_CHANGED', this.actor().sub, {
      key: 'case-status:' + caseId + ':v' + expectedVersion, caseId, recordId: c.recordId, datasetId: c.datasetId,
      metadata: { from, to: toStatus, reason: text || null, version: c.version },
    });
    this.save();
    return clone(c);
  }

  async addComment(caseId, text, expectedVersion) {
    this.require('analyst');
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) throw new ApiError(400, 'VALIDATION_ERROR', 'Comment text is required.');
    if (body.length > MAX_COMMENT) throw new ApiError(400, 'VALIDATION_ERROR', 'Comments are limited to 1000 characters.');
    const c = this.guardCase(caseId, expectedVersion);
    c.commentCount = (c.commentCount || 0) + 1;
    c.updatedAt = nowIso();
    c.version = expectedVersion + 1;
    this.audit('CASE#' + caseId, 'CASE_COMMENT_ADDED', this.actor().sub, {
      key: 'case-comment:' + caseId + ':v' + expectedVersion, caseId, recordId: c.recordId, datasetId: c.datasetId,
      metadata: { text: body },
    });
    this.save();
    return clone(c);
  }

  // ------------------------------------------------------------ metrics, evaluation, audit
  async getMetrics(datasetId) {
    const recs = datasetId && this.state.records[datasetId] ? this.withLive(datasetId, Object.values(this.state.records[datasetId])) : [];
    const jobs = Object.values(this.state.jobs).filter((j) => !datasetId || j.datasetId === datasetId);
    const cases = Object.values(this.state.cases).filter((c) => !c.archived && (!datasetId || c.datasetId === datasetId));
    const dist = { NONE: 0, LOW: 0, MEDIUM: 0, HIGH: 0 };
    let processed = 0;
    let flagged = 0;
    for (const r of recs) {
      if (r.riskLevel in dist && r.processingStatus === 'PROCESSED') dist[r.riskLevel] += 1;
      if (r.riskScore !== undefined && r.riskScore !== null) {
        processed += 1;
        if (r.flagged) flagged += 1;
      }
    }
    const finished = jobs.filter((j) => TERMINAL.includes(j.jobStatus));
    const ok = finished.filter((j) => j.jobStatus === 'SUCCEEDED').length;
    return {
      datasetId,
      totalRecords: recs.length,
      processedRecords: processed,
      flaggedRecords: flagged,
      pendingJobs: jobs.filter((j) => ACTIVE.includes(j.jobStatus)).length,
      riskDistribution: dist,
      highPriorityCases: cases.filter((c) => c.priority === 'HIGH' && !CLOSED.includes(c.caseStatus)).length,
      casesAwaitingReview: cases.filter((c) => ['NEW', 'UNDER_REVIEW', 'ESCALATED'].includes(c.caseStatus)).length,
      casesResolved: cases.filter((c) => c.caseStatus === 'RESOLVED').length,
      casesDismissed: cases.filter((c) => c.caseStatus === 'DISMISSED').length,
      failedJobs: jobs.filter((j) => ['FAILED', 'DEAD_LETTERED'].includes(j.jobStatus)).length,
      failedAttempts: jobs.reduce((n, j) => n + j.attempts.filter((a) => a.outcome === 'FAILED').length, 0),
      jobSuccessRate: finished.length ? ok / finished.length : null,
      finishedJobs: finished.length,
    };
  }

  async getEvaluation(datasetId) {
    const recs = Object.values(this.state.records[datasetId] || {});
    const scored = recs.filter((r) => r.riskScore !== undefined && r.riskScore !== null)
      .map((r) => ({ recordId: r.recordId, flagged: Boolean(r.flagged) }));
    const ev = evaluate(scored, this.state.labels[datasetId] || []);
    ev.unscoredRecords = recs.length - scored.length;
    ev.profilesInStoredScores = [...new Set(recs.map((r) => r.scoringProfile).filter(Boolean))].sort();
    return ev;
  }

  async listAudit({ stream, limit = 200 } = {}) {
    const events = this.state.audit.filter((e) => !stream || e.streamId === stream)
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    return { events: clone(events.slice(0, Math.max(1, Math.min(limit, 500)))), total: events.length };
  }
}

export { datasetIdFor };
