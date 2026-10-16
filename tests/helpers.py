"""Shared test helpers.

* Puts ``backend/`` on sys.path so ``shared``, ``api`` and ``worker`` import.
* Generates a throwaway RSA key pair at test time (no private key is ever
  committed) and signs Cognito-shaped JWTs with it, so token verification is
  tested with real RSA signatures rather than mocked out.
"""

import base64
import hashlib
import json
import os
import secrets
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, "backend")
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

os.environ.setdefault("LOG_LEVEL", "ERROR")
os.environ.setdefault("EMF_ENABLED", "false")

REGION = "ap-south-1"
POOL_ID = "ap-south-1_TESTPOOL"
CLIENT_ID = "testclientid123"
ISSUER = "https://cognito-idp." + REGION + ".amazonaws.com/" + POOL_ID


def _is_probable_prime(n, rounds=24):
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits):
    while True:
        c = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if _is_probable_prime(c):
            return c


def make_rsa_key(bits=1024):
    e = 65537
    while True:
        p, q = _prime(bits // 2), _prime(bits // 2)
        if p == q:
            continue
        phi = (p - 1) * (q - 1)
        try:
            d = pow(e, -1, phi)
        except ValueError:
            continue
        return {"n": p * q, "e": e, "d": d}


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _int_b64(n: int) -> str:
    return _b64(n.to_bytes((n.bit_length() + 7) // 8, "big"))


def jwk_for(key, kid):
    return {"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig", "n": _int_b64(key["n"]), "e": _int_b64(key["e"])}


def sign_jwt(key, kid, claims, alg="RS256"):
    header = {"alg": alg, "kid": kid, "typ": "JWT"}
    signing_input = (_b64(json.dumps(header).encode()) + "." + _b64(json.dumps(claims).encode())).encode()
    k = (key["n"].bit_length() + 7) // 8
    digest_info = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(signing_input).digest()
    em = b"\x00\x01" + b"\xff" * (k - len(digest_info) - 3) + b"\x00" + digest_info
    sig = pow(int.from_bytes(em, "big"), key["d"], key["n"]).to_bytes(k, "big")
    return signing_input.decode() + "." + _b64(sig)


def access_claims(sub="user-1", groups=("analysts",), **overrides):
    now = int(time.time())
    claims = {
        "sub": sub,
        "iss": ISSUER,
        "client_id": CLIENT_ID,
        "token_use": "access",
        "scope": "openid email",
        "auth_time": now,
        "iat": now,
        "exp": now + 3600,
        "username": sub,
        "cognito:groups": list(groups),
    }
    claims.update(overrides)
    return claims


_KEY = None


def test_key():
    global _KEY
    if _KEY is None:
        _KEY = make_rsa_key()
    return _KEY


class FakeQueue:
    def __init__(self, fail=False):
        self.messages = []
        self.fail = fail

    def send(self, body):
        if self.fail:
            raise RuntimeError("queue down")
        self.messages.append(body)


class FakeDlq(FakeQueue):
    def remove_job_messages(self, job_id):
        before = len(self.messages)
        self.messages = [m for m in self.messages if m.get("jobId") != job_id]
        return before - len(self.messages)
