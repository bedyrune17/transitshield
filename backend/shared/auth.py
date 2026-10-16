"""Server-side verification of Amazon Cognito access tokens (RS256).

Implemented with the standard library only, so the Lambda deployment package
needs no third-party crypto dependency. Checks performed, in order:

1. Structure: three base64url segments, JSON header and payload.
2. Header: ``alg`` must be RS256 and ``kid`` must be in the pool's JWKS.
3. Signature: RSASSA-PKCS1-v1_5 with SHA-256 against the JWKS public key.
4. Claims: ``iss`` equals the user pool issuer, ``token_use`` == "access",
   ``client_id`` equals the expected app client, ``exp`` in the future,
   ``iat`` not in the future (with small clock-skew allowance).

A decoded-but-unverified JWT is never trusted.
"""

import base64
import hashlib
import hmac
import json
import time
import urllib.request

# DER prefix of DigestInfo for SHA-256 (RFC 8017, section 9.2 note 1)
_SHA256_DIGESTINFO = bytes.fromhex("3031300d060960864801650304020105000420")
_CLOCK_SKEW = 60
_JWKS_TTL = 3600
_JWKS_MIN_REFRESH = 60

_jwks_cache = {"keys": None, "fetched": 0, "url": None}


class AuthError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def b64url_decode(segment: str) -> bytes:
    if not isinstance(segment, str) or not segment:
        raise AuthError("MALFORMED_TOKEN", "Token segment is empty.")
    pad = "=" * (-len(segment) % 4)
    try:
        return base64.urlsafe_b64decode(segment + pad)
    except Exception:
        raise AuthError("MALFORMED_TOKEN", "Token segment is not valid base64url.")


def _int_from_b64(segment: str) -> int:
    return int.from_bytes(b64url_decode(segment), "big")


def rsa_pkcs1_sha256_verify(message: bytes, signature: bytes, n: int, e: int) -> bool:
    k = (n.bit_length() + 7) // 8
    if len(signature) != k:
        return False
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    em = pow(s, e, n).to_bytes(k, "big")
    t = _SHA256_DIGESTINFO + hashlib.sha256(message).digest()
    if k < len(t) + 11:
        return False
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return hmac.compare_digest(em, expected)


def fetch_jwks(url: str, timeout: float = 3.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "transitshield-api"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec - fixed AWS URL from config
        data = json.loads(resp.read().decode("utf-8"))
    return {k["kid"]: k for k in data.get("keys", []) if k.get("kty") == "RSA" and k.get("kid")}


def _get_key(kid: str, jwks_url: str, fetcher):
    now = time.time()
    cache = _jwks_cache
    stale = cache["keys"] is None or cache["url"] != jwks_url or now - cache["fetched"] > _JWKS_TTL
    if stale or (kid not in cache["keys"] and now - cache["fetched"] > _JWKS_MIN_REFRESH):
        try:
            cache["keys"] = fetcher(jwks_url)
            cache["fetched"] = now
            cache["url"] = jwks_url
        except Exception:
            if cache["keys"] is None or cache["url"] != jwks_url:
                raise AuthError("JWKS_UNAVAILABLE", "Unable to load signing keys.")
    return (cache["keys"] or {}).get(kid)


def reset_jwks_cache():
    _jwks_cache.update({"keys": None, "fetched": 0, "url": None})


def verify_access_token(token: str, *, region: str, user_pool_id: str, client_id: str,
                        now: float = None, jwks: dict = None, fetcher=fetch_jwks) -> dict:
    """Verify a Cognito access token and return the actor identity.

    ``jwks`` (kid -> JWK) may be injected for tests; otherwise keys are
    fetched from the pool's well-known URL and cached.
    """
    if not isinstance(token, str) or token.count(".") != 2 or len(token) > 8192:
        raise AuthError("MALFORMED_TOKEN", "Token is malformed.")
    head_b64, body_b64, sig_b64 = token.split(".")
    try:
        header = json.loads(b64url_decode(head_b64))
        claims = json.loads(b64url_decode(body_b64))
    except AuthError:
        raise
    except Exception:
        raise AuthError("MALFORMED_TOKEN", "Token header or payload is not JSON.")
    if not isinstance(header, dict) or not isinstance(claims, dict):
        raise AuthError("MALFORMED_TOKEN", "Token header or payload is not an object.")
    if header.get("alg") != "RS256":
        raise AuthError("UNSUPPORTED_ALG", "Token algorithm is not accepted.")
    kid = header.get("kid")
    if not isinstance(kid, str):
        raise AuthError("UNKNOWN_KEY", "Token key id is missing.")
    issuer = "https://cognito-idp." + region + ".amazonaws.com/" + user_pool_id
    if jwks is not None:
        jwk = jwks.get(kid)
    else:
        jwk = _get_key(kid, issuer + "/.well-known/jwks.json", fetcher)
    if not jwk:
        raise AuthError("UNKNOWN_KEY", "Token was not signed by a known key.")
    try:
        n = _int_from_b64(jwk["n"])
        e = _int_from_b64(jwk["e"])
    except (KeyError, AuthError):
        raise AuthError("UNKNOWN_KEY", "Signing key is invalid.")
    signed = (head_b64 + "." + body_b64).encode("ascii")
    if not rsa_pkcs1_sha256_verify(signed, b64url_decode(sig_b64), n, e):
        raise AuthError("BAD_SIGNATURE", "Token signature is invalid.")

    now = time.time() if now is None else now
    if claims.get("iss") != issuer:
        raise AuthError("BAD_ISSUER", "Token issuer is not accepted.")
    if claims.get("token_use") != "access":
        raise AuthError("WRONG_TOKEN_USE", "An access token is required.")
    if claims.get("client_id") != client_id:
        raise AuthError("WRONG_CLIENT", "Token was issued to a different client.")
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool):
        raise AuthError("MALFORMED_TOKEN", "Token has no expiry.")
    if now >= exp:
        raise AuthError("TOKEN_EXPIRED", "Token has expired.")
    iat = claims.get("iat")
    if isinstance(iat, (int, float)) and not isinstance(iat, bool) and iat > now + _CLOCK_SKEW:
        raise AuthError("TOKEN_NOT_YET_VALID", "Token issue time is in the future.")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise AuthError("MALFORMED_TOKEN", "Token has no subject.")
    groups = claims.get("cognito:groups") or []
    if not isinstance(groups, list):
        groups = []
    return {
        "sub": sub,
        "username": claims.get("username") or sub,
        "groups": [g for g in groups if isinstance(g, str)],
        "exp": exp,
    }
