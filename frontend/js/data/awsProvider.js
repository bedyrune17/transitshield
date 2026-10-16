// AWS provider: same interface as LocalProvider, backed by the deployed API.
// Every call is SigV4-signed (Function URL AuthType=AWS_IAM) and carries the
// Cognito access token, which the API verifies. Failures surface as
// ApiError - this provider NEVER falls back to local data.

import { signRequest } from '../auth/sigv4.js';
import { ApiError } from './errors.js';

export class AwsProvider {
  constructor(config, auth) {
    this.mode = 'aws';
    this.isLive = true;
    this.cfg = config;
    this.auth = auth;
    this.base = config.apiUrl.endsWith('/') ? config.apiUrl : config.apiUrl + '/';
  }

  onChange() { return () => {}; }

  destroy() {}

  async request(method, path, { body, query } = {}, retried = false) {
    const url = new URL(path.replace(/^\//, ''), this.base);
    if (query) Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
    const payload = body === undefined ? '' : JSON.stringify(body);
    const token = await this.auth.accessToken();
    // AWS_IAM (default): sign with the identity pool's short-lived credentials so AWS
    // authenticates the caller before the function runs. NONE: token-only fallback.
    const signed = this.cfg.apiAuthType === 'NONE' ? {}
      : await signRequest({ method, url: url.toString(), body: payload, region: this.cfg.region, service: 'lambda', credentials: await this.auth.awsCredentials() });
    let res;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: { ...signed, 'Content-Type': 'application/json', 'X-TransitShield-Token': token },
        body: payload || undefined,
        cache: 'no-store',
      });
    } catch (e) {
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the TransitShield API. Check your connection or the API URL in config.js.');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.ok) return data;
    if (!retried && res.status === 401 && data && data.error && data.error.code === 'TOKEN_EXPIRED') {
      await this.auth.refresh();
      return this.request(method, path, { body, query }, true);
    }
    if (!retried && res.status === 403 && data && data.Message) {
      // Rejected by AWS IAM before reaching the function (e.g. expired temporary credentials).
      this.auth.invalidateCredentials();
      return this.request(method, path, { body, query }, true);
    }
    if (data && data.error) throw new ApiError(res.status, data.error.code, data.error.message, data.error.details);
    if (res.status === 403) throw new ApiError(403, 'IAM_FORBIDDEN', 'AWS rejected the request signature or permissions.');
    throw new ApiError(res.status, 'HTTP_' + res.status, 'Unexpected response from the API.');
  }

  async getIdentity() {
    const { actor } = await this.request('GET', '/me');
    return actor;
  }
  async getConfig() { return this.request('GET', '/config'); }
  async listDatasets() { return (await this.request('GET', '/datasets')).datasets; }
  async seedDataset(params) { return this.request('POST', '/datasets', { body: params }); }
  async getDataset(id) { return (await this.request('GET', '/datasets/' + id)).dataset; }
  async resetDataset(id) { return (await this.request('DELETE', '/datasets/' + id)).reset; }
  async listRecords(datasetId) { return (await this.request('GET', '/datasets/' + datasetId + '/records')).records; }
  async getRecord(datasetId, recordId) { return this.request('GET', '/datasets/' + datasetId + '/records/' + recordId); }
  async getLabels(datasetId) { return (await this.request('GET', '/datasets/' + datasetId + '/labels')).labels; }
  async getMetrics(datasetId) { return (await this.request('GET', '/datasets/' + datasetId + '/metrics')).metrics; }
  async getEvaluation(datasetId) { return (await this.request('GET', '/datasets/' + datasetId + '/evaluation')).evaluation; }
  async listJobs(datasetId) { return (await this.request('GET', '/jobs', { query: { datasetId } })).jobs; }
  async getJob(jobId) { return (await this.request('GET', '/jobs/' + jobId)).job; }
  async submitJob(params) {
    const body = { datasetId: params.datasetId };
    if (params.recordIds) body.recordIds = params.recordIds;
    if (params.failureMode && params.failureMode !== 'none') body.failureMode = params.failureMode;
    if (params.profile) body.profile = params.profile;
    return (await this.request('POST', '/jobs', { body })).job;
  }
  async recoverJob(jobId) { return (await this.request('POST', '/jobs/' + jobId + '/recover', { body: {} })).job; }
  async getOps() { return (await this.request('GET', '/ops')).ops; }
  async listCases(datasetId) { return (await this.request('GET', '/cases', { query: { datasetId } })).cases; }
  async openCase(datasetId, recordId) { return this.request('POST', '/cases', { body: { datasetId, recordId } }); }
  async getCase(caseId) { return this.request('GET', '/cases/' + caseId); }
  async transitionCase(caseId, toStatus, reason, expectedVersion) {
    const body = { toStatus, expectedVersion };
    if (reason) body.reason = reason;
    return (await this.request('POST', '/cases/' + caseId + '/transition', { body })).case;
  }
  async addComment(caseId, text, expectedVersion) {
    return (await this.request('POST', '/cases/' + caseId + '/comments', { body: { text, expectedVersion } })).case;
  }
  async listAudit({ stream, limit = 200 } = {}) { return this.request('GET', '/audit', { query: { stream, limit } }); }
}
