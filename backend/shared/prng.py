"""Deterministic 32-bit PRNG (mulberry32).

The same algorithm is implemented in ``frontend/js/core/prng.js``. Every
operation is done on unsigned 32-bit integers so that Python and JavaScript
produce bit-identical sequences for the same seed. Cross-language parity is
checked by ``tests/unit/test_parity.py``.
"""

_MASK = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _MASK


class Mulberry32:
    def __init__(self, seed: int):
        self.state = int(seed) & _MASK

    def next_u32(self) -> int:
        self.state = (self.state + 0x6D2B79F5) & _MASK
        t = self.state
        t = _imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & _MASK)) & _MASK
        return (t ^ (t >> 14)) & _MASK

    def random(self) -> float:
        return self.next_u32() / 4294967296.0

    def randint(self, lo: int, hi: int) -> int:
        """Inclusive integer in [lo, hi]."""
        return lo + (self.next_u32() % (hi - lo + 1))

    def choice(self, items):
        return items[self.randint(0, len(items) - 1)]

    def chance(self, per_mille: int) -> bool:
        """True with probability per_mille / 1000 (integer maths for parity)."""
        return self.randint(0, 999) < per_mille

    def sample(self, items, k: int):
        """Deterministic sample without replacement (partial Fisher-Yates)."""
        pool = list(items)
        k = min(k, len(pool))
        for i in range(k):
            j = self.randint(i, len(pool) - 1)
            pool[i], pool[j] = pool[j], pool[i]
        return pool[:k]
