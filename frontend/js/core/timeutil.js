// Strict UTC timestamp helpers (port of backend/shared/timeutil.py).
import { idiv } from './prng.js';

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

export function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = idiv(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = idiv(153 * mp + 2, 5) + d - 1;
  const doe = yoe * 365 + idiv(yoe, 4) - idiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

function daysInMonth(y, m) {
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** Epoch seconds, or null when the value is not a valid timestamp. */
export function parseTs(value) {
  if (typeof value !== 'string') return null;
  const m = TS_RE.exec(value);
  if (!m) return null;
  const [y, mo, d, hh, mi, ss] = m.slice(1).map((g) => parseInt(g, 10));
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (hh > 23 || mi > 59 || ss > 59) return null;
  return daysFromCivil(y, mo, d) * 86400 + hh * 3600 + mi * 60 + ss;
}

export function formatTs(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 19) + 'Z';
}

export function nowIso() {
  return formatTs(Math.floor(Date.now() / 1000));
}
