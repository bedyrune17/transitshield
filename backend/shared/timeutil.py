"""Strict UTC timestamp helpers shared by the generator and scoring engine.

Timestamps use the exact form ``YYYY-MM-DDTHH:MM:SSZ``. Parsing is
implemented by hand (rather than with ``datetime.fromisoformat``) so the
behaviour matches ``frontend/js/core/timeutil.js`` exactly, including which
malformed values are rejected.
"""

import re
import time

_TS_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$")


def days_from_civil(y: int, m: int, d: int) -> int:
    """Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant)."""
    y -= 1 if m <= 2 else 0
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    mp = m - 3 if m > 2 else m + 9
    doy = (153 * mp + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _days_in_month(y: int, m: int) -> int:
    if m == 2:
        leap = (y % 4 == 0 and y % 100 != 0) or y % 400 == 0
        return 29 if leap else 28
    return 30 if m in (4, 6, 9, 11) else 31


def parse_ts(value):
    """Return epoch seconds, or None if the value is not a valid timestamp."""
    if not isinstance(value, str):
        return None
    m = _TS_RE.match(value)
    if not m:
        return None
    y, mo, d, hh, mi, ss = (int(g) for g in m.groups())
    if not (1 <= mo <= 12) or not (1 <= d <= _days_in_month(y, mo)):
        return None
    if hh > 23 or mi > 59 or ss > 59:
        return None
    return days_from_civil(y, mo, d) * 86400 + hh * 3600 + mi * 60 + ss


def format_ts(epoch_seconds: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(epoch_seconds)))


def now_iso() -> str:
    return format_ts(int(time.time()))
