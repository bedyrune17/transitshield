// Frontend unit tests (node --test tests/js/). No browser or AWS needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { signRequest } from '../../frontend/js/auth/sigv4.js';
import { LocalProvider } from '../../frontend/js/data/localProvider.js';
import { checkTransition, TransitionError } from '../../frontend/js/core/cases.js';

const rules = JSON.parse(readFileSync(new URL('../../frontend/data/risk_rules.json', import.meta.url), 'utf-8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('SigV4 signer matches the AWS test-suite "get-vanilla" vector', async () => {
  const headers = await signRequest({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    region: 'us-east-1',
    service: 'service',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    now: new Date('2015-08-30T12:36:00Z'),
    signContentHash: false,
  });
  assert.equal(headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, '
    + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(headers['X-Amz-Date'], '20150830T123600Z');
});

test('SigV4 signer includes the session token and payload hash', async () => {
  const headers = await signRequest({
    method: 'POST',
    url: 'https://abc.lambda-url.ap-south-1.on.aws/jobs?datasetId=ds-x',
    body: '{"a":1}',
    region: 'ap-south-1',
    service: 'lambda',
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'TOKEN' },
    now: new Date('2026-10-16T00:00:00Z'),
  });
  assert.match(headers.Authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token/);
  assert.equal(headers['X-Amz-Security-Token'], 'TOKEN');
  assert.equal(headers['X-Amz-Content-Sha256'].length, 64);
});

test('case state machine mirrors the backend', () => {
  assert.equal(checkTransition('NEW', 'UNDER_REVIEW', null), '');
  assert.throws(() => checkTransition('NEW', 'RESOLVED', 'reason here'), TransitionError);
  assert.throws(() => checkTransition('UNDER_REVIEW', 'DISMISSED', 'no'), /reason/);
});

async function until(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(20);
  }
  throw new Error('condition not met in time');
}

test('local provider: seed, process, idempotent case creation, metrics', async () => {
  const p = new LocalProvider(rules, { latencyMs: 5, backoffMs: [20, 20, 20], tickMs: 10 });
  try {
    const { dataset, created } = await p.seedDataset({ scenario: 'mixed', seed: 42, count: 100 });
    assert.equal(created, true);
    assert.equal((await p.seedDataset({ scenario: 'mixed', seed: 42, count: 100 })).created, false);
    const job = await p.submitJob({ datasetId: dataset.datasetId });
    assert.equal(job.jobStatus, 'QUEUED');
    await until(async () => (await p.getJob(job.jobId)).jobStatus === 'SUCCEEDED');
    const m = await p.getMetrics(dataset.datasetId);
    assert.equal(m.processedRecords, dataset.recordCount);
    const recs = await p.listRecords(dataset.datasetId);
    assert.equal(m.flaggedRecords, recs.filter((r) => r.flagged).length);
    const highs = recs.filter((r) => r.riskLevel === 'HIGH').length;
    assert.equal((await p.listCases(dataset.datasetId)).length, highs);
    const ev = await p.getEvaluation(dataset.datasetId);
    assert.equal(ev.truePositives + ev.falseNegatives, dataset.anomalousRecordCount);
  } finally {
    p.destroy();
  }
});

test('local provider: permanent failure dead-letters, recovery succeeds', async () => {
  const p = new LocalProvider(rules, { latencyMs: 5, backoffMs: [20, 20, 20], tickMs: 10 });
  try {
    const { dataset } = await p.seedDataset({ scenario: 'normal', seed: 1, count: 20 });
    const job = await p.submitJob({ datasetId: dataset.datasetId, recordIds: ['SHP-0001'], failureMode: 'permanent' });
    await until(async () => (await p.getJob(job.jobId)).jobStatus === 'DEAD_LETTERED');
    assert.equal((await p.getOps()).deadLetterQueue.visible, 1);
    assert.equal((await p.getJob(job.jobId)).attemptCount, 3);
    await p.recoverJob(job.jobId);
    await until(async () => (await p.getJob(job.jobId)).jobStatus === 'SUCCEEDED');
    assert.equal((await p.getOps()).deadLetterQueue.visible, 0);
  } finally {
    p.destroy();
  }
});

test('local provider: optimistic locking and role enforcement', async () => {
  const p = new LocalProvider(rules, { latencyMs: 5, tickMs: 10 });
  try {
    const { dataset } = await p.seedDataset({ scenario: 'normal', seed: 2, count: 20 });
    const { case: c } = await p.openCase(dataset.datasetId, 'SHP-0001');
    await p.transitionCase(c.caseId, 'UNDER_REVIEW', null, 1);
    await assert.rejects(() => p.addComment(c.caseId, 'stale', 1), (e) => e.status === 409 && e.code === 'VERSION_CONFLICT');
    await p.setRole('viewer');
    await assert.rejects(() => p.addComment(c.caseId, 'hello', 2), (e) => e.status === 403);
    await assert.rejects(() => p.resetDataset(dataset.datasetId), (e) => e.status === 403);
  } finally {
    p.destroy();
  }
});
