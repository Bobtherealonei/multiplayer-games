// timeUtil.js — shared date helpers so the daily/weekly reset boundaries are
// consistent between the token rewards (first-of-day / 3-in-day bonuses) and
// the Spark Shop rotations (daily midnight / Monday midnight).
//
// All boundaries are computed in a single configured timezone (default
// America/New_York) so "midnight" means the same instant for every user and
// every server instance, regardless of where Render runs them (UTC).

const SHOP_TIMEZONE = process.env.SHOP_TIMEZONE || 'America/New_York';

// Returns { year, month, day, weekday, hour, minute } for `date` in the
// configured timezone. weekday: 0=Sunday .. 6=Saturday.
function zonedParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday] ?? 0,
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute)
  };
}

// "YYYY-MM-DD" in the configured timezone — the daily reset key.
function dayKey(date = new Date()) {
  const p = zonedParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Key for the current week (the Monday that starts it), in the configured
// timezone. Used for the weekly shop rotation.
function weekKey(date = new Date()) {
  const p = zonedParts(date);
  // Days since the most recent Monday (weekday 1).
  const daysSinceMonday = (p.weekday + 6) % 7;
  const base = new Date(date.getTime());
  base.setUTCDate(base.getUTCDate() - daysSinceMonday);
  return `week-${dayKey(base)}`;
}

// Milliseconds the configured timezone is offset from UTC at `date`
// (accounts for DST at that instant).
function zoneOffsetMs(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour === '24' ? '0' : p.hour), Number(p.minute), Number(p.second)
  );
  return asUTC - date.getTime();
}

// Epoch ms of the next local midnight (daily shop reset).
function nextDailyResetMs(date = new Date()) {
  const offset = zoneOffsetMs(date);
  const wall = new Date(date.getTime() + offset);
  const nextWall = Date.UTC(
    wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1, 0, 0, 0
  );
  return nextWall - offset;
}

// Epoch ms of the next Monday local midnight (weekly shop reset).
function nextWeeklyResetMs(date = new Date()) {
  const offset = zoneOffsetMs(date);
  const wall = new Date(date.getTime() + offset);
  const weekday = wall.getUTCDay(); // 0=Sun..6=Sat
  let delta = (8 - weekday) % 7;
  if (delta === 0) delta = 7;
  const nextWall = Date.UTC(
    wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + delta, 0, 0, 0
  );
  return nextWall - offset;
}

module.exports = {
  SHOP_TIMEZONE,
  zonedParts,
  dayKey,
  weekKey,
  zoneOffsetMs,
  nextDailyResetMs,
  nextWeeklyResetMs
};
