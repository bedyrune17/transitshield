"""Token verification with real RSA signatures (no mocking of crypto)."""

import time
import unittest

from tests import helpers
from shared.auth import AuthError, reset_jwks_cache, verify_access_token


class AuthTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = helpers.test_key()
        cls.other_key = helpers.make_rsa_key()
        cls.jwks = {"kid-1": helpers.jwk_for(cls.key, "kid-1")}

    def verify(self, token, **kw):
        return verify_access_token(token, region=helpers.REGION, user_pool_id=helpers.POOL_ID,
                                   client_id=helpers.CLIENT_ID, jwks=self.jwks, **kw)

    def assertRejected(self, token, code):
        with self.assertRaises(AuthError) as ctx:
            self.verify(token)
        self.assertEqual(ctx.exception.code, code)

    def test_valid_token(self):
        actor = self.verify(helpers.sign_jwt(self.key, "kid-1", helpers.access_claims("abc", ["admins"])))
        self.assertEqual(actor["sub"], "abc")
        self.assertEqual(actor["groups"], ["admins"])

    def test_expired_token(self):
        self.assertRejected(helpers.sign_jwt(self.key, "kid-1", helpers.access_claims(exp=int(time.time()) - 1)),
                            "TOKEN_EXPIRED")

    def test_tampered_payload(self):
        token = helpers.sign_jwt(self.key, "kid-1", helpers.access_claims("abc", []))
        forged = helpers.sign_jwt(self.key, "kid-1", helpers.access_claims("abc", ["admins"]))
        head, _, sig = token.split(".")
        self.assertRejected(head + "." + forged.split(".")[1] + "." + sig, "BAD_SIGNATURE")

    def test_signed_by_another_key(self):
        self.assertRejected(helpers.sign_jwt(self.other_key, "kid-1", helpers.access_claims()), "BAD_SIGNATURE")

    def test_unknown_kid(self):
        self.assertRejected(helpers.sign_jwt(self.key, "kid-9", helpers.access_claims()), "UNKNOWN_KEY")

    def test_wrong_claims(self):
        cases = (({"iss": "https://cognito-idp.ap-south-1.amazonaws.com/other"}, "BAD_ISSUER"),
                 ({"token_use": "id"}, "WRONG_TOKEN_USE"),
                 ({"client_id": "another-client"}, "WRONG_CLIENT"),
                 ({"iat": int(time.time()) + 3600}, "TOKEN_NOT_YET_VALID"),
                 ({"sub": ""}, "MALFORMED_TOKEN"),
                 ({"exp": "soon"}, "MALFORMED_TOKEN"))
        for override, code in cases:
            with self.subTest(code=code):
                self.assertRejected(helpers.sign_jwt(self.key, "kid-1", helpers.access_claims(**override)), code)

    def test_alg_none_and_hs256_rejected(self):
        token = helpers.sign_jwt(self.key, "kid-1", helpers.access_claims(), alg="none")
        self.assertRejected(token, "UNSUPPORTED_ALG")
        token = helpers.sign_jwt(self.key, "kid-1", helpers.access_claims(), alg="HS256")
        self.assertRejected(token, "UNSUPPORTED_ALG")

    def test_malformed(self):
        for token in ("", "abc", "a.b", "a.b.c", "!!!.###.$$$", None, "x" * 9000):
            with self.subTest(token=str(token)[:10]):
                with self.assertRaises(AuthError):
                    self.verify(token)

    def test_jwks_fetch_and_cache(self):
        reset_jwks_cache()
        calls = []

        def fetcher(url):
            calls.append(url)
            return self.jwks

        token = helpers.sign_jwt(self.key, "kid-1", helpers.access_claims())
        for _ in range(3):
            verify_access_token(token, region=helpers.REGION, user_pool_id=helpers.POOL_ID,
                                client_id=helpers.CLIENT_ID, fetcher=fetcher)
        self.assertEqual(calls, [helpers.ISSUER + "/.well-known/jwks.json"])
        reset_jwks_cache()

        def broken(url):
            raise OSError("network down")

        with self.assertRaises(AuthError) as ctx:
            verify_access_token(token, region=helpers.REGION, user_pool_id=helpers.POOL_ID,
                                client_id=helpers.CLIENT_ID, fetcher=broken)
        self.assertEqual(ctx.exception.code, "JWKS_UNAVAILABLE")
        reset_jwks_cache()


if __name__ == "__main__":
    unittest.main()
