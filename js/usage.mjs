// HOW THIS PAGE GETS USED — and how that ever reaches anyone else.
//
// Two facts forced the shape of this file.
//
// 1. GitHub cannot answer "does he open the site". The traffic API measures the
//    repo page on github.com, not the Pages site, and reads 0. The site is static
//    with no backend. So the only place a visit can be recorded is localStorage,
//    on his laptop — which means it is invisible to the owner until somebody
//    carries it off that laptop by hand. Tracking without a drain is worthless;
//    `drainText` below is the other half, and it ships with the counting half.
//
// 2. What he sees and what the owner reads are deliberately NOT the same string.
//    "You have opened this page 23 times" reads as being watched, and this page is
//    supposed to be on his side. `achievementLine` gives him a streak he owns;
//    `drainText` gives the owner the raw days. Same stored data, two registers.
//
// Nothing here touches the network. No analytics, no beacon, no third party — a
// minor opens this page.
//
// Only DATES are stored, never clock times. `activity.json` publishing per-day
// timestamps for a named minor is already an open privacy question in this repo;
// this file does not add a second instance of it. A date is what a streak needs
// and it is all a streak needs.
//
// Pure functions, no DOM, no module state, injected "today" — so the streak can be
// tested across day boundaries without faking a clock.

export const USAGE_KEY = "mc.usage";

// About four months of school. Enough for any streak he can build before Aug 15,
// bounded so the record cannot grow without limit in a browser he never clears.
export const USAGE_DAY_LIMIT = 140;

const DAY_MS = 86400000;

/** A record with no history in it yet. */
export function emptyUsage() {
  return { days: [] };
}

// localStorage is his to edit — he is encouraged to open devtools on this page.
// So every read is defensive: anything that is not a well-formed day entry is
// dropped rather than trusted, and a corrupt record degrades to "no history"
// instead of throwing on his dashboard.
export function normalizeUsage(stored) {
  const days = Array.isArray(stored?.days) ? stored.days : [];
  const byDate = new Map();
  for (const entry of days) {
    if (!entry || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) continue;
    const previous = byDate.get(entry.date);
    byDate.set(entry.date, {
      date: entry.date,
      // A day is "a games day" if he opened a game on ANY visit that day, so two
      // visits in one day must OR together rather than overwrite.
      games: entry.games === true || previous?.games === true,
      lesson: entry.lesson === true || previous?.lesson === true,
      // Last section wins: the question is where he was when he left.
      section: typeof entry.section === "string" && entry.section
        ? entry.section
        : (previous?.section ?? null),
    });
  }
  const sorted = [...byDate.values()].sort((left, right) => left.date < right.date ? -1 : 1);
  return { days: sorted.slice(-USAGE_DAY_LIMIT) };
}

/** Today's entry, added if this is the first visit today. Returns a new record. */
export function noteVisit(usage, today) {
  const record = normalizeUsage(usage);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return record;
  if (record.days.some(day => day.date === today)) return record;
  return normalizeUsage({
    days: [...record.days, { date: today, games: false, lesson: false, section: null }],
  });
}

/**
 * Mark something about today: `{ games: true }`, `{ lesson: true }`, or
 * `{ section: "worldmap" }`. Creates today's entry if the visit was not noted
 * first, so a click can never be recorded against a day that does not exist.
 */
export function noteToday(usage, today, patch) {
  const record = noteVisit(usage, today);
  return normalizeUsage({
    days: record.days.map(day => day.date === today ? { ...day, ...patch } : day),
  });
}

/**
 * Consecutive days ending today. Today counts (he is here now), so a first-ever
 * visit is a streak of 1. A gap of one calendar day ends it — that is what "in a
 * row" means to a 14-year-old, and no missed-day count is ever derived from it.
 */
