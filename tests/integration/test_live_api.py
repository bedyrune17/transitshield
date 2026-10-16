"""Integration tests against the DEPLOYED API (opt-in).

Run:   set TS_INTEGRATION=1   (PowerShell: $env:TS_INTEGRATION=1)
       python -m unittest tests.integration.test_live_api -v

What they prove on real AWS:
  * Unsigned requests are rejected by AWS IAM (403) before the function runs.
  * CORS preflight answers only the configured origins.
  * A correctly SigV4-signed request still fails (401) unless it carries a
    valid Cognito access token: missing, malformed, alg=none, unknown key and
    forged tokens are all rejected by the function, which fetches the real
    JWKS from Cognito.
The signing credentials are the developer's current AWS CLI credentials,
obtained with `aws configure export-credentials` and kept in memory only
(never printed or written). A full signed-in user flow is exercised in the
browser (see docs/TESTING.md).
"""

import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENABLED = os.environ.get("TS_INTEGRATION") == "1"


def _config():
    with open(os.path.join(ROOT, "frontend", "js", "config.js"), encoding="utf-8") as fh:
        text = fh.read()
    return dict(re.findall(r'(\w+): "([^"]*)"', text))


def _cli_credentials():
    exe = shutil.which("aws")
    out = subprocess.run([exe, "configure", "export-credentials", "--format", "process"], capture_output=True,
                         text=True, check=True).stdout
    data = json.loads(out)
    return data["AccessKeyId"], data["SecretAccessKey"], data.get("SessionToken")


def _sign(method, url, region, creds, body=b""):
    akid, secret, token = creds
    u = urllib.parse.urlsplit(url)
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = amz_date[:8]
    payload_hash = hashlib.sha256(body).hexdigest()
    headers = {"host": u.netloc, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
    if token:
        headers["x-amz-security-token"] = token
    signed = sorted(headers)
    canonical = "\n".join([method, u.path or "/", u.query, "".join(k + ":" + headers[k] + "\n" for k in signed),
                           ";".join(signed), payload_hash])
    scope = "/".join([date, region, "lambda", "aws4_request"])
    sts = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = ("AWS4" + secret).encode()
    for part in (date, region, "lambda", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(key, sts.encode(), hashlib.sha256).hexdigest()
    out = {"Authorization": "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s"
           % (akid, scope, ";".join(signed), sig),
           "X-Amz-Date": amz_date, "X-Amz-Content-Sha256": payload_hash}
    if token:
        out["X-Amz-Security-Token"] = token
    return out


def _request(method, url, headers=None, body=None):
    req = urllib.request.Request(url, method=method, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, dict(resp.headers), resp.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read().decode()


def _b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


import urllib.parse  # noqa: E402  (used by _sign)


@unittest.skipUnless(ENABLED, "set TS_INTEGRATION=1 to run against the deployed stack")
class LiveApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = _config()
        cls.api = cls.cfg["apiUrl"].rstrip("/")
        cls.region = cls.cfg["region"]
        cls.creds = _cli_credentials()

    def signed(self, path, token=None):
        url = self.api + path
        headers = _sign("GET", url, self.region, self.creds)
        if token is not None:
            headers["X-TransitShield-Token"] = token
        return _request("GET", url, headers)

    def test_unsigned_requests_rejected_by_iam(self):
        for path in ("/me", "/datasets", "/health"):
            status, _, body = _request("GET", self.api + path, {"X-TransitShield-Token": "Bearer x.y.z"})
            self.assertEqual(status, 403, path)
            self.assertIn("Forbidden", body)

    def test_cors_preflight_only_for_known_origins(self):
        hdrs = {"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,x-transitshield-token"}
        status, h, _ = _request("OPTIONS", self.api + "/jobs", hdrs)
        self.assertEqual(status, 200)
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "http://localhost:5173")
        status, h, _ = _request("OPTIONS", self.api + "/jobs", dict(hdrs, Origin="https://evil.example"))
        self.assertNotIn("Access-Control-Allow-Origin", h)

    def test_signed_but_tokenless_requests_rejected_by_function(self):
        status, _, body = self.signed("/me")
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(body)["error"]["code"], "MALFORMED_TOKEN")

    def test_forged_and_malformed_tokens_rejected(self):
        pool = self.cfg["userPoolId"]
        claims = {"sub": "attacker", "iss": "https://cognito-idp.%s.amazonaws.com/%s" % (self.region, pool),
                  "client_id": self.cfg["userPoolClientId"], "token_use": "access", "exp": 4102444800,
                  "cognito:groups": ["admins"]}
        cases = {
            "not-a-jwt": "MALFORMED_TOKEN",
            _b64({"alg": "none", "kid": "x"}) + "." + _b64(claims) + ".": "UNSUPPORTED_ALG",
            _b64({"alg": "RS256", "kid": "made-up-kid"}) + "." + _b64(claims) + "." + _b64("sig"): "UNKNOWN_KEY",
        }
        for token, code in cases.items():
            with self.subTest(code=code):
                status, _, body = self.signed("/datasets", token)
                self.assertEqual(status, 401)
                self.assertEqual(json.loads(body)["error"]["code"], code)

    def test_real_kid_with_forged_signature_rejected(self):
        status, _, jwks = _request("GET", "https://cognito-idp.%s.amazonaws.com/%s/.well-known/jwks.json"
                                   % (self.region, self.cfg["userPoolId"]))
        self.assertEqual(status, 200)
        kid = json.loads(jwks)["keys"][0]["kid"]
        claims = {"sub": "attacker", "iss": "https://cognito-idp.%s.amazonaws.com/%s" % (self.region, self.cfg["userPoolId"]),
                  "client_id": self.cfg["userPoolClientId"], "token_use": "access", "exp": 4102444800,
                  "cognito:groups": ["admins"]}
        token = _b64({"alg": "RS256", "kid": kid}) + "." + _b64(claims) + "." + _b64("x" * 256)
        status, _, body = self.signed("/datasets", token)
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(body)["error"]["code"], "BAD_SIGNATURE")


if __name__ == "__main__":
    unittest.main()
