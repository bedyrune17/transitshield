// Amazon Cognito sign-in for a static site:
//  * Authorization Code grant with PKCE (S256) against the Cognito domain.
//    The app client is public: no client secret exists or is embedded.
//  * The ID token is exchanged with the Cognito *identity pool* for
//    short-lived AWS credentials limited to invoking the API Function URL.
//  * The ACCESS token is sent to the API, which verifies it server-side.
// Tokens live in sessionStorage (cleared when the tab closes).

import { ApiError } from '../data/errors.js';

const SS = {
  tokens: 'transitshield.tokens',
  pkce: 'transitshield.pkce',
};

function ssGet(k) {
  try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; }
}
function ssSet(k, v) {
  try {
    if (v === null) sessionStorage.removeItem(k);
    else sessionStorage.setItem(k, JSON.stringify(v));
  } catch (e) { /* storage blocked: session lasts for this page only */ }
}

function b64url(bytes) {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n = 48) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}
async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}
function decodeJwt(token) {
  // Used ONLY to read expiry/display name in the UI. The server never trusts this.
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  } catch (e) {
    return {};
  }
}

export function redirectUri() {
  let path = window.location.pathname;
  if (path.endsWith('index.html')) path = path.slice(0, -'index.html'.length);
  return window.location.origin + path;
}

export class CognitoAuth {
  constructor(config) {
    this.cfg = config;
    this.memTokens = null;
    this.creds = null;
  }

  configured() {
    const c = this.cfg;
    return Boolean(c && c.region && c.userPoolId && c.userPoolClientId && c.identityPoolId && c.cognitoDomain && c.apiUrl);
  }

  tokens() { return this.memTokens || ssGet(SS.tokens); }

  setTokens(t) {
    this.memTokens = t;
    ssSet(SS.tokens, t);
  }

  isSignedIn() {
    const t = this.tokens();
    return Boolean(t && t.refreshToken);
  }

  profile() {
    const t = this.tokens();
    if (!t) return null;
    const c = decodeJwt(t.idToken);
    return { email: c.email, username: c['cognito:username'] || c.sub, groups: c['cognito:groups'] || [] };
  }

  domainUrl(path) {
    const d = this.cfg.cognitoDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return 'https://' + d + path;
  }

  async signIn() {
    const verifier = randomString(48);
    const state = randomString(16);
    ssSet(SS.pkce, { verifier, state, returnHash: window.location.hash || '#/overview' });
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.userPoolClientId,
      redirect_uri: redirectUri(),
      scope: 'openid email',
      state,
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier),
    });
    window.location.assign(this.domainUrl('/oauth2/authorize?' + q.toString()));
  }

  /** Handles ?code=&state= on return from Cognito. Returns true if a login completed. */
  async handleRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const err = params.get('error');
    if (!code && !err) return false;
    const pkce = ssGet(SS.pkce);
    ssSet(SS.pkce, null);
    const cleanUrl = redirectUri() + ((pkce && pkce.returnHash) || '#/overview');
    window.history.replaceState(null, '', cleanUrl);
    if (err) throw new ApiError(401, 'SIGN_IN_FAILED', 'Sign-in was cancelled or failed (' + err + ').');
    if (!pkce || params.get('state') !== pkce.state) {
      throw new ApiError(401, 'STATE_MISMATCH', 'Sign-in response did not match this browser session; please sign in again.');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.cfg.userPoolClientId,
      code,
      redirect_uri: redirectUri(),
      code_verifier: pkce.verifier,
    });
    const tok = await this.tokenRequest(body);
    this.setTokens({ idToken: tok.id_token, accessToken: tok.access_token, refreshToken: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in - 60) * 1000 });
    this.creds = null;
    return true;
  }

  async tokenRequest(body) {
    let res;
    try {
      res = await fetch(this.domainUrl('/oauth2/token'), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      });
    } catch (e) {
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the Cognito sign-in service.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(401, 'TOKEN_EXCHANGE_FAILED', 'Cognito rejected the sign-in (' + (data.error || res.status) + ').');
    return data;
  }

  async refresh() {
    const t = this.tokens();
    if (!t || !t.refreshToken) throw new ApiError(401, 'NOT_SIGNED_IN', 'Please sign in to use AWS mode.');
    const tok = await this.tokenRequest(new URLSearchParams({
      grant_type: 'refresh_token', client_id: this.cfg.userPoolClientId, refresh_token: t.refreshToken,
    }));
    this.setTokens({ ...t, idToken: tok.id_token, accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 60) * 1000 });
    this.creds = null;
  }

  async accessToken() {
    const t = this.tokens();
    if (!t) throw new ApiError(401, 'NOT_SIGNED_IN', 'Please sign in to use AWS mode.');
    if (Date.now() >= t.expiresAt) await this.refresh();
    return this.tokens().accessToken;
  }

  async identityCall(target, payload) {
    let res;
    try {
      res = await fetch('https://cognito-identity.' + this.cfg.region + '.amazonaws.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityService.' + target },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the Cognito identity service.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, 'IDENTITY_POOL_ERROR', 'Could not obtain AWS credentials (' + (data.__type || res.status) + ').');
    return data;
  }

  async awsCredentials() {
    if (this.creds && Date.now() < this.creds.expiresAt) return this.creds;
    await this.accessToken(); // refreshes tokens if needed
    const t = this.tokens();
    const logins = { ['cognito-idp.' + this.cfg.region + '.amazonaws.com/' + this.cfg.userPoolId]: t.idToken };
    const { IdentityId } = await this.identityCall('GetId', { IdentityPoolId: this.cfg.identityPoolId, Logins: logins });
    const { Credentials } = await this.identityCall('GetCredentialsForIdentity', { IdentityId, Logins: logins });
    this.creds = {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretKey,
      sessionToken: Credentials.SessionToken,
      expiresAt: Credentials.Expiration * 1000 - 60000,
    };
    return this.creds;
  }

  invalidateCredentials() { this.creds = null; }

  signOut() {
    this.setTokens(null);
    this.creds = null;
    const q = new URLSearchParams({ client_id: this.cfg.userPoolClientId, logout_uri: redirectUri() });
    window.location.assign(this.domainUrl('/logout?' + q.toString()));
  }

  clearLocalSession() {
    this.setTokens(null);
    this.creds = null;
  }
}