export function currentStreak(usage, today) {
  const dates = new Set(normalizeUsage(usage).days.map(day => day.date));
  if (!dates.has(today)) return 0;
  let streak = 0;
  let cursor = today;
  while (dates.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

/** Longest run of consecutive days anywhere in the record — his personal best. */
export function bestStreak(usage) {
  const days = normalizeUsage(usage).days;
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of days) {
    run = previous && shiftDay(previous, 1) === day.date ? run + 1 : 1;
    previous = day.date;
    if (run > best) best = run;
  }
  return best;
}

// UTC arithmetic on a bare date string. The stored value is a LOCAL date (see
// localIsoDate in render/shared.mjs) and is only ever stepped by whole days here,
// so no timezone conversion happens and no daylight-saving hour can shift a day.
function shiftDay(date, delta) {
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(stamp)) return null;
  return new Date(stamp + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Everything derived, in one object, so callers do not each re-walk the days. */
export function usageSummary(usage, today) {
  const record = normalizeUsage(usage);
  const days = record.days;
  return {
    streak: currentStreak(record, today),
    best: bestStreak(record),
    totalDays: days.length,
    firstDay: days.length ? days[0].date : null,
    lastDay: days.length ? days[days.length - 1].date : null,
    gameDays: days.filter(day => day.games).length,
    lessonDays: days.filter(day => day.lesson).length,
    lastSection: [...days].reverse().find(day => day.section)?.section ?? null,
  };
}

/**
 * The one string he sees. Rules it obeys:
 *   - it is an achievement, never a count of visits and never a count of misses;
 *   - second person, present tense, no hype, no exclamation mark — the same
 *     register as the effort line ("40 units in 12 days · 3.65 a day when you
 *     sit down");
 *   - it says nothing at all rather than say something empty. An "0 days" line
 *     on a first visit would be a worse greeting than no line.
 */
export function achievementLine(summary) {
  const streak = summary?.streak ?? 0;
  if (streak < 1) return "";
  const total = summary?.totalDays ?? 0;
  const run = streak === 1 ? "Day one of a new run" : `${streak} days in a row`;
  // On the very first day "1 day on the quest" only repeats what the run already
  // said, so the second clause waits until it carries new information.
  if (total <= streak) return `${run}.`;
  const tail = total === 1 ? "1 day on the quest" : `${total} days on the quest`;
  return `${run} · ${tail}`;
}

/**
 * The drain. #12: his requests and now his usage sit in localStorage on a laptop
 * at his grandparents' house and reach nobody. There is no server to post to and
 * there will not be one, so the honest cheapest path is plain text the owner can
 * copy off the page in one press and paste into the channel they already use.
 *
 * Plain text rather than JSON on purpose: it has to survive being pasted into a
 * chat window and still be readable by a person.
 */
export function drainText(usage, requests, today) {
  const summary = usageSummary(usage, today);
  const record = normalizeUsage(usage);
  const lines = [];
  lines.push(`algebra quest site usage — copied ${today}`);
  lines.push("");
  if (summary.totalDays === 0) {
    lines.push("no visits recorded in this browser");
  } else {
    lines.push(`days opened: ${summary.totalDays}`);
    lines.push(`first: ${summary.firstDay}  last: ${summary.lastDay}`);
    lines.push(`current streak: ${summary.streak}  best streak: ${summary.best}`);
    lines.push(`days he opened a game or puzzle: ${summary.gameDays}`);
    lines.push(`days he opened a mini-lesson: ${summary.lessonDays}`);
    lines.push(`section open when he last left: ${summary.lastSection ?? "not recorded"}`);
    lines.push("");
    lines.push("per day (g = game or puzzle, l = mini-lesson, then the section he left on):");
    for (const day of record.days) {
      const marks = `${day.games ? "g" : "-"}${day.lesson ? "l" : "-"}`;
      lines.push(`  ${day.date}  ${marks}  ${day.section ?? "-"}`);
    }
  }
  lines.push("");
  const queue = Array.isArray(requests)
    ? requests.filter(entry => entry && typeof entry.text === "string")
    : [];
  lines.push(`requests saved in this browser: ${queue.length}`);
  for (const entry of queue) {
    // Requests carry an ISO timestamp already; only the date goes out, matching
    // the date-only discipline the rest of this file keeps.
    const day = typeof entry.at === "string" ? entry.at.slice(0, 10) : "unknown date";
    lines.push(`  [${day}] ${entry.text.replace(/\s+/g, " ").trim()}`);
  }
  return `${lines.join("\n")}\n`;
}
