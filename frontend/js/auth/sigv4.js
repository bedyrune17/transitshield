// AWS Signature Version 4 request signing with WebCrypto (no SDK).
// Used to call the Lambda Function URL whose AuthType is AWS_IAM, with the
// short-lived credentials issued to the signed-in user by the Cognito
// identity pool. No long-lived keys ever reach the browser.

const enc = new TextEncoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data) {
  return toHex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

export function rfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function canonicalUri(pathname) {
  if (!pathname || pathname === '/') return '/';
  // Non-S3 services: each segment URI-encoded twice (segments arrive already encoded once from URL).
  return pathname.split('/').map((seg) => rfc3986(decodeURIComponent(seg))).map((seg) => rfc3986(seg)).join('/');
}

function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [k, v] of searchParams.entries()) pairs.push([rfc3986(k), rfc3986(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => k + '=' + v).join('&');
}

export async function signRequest({ method, url, body = '', region, service, credentials, now = new Date(), signContentHash = true }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body || '');
  const headers = { host: u.host, 'x-amz-date': amzDate };
  if (signContentHash) headers['x-amz-content-sha256'] = payloadHash;
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((k) => k + ':' + String(headers[k]).trim() + '\n').join('');
  const canonicalRequest = [method.toUpperCase(), canonicalUri(u.pathname), canonicalQuery(u.searchParams),
    canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');
  const scope = date + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  let key = await hmac('AWS4' + credentials.secretAccessKey, date);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, 'aws4_request');
  const signature = toHex(await hmac(key, stringToSign));
  const out = {
    Authorization: 'AWS4-HMAC-SHA256 Credential=' + credentials.accessKeyId + '/' + scope
      + ', SignedHeaders=' + signedHeaders.join(';') + ', Signature=' + signature,
    'X-Amz-Date': amzDate,
  };
  if (signContentHash) out['X-Amz-Content-Sha256'] = payloadHash;
  if (credentials.sessionToken) out['X-Amz-Security-Token'] = credentials.sessionToken;
  return out;
}
