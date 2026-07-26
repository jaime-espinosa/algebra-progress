const DAY_MS = 24 * 60 * 60 * 1000;
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const PROVEN_PACE_SEED = 1.7;

function parseDateKey(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid date: ${value}`);
  }

  const shifted = new Date(date.getTime() - 4 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateKeyToTime(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function addDays(dateKey, count) {
  return new Date(dateKeyToTime(dateKey) + count * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function dayDifference(from, to) {
  return Math.ceil((dateKeyToTime(to) - dateKeyToTime(from)) / DAY_MS);
}

function remainingRows(data) {
  const semesters = (data.semesters ?? []).map((semester, inputIndex) => ({
    semester,
    inputIndex,
    rank: semester.id === "sem1" ? 0 : semester.id === "sem2" ? 1 : 2,
  }));

  semesters.sort(
    (left, right) =>
      left.rank - right.rank || left.inputIndex - right.inputIndex,
  );

  return semesters.flatMap(({ semester }) =>
    (semester.activities ?? [])
      .filter((activity) => activity.state === "not_started")
      .map((activity) => ({ activity, semesterId: semester.id }))
      .sort(
        (left, right) =>
          (left.activity.sectionNumber ?? 0) -
            (right.activity.sectionNumber ?? 0) ||
          (left.activity.rowIndex ?? 0) - (right.activity.rowIndex ?? 0),
      ),
  );
}

function scheduleRate(rowsLeft, daysLeft) {
  if (rowsLeft === 0) return 0;
  return Math.min(Math.ceil(rowsLeft / Math.max(daysLeft, 1)), 4);
}

function snapshotTotal(snapshot) {
  return ["sem1", "sem2"].reduce(
    (total, semesterId) => total + (snapshot[semesterId]?.allDone ?? 0),
    0,
  );
}

function historySnapshots(data) {
  if (Array.isArray(data.history)) return data.history;
  if (Array.isArray(data.history?.snapshots)) return data.history.snapshots;
  return [];
}

function provenPace(data) {
  const snapshots = historySnapshots(data)
    .filter((snapshot) => /^\d{4}-\d{2}-\d{2}$/.test(snapshot.date ?? ""))
    .sort((left, right) => left.date.localeCompare(right.date));

  if (snapshots.length < 7) return PROVEN_PACE_SEED;

  const trailing = snapshots.slice(-7);
  if (trailing.every((snapshot) => Number.isFinite(snapshot.rowsCompleted))) {
    return (
      trailing.reduce((total, snapshot) => total + snapshot.rowsCompleted, 0) /
      trailing.length
    );
  }

  const elapsedDays = Math.max(
    dayDifference(trailing[0].date, trailing.at(-1).date),
    1,
  );
  return Math.max(
    (snapshotTotal(trailing.at(-1)) - snapshotTotal(trailing[0])) /
      elapsedDays,
    0,
  );
}


// Rows submitted per calendar date, from real submission dates.
export function submissionsByDay(data) {
  const perDay = new Map();
  for (const semester of data.semesters ?? []) {
    for (const item of semester.activities ?? []) {
      if (item.state === "not_started") continue;
      if (typeof item.submittedDate !== "string") continue;
      perDay.set(item.submittedDate, (perDay.get(item.submittedDate) || 0) + 1);
    }
  }
  return perDay;
}

// Pace measured over days he ACTUALLY worked, not over the calendar. Averaging in
// the days he never opened the course reported 1.7/day and a September finish, which
// was both wrong and demoralising: it described his consistency while claiming to
// describe his speed. On working days he does ~3.8, comfortably above what the
// deadline needs. The lever is how often he sits down, never how fast he goes.
export function effortStats(data, today) {
  const perDay = submissionsByDay(data);
  const dates = [...perDay.keys()].sort();
  const activeDays = dates.length;
  const submitted = [...perDay.values()].reduce((sum, n) => sum + n, 0);
  const activePace = activeDays ? submitted / activeDays : 0;
  const todayKey = parseDateKey(today);
  const spanDays = activeDays
    ? Math.max(1, dayDifference(parseDateKey(dates[0]), todayKey) + 1)
    : 1;
  const showUpRate = activeDays / spanDays;
  const rowsLeft = remainingRows(data).length;
  const daysLeft = Math.max(1, dayDifference(todayKey, parseDateKey(data.deadline.date)));
  const requiredPerDay = rowsLeft / daysLeft;
  const daysNeeded = activePace > 0 ? Math.ceil(rowsLeft / activePace) : Infinity;
  const showUpNeeded = Math.min(1, daysNeeded / daysLeft);
  const onTrack = daysNeeded > daysLeft
    ? 0
    : Math.max(0, Math.min(1, showUpRate / Math.max(showUpNeeded, 0.01)));
  // Ties break to the EARLIEST date so the personal best is stable: a later day
  // that merely matches it must not quietly replace a record he remembers setting.
  const best = [...perDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((left, right) => right.count - left.count || left.date.localeCompare(right.date))[0] || null;
  return { perDay, activeDays, submitted, activePace, showUpRate, spanDays, rowsLeft,
           daysLeft, requiredPerDay, daysNeeded, showUpNeeded, onTrack, best,
           fastEnough: activePace >= requiredPerDay };
}

export function computePace(data, today) {
  const todayKey = parseDateKey(today);
  const deadlineKey = parseDateKey(data.deadline.date);
  const daysLeft = Math.max(dayDifference(todayKey, deadlineKey), 0);
  const rowsLeft = remainingRows(data).length;
  const requiredPerDay =
    rowsLeft === 0 ? 0 : rowsLeft / Math.max(daysLeft, 1);
  const provenPerDay = effortStats(data, today).activePace || provenPace(data);
  const projectedDays =
    rowsLeft === 0
      ? 0
      : Math.ceil(rowsLeft / Math.max(provenPerDay, 0.1));

  return {
    daysLeft,
    rowsLeft,
    requiredPerDay,
    provenPerDay,
    projectedFinish: addDays(todayKey, projectedDays),
    dailyAsk: Math.min(Math.ceil(requiredPerDay), 4),
  };
}

export function buildSchedule(data, today) {
  const todayKey = parseDateKey(today);
  const rows = remainingRows(data);
  const daysLeft = Math.max(
    dayDifference(todayKey, parseDateKey(data.deadline.date)),
    0,
  );
  const perDay = scheduleRate(rows.length, daysLeft);

  return rows.map(({ activity }, index) => ({
    ...activity,
    ourTarget: addDays(todayKey, Math.floor(index / perDay)),
  }));
}

export function questBoard(data, today) {
  const todayKey = parseDateKey(today);
  const schedule = buildSchedule(data, todayKey);

  return Array.from({ length: 3 }, (_, dayOffset) => {
    const date = addDays(todayKey, dayOffset);
    return {
      date,
      items: schedule
        .filter((activity) => activity.ourTarget === date)
        .slice(0, 4),
    };
  });
}

function completionEvents(history) {
  const records = Array.isArray(history)
    ? history
    : Array.isArray(history?.events)
      ? history.events
      : [];

  const eventDates = records
    .filter(
      (record) =>
        record.state === "graded" ||
        record.state === "submitted_ungraded" ||
        record.completed === true,
    )
    .map((record) =>
      parseDateKey(
        record.timestamp ??
          record.submittedAt ??
          record.submittedDate ??
          record.date,
      ),
    );

  const snapshots = Array.isArray(history?.snapshots)
    ? [...history.snapshots].sort((left, right) =>
        left.date.localeCompare(right.date),
      )
    : [];
  for (let index = 1; index < snapshots.length; index += 1) {
    if (snapshotTotal(snapshots[index]) > snapshotTotal(snapshots[index - 1])) {
      eventDates.push(snapshots[index].date);
    }
  }

  return new Set(eventDates);
}

export function computeStreak(history, now) {
  const completedDays = completionEvents(history);
  const currentDay = parseDateKey(now);
  let cursor = completedDays.has(currentDay)
    ? currentDay
    : addDays(currentDay, -1);
  let streak = 0;

  while (completedDays.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  return streak;
}

// The unlock gate. This lived in app.js while quest.mjs exported a DIFFERENT
// implementation keyed on ids that existed nowhere in vault/manifest.json — the two
// sets shared exactly one id, so wiring the exported one up would have unlocked one
// artifact out of eleven. HANDOFF.md claimed this file governed unlocks the whole
// time, which was false. The app.js rules won because they are keyed to the manifest
// and are what actually gated; they now live here because this module is tested and
// unlock rules do not belong in a 1600-line render file.
//
// Ids must match vault/manifest.json exactly or a milestone silently unlocks nothing.
// A test asserts that correspondence in both directions; it is what stops this
// happening a third time.
// The unlock gate. The rules that actually gated the vault lived in app.js, while a
// divergent, unused key set lived here and made HANDOFF.md's claim that quest.mjs
// governed unlocks false. The app.js rules moved here unchanged and the divergent
// set was deleted: rules belong in the tested module, not in a render file.
//
// Ids must match vault/manifest.json exactly, or a milestone silently unlocks
// nothing. quest.test.mjs asserts that correspondence in both directions.
function unlockConditions(data) {
  const semesters = data.semesters ?? [];
  const sem1 = semesters.find(semester => semester.id === "sem1");
  const sem2 = semesters.find(semester => semester.id === "sem2");
  const sem2Submitted = sem2?.activities.filter(item => item.state !== "not_started") ?? [];
  const sectionDone = number => {
    const rows = sem2?.activities.filter(item => item.sectionNumber === number) ?? [];
    return rows.length > 0 && rows.every(item => item.state !== "not_started");
  };
  // Retroactive: already earned by the work behind him. Without these the vault is
  // empty on first load and the reveal has nothing to reveal — 97 finished
  // activities would have bought him nothing.
  const sem1SectionsSealed = sem1
    ? new Set(sem1.activities.filter(item => item.sectionNumber > 0).map(item => item.sectionNumber))
        .size - new Set(sem1.activities
          .filter(item => item.sectionNumber > 0 && item.state === "not_started")
          .map(item => item.sectionNumber)).size
    : 0;
  return {
    "algebra-miner-skin": (sem1?.allDone ?? 0) >= 90,
    "momentum-cursor-pet": sem1SectionsSealed >= 4,
    "sem1-victory-pack": (sem1?.percent ?? 0) >= 80,
    // Six rows from now. Checkable against the Semester 1 list itself: every row
    // in it submitted, nothing modelled or estimated.
    "photo-skin-studio": (sem1?.activities.length ?? 0) > 0
      && sem1.activities.every(item => item.state !== "not_started"),
    // The skins are the reward strand, so the first one has to land in days, not
    // weeks: one Semester 2 row opens it. Each is a palette in
    // vault/tools/make-skins.mjs — new ones he asks for are cheap to add.
    "ignition-skin": sem2Submitted.length >= 1,
    "nether-skin": sectionDone(1),
    "end-skin": sectionDone(3),
    "nether-theme": sem2Submitted.length >= 3,
    "auto-breeding-pen": sectionDone(1),
    "ballistics-workbench": sectionDone(2),
    "target-practice": sectionDone(3),
    "surveyor": sectionDone(4),
    "farm-rate-optimizer": sectionDone(5),
    "youtube-analytics-template": sectionDone(6),
    // The only rule that was unguarded against vacuous truth: with an empty
    // activity list every() is true, so a failed scrape handed him the End theme.
    // Every other rule already required rows to exist. Not a change on real data.
    "end-theme-final": semesters.length > 0 && semesters.every(semester =>
      (semester.activities?.length ?? 0) > 0
      && semester.activities.every(item => item.state !== "not_started"))
  };
}

// Every id the gate can award. Derived from the rules themselves rather than
// listed a second time, so the two cannot drift the way app.js and quest.mjs did.
export const UNLOCK_IDS = Object.freeze(Object.keys(unlockConditions({ semesters: [] })));

// earnedSet is optional and is only ever unioned in: a later, worse scrape can
// never revoke something he has already earned.
export function evaluateUnlocks(data, earnedSet) {
  const conditions = unlockConditions(data);
  return new Set([
    ...(earnedSet ?? []),
    ...Object.keys(conditions).filter(id => conditions[id]),
  ]);
}


// --- Dashboard instruments -------------------------------------------------
// Every quantity below is a count he can check against his own gradebook. No
// modelled, smoothed or projected values. In particular there is no hours
// figure anywhere: hours/day would need the LMS Activity tab, which has never
// been scraped, and inventing one would repeat the "best day: 7" mistake.

// Rows submitted inside a trailing window of CALENDAR days, inclusive of today.
// This is the only instantaneous reading we have: it is a raw count, not a rate,
// and it says how warm the last week has been.
export function recentVolume(data, today, days = 7) {
  const perDay = submissionsByDay(data);
  const to = parseDateKey(today);
  const from = addDays(to, -(days - 1));
  let total = 0;
  for (const [date, count] of perDay) {
    if (date >= from && date <= to) total += count;
  }
  return { days, total, from, to };
}

// One call for the whole instrument cluster, so app.js never recomputes pace.
export function dashboard(data, today) {
  const stats = effortStats(data, today);
  const totalRows = stats.submitted + stats.rowsLeft;
  const week = recentVolume(data, today, 7);
  const priorWeek = recentVolume(data, addDays(parseDateKey(today), -7), 7);
  return {
    // Odometer: rows submitted, all time. Only ever goes up.
    odometer: stats.submitted,
    totalRows,
    tripDone: totalRows > 0 ? stats.submitted / totalRows : 0,
    // Speedometer: rows per day on days he actually works, against the pace
    // the deadline needs.
    activePace: stats.activePace,
    requiredPerDay: stats.requiredPerDay,
    fastEnough: stats.fastEnough,
    // Tachometer: raw rows in the last seven calendar days, and the seven
    // before that, so "hot or cold" is a comparison of two counts.
    recent7: week.total,
    recent7From: week.from,
    recent7To: week.to,
    prior7: priorWeek.total,
    // Trip / distance to go.
    rowsLeft: stats.rowsLeft,
    daysLeft: stats.daysLeft,
    daysNeeded: stats.daysNeeded,
    activeDays: stats.activeDays,
    // Calendar days from his first submission through today, inclusive. The
    // dial used to reconstruct this by dividing activeDays by showUpRate and
    // rounding, which could land a day off; it is the real span now.
    spanDays: stats.spanDays,
    showUpRate: stats.showUpRate,
    showUpNeeded: stats.showUpNeeded,
    best: stats.best,
  };
}

// --- Actual versus adjusted plan -------------------------------------------
// Two plan segments, both derived, never a deficit count:
//   * the steady route  — totalRows spread evenly from his first working day to
//     the deadline. Drawn behind the past only, as context for slope.
//   * the adjusted route — the real ourTarget dates the pipeline schedules,
//     anchored at where he actually stands today. This is the live plan.
// Nothing here returns "days behind" or any negative quantity: surplus is
// clamped at zero on the way out, so no caller can render a deficit.
export function planTrack(data, today) {
  const perDay = submissionsByDay(data);
  const todayKey = parseDateKey(today);
  const deadline = parseDateKey(data.deadline.date);
  const dates = [...perDay.keys()].sort();
  const firstDay = dates[0] ?? todayKey;
  const submitted = [...perDay.values()].reduce((sum, n) => sum + n, 0);
  const rows = remainingRows(data);
  const totalRows = submitted + rows.length;

  // The adjusted plan is buildSchedule's own output, re-anchored on today, not
  // the ourTarget dates frozen into data.json at scrape time. One scheduler.
  const plannedByDay = new Map();
  for (const item of buildSchedule(data, today)) {
    if (typeof item.ourTarget !== "string") continue;
    plannedByDay.set(item.ourTarget, (plannedByDay.get(item.ourTarget) || 0) + 1);
  }

  const spanDays = Math.max(1, dayDifference(firstDay, deadline));
  const steadyRate = totalRows / spanDays;

  const previousDay = addDays(todayKey, -1);
  const anchorDay = previousDay < firstDay ? firstDay : previousDay;
  const points = [];
  let cumDone = 0;
  let cumAdjusted = null;
  let index = 0;
  for (let cursor = firstDay; cursor <= deadline; cursor = addDays(cursor, 1)) {
    const done = perDay.get(cursor) || 0;
    const future = cursor > todayKey;
    if (!future) cumDone += done;
    const steady = Math.min(totalRows, steadyRate * (index + 1));
    // The adjusted route is anchored on where he really stands at the end of
    // yesterday, then follows the dates the scheduler actually assigned, so the
    // two lines meet rather than jumping.
    if (cursor === anchorDay) cumAdjusted = cumDone;
    else if (cursor >= todayKey && cumAdjusted !== null) {
      cumAdjusted = Math.min(totalRows, cumAdjusted + (plannedByDay.get(cursor) || 0));
    }
    points.push({
      date: cursor,
      done,
      future,
      cumDone: future ? null : cumDone,
      steady,
      steadyDaily: steadyRate,
      adjusted: cumAdjusted !== null && cursor >= anchorDay ? cumAdjusted : null,
      planned: plannedByDay.get(cursor) || 0,
      // A day he beat the steady route. This is the quantity the view should
      // shout about; there is deliberately no "fell short" counterpart.
      surplus: future ? 0 : Math.max(0, done - steadyRate),
      beatPlan: !future && done > steadyRate,
    });
    index += 1;
  }

  // Best comeback: the window in which his cumulative surplus over the steady
  // route grew the most. It is a gain, so it can only ever be reported as
  // ground made up, never as ground lost.
  let comeback = null;
  let minRelative = 0;
  let minAt = null;
  let running = 0;
  const past = points.filter((point) => !point.future);
  for (const point of past) {
    running += point.done - steadyRate;
    if (running - minRelative > (comeback?.rawGain ?? 0)) {
      comeback = {
        from: minAt ?? point.date,
        to: point.date,
        rawGain: running - minRelative,
      };
    }
    if (running < minRelative) {
      minRelative = running;
      minAt = addDays(point.date, 1);   // the climb starts the day after the trough
    }
  }
  if (comeback) {
    comeback.gain = Math.floor(comeback.rawGain);
    comeback.days = dayDifference(comeback.from, comeback.to) + 1;
    // The plain count of rows inside the window. `gain` is a DIFFERENCE against
    // the steady route, and he can and will add up the tiles on his own
    // calendar; any view that shows the difference must show this count too, or
    // he arrives at a different number and concludes the page is lying.
    comeback.rows = past
      .filter((point) => point.date >= comeback.from && point.date <= comeback.to)
      .reduce((total, point) => total + point.done, 0);
    if (comeback.gain < 1) comeback = null;
  }

  const finishesOn = [...plannedByDay.keys()].sort().at(-1) ?? todayKey;

  return {
    points,
    steadyRate,
    totalRows,
    submitted,
    firstDay,
    today: todayKey,
    deadline,
    finishesOn,
    bestDays: past
      .filter((point) => point.beatPlan)
      .sort((left, right) => right.done - left.done || left.date.localeCompare(right.date)),
    comeback,
  };
}

// --- Time the course was open ----------------------------------------------
// The LMS Activity report does NOT measure time spent working. It measures how
// long the course page was open, and nothing logs him out: the live report
// contains a single 10h 8m entry starting 12:07 AM, which is a browser tab left
// open overnight, not ten hours of algebra. Divide that by rows and you get
// "619 minutes per row", which would tell a kid he is slow when he is not.
//
// So: nothing here is modelled, capped, or estimated. Every second returned is
// the LMS's own figure, and the totals match the page exactly (93h 43m for
// Semester 1). What this adds is naming the outliers rather than burying them,
// so the page can show them instead of quietly counting or quietly dropping
// them. Callers must label the number "time the course was open" — never
// "hours worked", never "study time" — and must never divide it by rows.
export const LONG_STRETCH_SECONDS = 3 * 3600;   // one unbroken entry this long is marked
export const LONG_DAY_SECONDS = 8 * 3600;       // a day's total this long is marked

function formatDuration(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.round((whole % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function openTime(activity, today) {
  const courses = Array.isArray(activity?.courses) ? activity.courses : [];
  const todayKey = parseDateKey(today);
  const byDay = new Map();
  const stretches = [];
  let totalSeconds = 0;

  for (const course of courses) {
    // The course-level figure is what the LMS prints at the top of its own
    // report, so the total on screen can be checked against the page directly.
    totalSeconds += Number(course?.reportedTotalSeconds) || 0;
    for (const day of course?.days ?? []) {
      const date = typeof day?.date === "string" ? day.date : null;
      if (!date || date > todayKey) continue;
      const seconds = Number(day?.reportedSeconds) || 0;
      const entry = byDay.get(date) ?? { date, seconds: 0, longest: 0, marked: false };
      entry.seconds += seconds;
      for (const item of day?.entries ?? []) {
        const span = Number(item?.seconds) || 0;
        entry.longest = Math.max(entry.longest, span);
        // The parser's own idleSuspect fires at four hours and caught two
        // entries in the whole dataset. Three hours unbroken catches the rest
        // without inventing a value: the entry is still counted, just named.
        if (span >= LONG_STRETCH_SECONDS || item?.idleSuspect === true) {
          stretches.push({
            date,
            seconds: span,
            startTime: typeof item?.startTime === "string" ? item.startTime : null,
            text: formatDuration(span),
          });
        }
      }
      byDay.set(date, entry);
    }
  }

  for (const entry of byDay.values()) {
    entry.marked = entry.seconds >= LONG_DAY_SECONDS
      || entry.longest >= LONG_STRETCH_SECONDS;
    entry.text = formatDuration(entry.seconds);
  }

  const days = [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
  stretches.sort((left, right) => right.seconds - left.seconds);
  const asOf = typeof activity?.generatedAt === "string"
    ? activity.generatedAt.slice(0, 10)
    : null;

  return {
    totalSeconds,
    totalText: formatDuration(totalSeconds),
    dayCount: days.length,
    firstDay: days[0]?.date ?? null,
    lastDay: days.at(-1)?.date ?? null,
    days,
    // Named, not removed. Every second above is still counted; these are the
    // stretches long enough that "the tab was open" is the likelier story.
    stretches,
    markedDays: days.filter((day) => day.marked).length,
    asOf,
    // A caller that wants a total with the flagged stretches taken out has to
    // ask for it explicitly, and then it must say so on screen.
    withoutMarkedStretches: totalSeconds
      - stretches.reduce((sum, stretch) => sum + stretch.seconds, 0),
  };
}

// Open time keyed by date, plus the peak, so a chart can plot it without any
// caller re-deriving it. `longest` and `startTime` travel with the day so the
// view can say WHY a spike is a spike ("a tab was left open") instead of
// letting it read as a ten-hour day. Nothing here is capped or smoothed.
export function openTimeSeries(activity, today) {
  const open = openTime(activity, today);
  const byDay = new Map();
  for (const day of open.days) {
    const longest = open.stretches
      .filter((stretch) => stretch.date === day.date)
      .sort((left, right) => right.seconds - left.seconds)[0] ?? null;
    byDay.set(day.date, { ...day, longestStretch: longest });
  }
  return {
    ...open,
    byDay,
    maxSeconds: open.days.reduce((max, day) => Math.max(max, day.seconds), 0),
  };
}

// --- World map --------------------------------------------------------------
// The syllabus as terrain: two worlds (the two semesters), each divided into
// regions (the syllabus sections), each region built out of blocks (gradebook
// rows).
//
// THE UNIT IS THE GRADEBOOK ROW, everywhere in here, with no exceptions. That is
// the same unit the quest board schedules, the effort dials count, the calendar
// tiles and the "N units left" line all use, so every count on the map adds up
// against every other count on the page. It is deliberately NOT allDone/allTotal,
// which count LMS *activities* — a different, larger list (105 against 67 in
// Semester 1). Both are true; only one can be on the map, because two totals a
// subtraction apart on one screen read as an arithmetic error no matter how
// carefully each is labelled. If you ever put an activities figure on the map,
// it has to say the word "activities" out loud, next to the number.
//
// Region order is the route order the rest of the site already uses: Semester 1
// before Semester 2, section number ascending, rowIndex ascending inside a
// section. `here` is the region holding the single next unit — the same row the
// quest board puts at the top.

const WORLD_SEQUENCE = ["sem1", "sem2"];
const ORIENTATION_REGION_NAME = "Orientation";
// How many regions sit across the world before the route wraps to the next
// band. Layout only: it never changes which regions exist or what order they
// are in, it only decides where the same route bends.
const MAP_COLUMNS = 4;

// Training or battle. The LMS gives no type field at all — every row carries
// `type: null` — so the only honest signal is the title the school wrote.
// A row whose title says quiz or test is a battle; everything else
// (assignments, activities, the orientation contact row) is training.
// Nothing about this changes a count: every row is still exactly one unit,
// and trainingTotal + battleTotal === unitsTotal for every region.
export function activityKind(title) {
  return /\b(quiz|test|exam)\b/i.test(String(title ?? "")) ? "battle" : "training";
}

function regionKey(worldId, number) {
  return `${worldId}:${number}`;
}

function orderedSemesters(data) {
  const semesters = (data.semesters ?? []).map((semester, inputIndex) => ({
    semester,
    inputIndex,
    rank: WORLD_SEQUENCE.indexOf(semester.id) === -1
      ? WORLD_SEQUENCE.length
      : WORLD_SEQUENCE.indexOf(semester.id),
  }));
  semesters.sort((left, right) =>
    left.rank - right.rank || left.inputIndex - right.inputIndex);
  return semesters.map(({ semester }) => semester);
}

export function worldMap(data) {
  const nextRow = remainingRows(data)[0] ?? null;
  const nextId = nextRow?.activity?.id ?? null;
  const nextWorldId = nextRow?.semesterId ?? null;

  const worlds = orderedSemesters(data).map((semester, worldIndex) => {
    const activities = semester.activities ?? [];
    const sections = semester.sections ?? [];
    const numbers = [...new Set(activities
      .map((item) => Number(item.sectionNumber) || 0))]
      .sort((left, right) => left - right);

    const regions = numbers.map((number) => {
      const units = activities
        .filter((item) => (Number(item.sectionNumber) || 0) === number)
        .slice()
        .sort((left, right) => (left.rowIndex ?? 0) - (right.rowIndex ?? 0))
        .map((item) => ({
          id: item.id,
          title: item.title,
          state: item.state,
          done: item.state !== "not_started",
          score: item.score ?? null,
          submittedDate: typeof item.submittedDate === "string" ? item.submittedDate : null,
          isNext: item.id === nextId,
          kind: activityKind(item.title),
        }));
      const training = units.filter((unit) => unit.kind === "training");
      const battles = units.filter((unit) => unit.kind === "battle");
      const unitsDone = units.filter((unit) => unit.done).length;
      const unitsTotal = units.length;
      const unitsLeft = unitsTotal - unitsDone;
      const holdsNext = semester.id === nextWorldId && units.some((unit) => unit.isNext);
      const section = sections.find((entry) => entry.number === number) ?? null;
      // Every region with rows is drawn. A region with no rows is not drawn at
      // all rather than drawn empty, so a failed scrape cannot paint the map as
      // a row of finished-looking blanks.
      return {
        key: regionKey(semester.id, number),
        worldId: semester.id,
        number,
        name: section?.name
          || activities.find((item) => (Number(item.sectionNumber) || 0) === number)?.sectionName
          || (number === 0 ? ORIENTATION_REGION_NAME : `Section ${number}`),
        units,
        unitsTotal,
        unitsDone,
        unitsLeft,
        // The same rows, split by what they are. These are two views of one
        // list, never a second denominator: trainingTotal + battleTotal
        // always equals unitsTotal.
        trainingTotal: training.length,
        trainingDone: training.filter((unit) => unit.done).length,
        battleTotal: battles.length,
        battleCleared: battles.filter((unit) => unit.done).length,
        // settled — every row in it submitted. here — it holds the next row.
        // started — some rows in, not the current one. ahead — not visited yet,
        // which is a neutral statement of fact and never a shortfall.
        status: unitsTotal > 0 && unitsLeft === 0
          ? "settled"
          : holdsNext
            ? "here"
            : unitsDone > 0 ? "started" : "ahead",
        // The section grade the LMS prints for that section, when there is one.
        // Semester 2 has none yet, and null renders as nothing rather than 0%.
        grade: Number.isFinite(section?.percent) ? section.percent : null,
        letter: typeof section?.letter === "string" ? section.letter : null,
        // Section 0 is orientation; there is no mini-lesson numbered 00.
        lessonSlug: number > 0
          ? `${semester.id}-${String(number).padStart(2, "0")}`
          : null,
      };
    }).filter((region) => region.unitsTotal > 0);

    const unitsDone = regions.reduce((sum, region) => sum + region.unitsDone, 0);
    const unitsTotal = regions.reduce((sum, region) => sum + region.unitsTotal, 0);
    return {
      id: semester.id,
      index: worldIndex + 1,
      name: semester.name ?? "",
      regions,
      unitsDone,
      unitsTotal,
      unitsLeft: unitsTotal - unitsDone,
      // Rounded for display only; both operands travel with it and are printed
      // beside it, so the rounding is never the only thing on screen.
      percent: unitsTotal > 0 ? Math.round((unitsDone / unitsTotal) * 100) : 0,
      sealed: unitsTotal > 0 && unitsDone === unitsTotal,
      regionsSettled: regions.filter((region) => region.status === "settled").length,
      regionsTotal: regions.length,
      holdsNext: semester.id === nextWorldId,
      grade: Number.isFinite(semester.percent) ? semester.percent : null,
      letter: typeof semester.letter === "string" ? semester.letter : null,
    };
  }).filter((world) => world.regionsTotal > 0);

  // One scrollable world, laid out in 2D. The route is unchanged — regions
  // stay in route order — it just bends at the edge of the map instead of
  // running off to the right forever. Each semester starts on its own band so
  // no region is ever moved between worlds to make a row come out even.
  let rowCursor = 0;
  for (const world of worlds) {
    world.rowStart = rowCursor;
    world.regions.forEach((region, index) => {
      const band = Math.floor(index / MAP_COLUMNS);
      const offset = index % MAP_COLUMNS;
      // Serpentine: odd bands run right to left, so the route is one
      // continuous path he can trace with a finger rather than a jump back.
      region.col = band % 2 === 0 ? offset : MAP_COLUMNS - 1 - offset;
      region.row = rowCursor + band;
    });
    const bands = Math.ceil(world.regions.length / MAP_COLUMNS);
    world.rowSpan = bands;
    rowCursor += bands;
  }

  const totalDone = worlds.reduce((sum, world) => sum + world.unitsDone, 0);
  const totalUnits = worlds.reduce((sum, world) => sum + world.unitsTotal, 0);
  return {
    worlds,
    grid: { cols: MAP_COLUMNS, rows: rowCursor },
    totalUnits,
    totalDone,
    totalLeft: totalUnits - totalDone,
    next: nextRow
      ? {
          id: nextId,
          title: nextRow.activity.title,
          worldId: nextWorldId,
          regionNumber: Number(nextRow.activity.sectionNumber) || 0,
          regionKey: regionKey(nextWorldId, Number(nextRow.activity.sectionNumber) || 0),
        }
      : null,
  };
}

// A copy of `data` with every row inside the given regions marked submitted.
// Used only to ask the real unlock gate where a reward would land; nothing
// derived from it is ever displayed as fact.
function withRegionsFinished(data, keys) {
  return {
    ...data,
    semesters: (data.semesters ?? []).map((semester) => ({
      ...semester,
      activities: (semester.activities ?? []).map((item) =>
        keys.has(regionKey(semester.id, Number(item.sectionNumber) || 0))
          && item.state === "not_started"
          ? { ...item, state: "graded" }
          : item),
    })),
  };
}

// Where each vault artifact stands on the map.
//
// The anchor is not a hand-written table — those drift, and this project has
// been burned twice by a second copy of a list. It is found by asking the real
// unlock gate: walk the regions in route order, mark each one finished in a
// throwaway copy of the data, and record the first region at which
// unlockConditions() flips the artifact on. So the landmark sits exactly where
// the rule says it will, and it cannot disagree with the rule, because it IS
// the rule.
//
// Three outcomes:
//   earned: true                  — already his; drawn standing, not promised.
//   regionKey: "sem2:3"           — unlocks when that region is settled.
//   regionKey: null, earned:false — no amount of remaining rows turns it on,
//                                   because the rule is keyed on a grade or on
//                                   the LMS activity count rather than on rows.
//                                   Left unplaced rather than pinned somewhere
//                                   false.
export function mapLandmarks(data) {
  const now = unlockConditions(data);
  const landmarks = UNLOCK_IDS
    .filter((id) => now[id])
    .map((id) => ({ id, earned: true, worldId: null, regionNumber: null, regionKey: null }));

  const pending = UNLOCK_IDS.filter((id) => !now[id]);
  const finished = new Set();
  for (const region of worldMap(data).worlds.flatMap((world) => world.regions)) {
    if (pending.length === 0) break;
    finished.add(region.key);
    const conditions = unlockConditions(withRegionsFinished(data, finished));
    for (const id of pending.filter((candidate) => conditions[candidate])) {
      landmarks.push({
        id,
        earned: false,
        worldId: region.worldId,
        regionNumber: region.number,
        regionKey: region.key,
      });
      pending.splice(pending.indexOf(id), 1);
    }
  }
  for (const id of pending) {
    landmarks.push({ id, earned: false, worldId: null, regionNumber: null, regionKey: null });
  }
  return landmarks;
}

// --- Which denominator the world map leads with -----------------------------
// A "lie that we are past 50%" was requested, so the whole-course figure would
// read as encouraging, and was DECLINED: nothing on this page may be a number he
// cannot check against his own gradebook. This is what replaced it.
//
// 46% is not more true than 93%; it is the same work under the most
// discouraging denominator available. Semester 1 is the nearest real finish
// line, so that is what leads. The whole-course figure is still on the page, in
// the course-progress dial; it just stopped being the headline. If you change
// the denominator, change it to another one he can verify, and say which one it
// is on screen.
//
// NAME THE UNIT OR MATCH THE DENOMINATOR — never neither. This object carries
// two counts that are both true and are not equal: LMS activities (allTotal 105)
// and gradebook rows (66 in semester.activities). A version that printed
// "99 of 105 done" above "5 units from sealing" was reconciling neither, and the
// difference of one reads as an arithmetic error he can catch. Whatever is shown
// in activities must say the word "activities" on screen; the bare word "unit"
// means a gradebook row, here and everywhere else on the site.
export function semesterFocus(data) {
  const semester = (data.semesters ?? []).find((item) => item.id === "sem1")
    ?? (data.semesters ?? [])[0] ?? null;
  if (!semester) return null;
  const total = Math.max(0, Number(semester.allTotal) || 0);
  const done = Math.min(total, Math.max(0, Number(semester.allDone) || 0));
  const activitiesLeft = Math.max(0, total - done);
  // Two different real quantities, so two names. done/total/percent/activitiesLeft
  // count LMS activities, the 105-row list the tile map is built from. rowsLeft
  // counts gradebook rows still not submitted — the unit the quest board, the
  // effort dials and the 71-left figure all use, and the exact condition that
  // fires photo-skin-studio. They differ (6 against 5 today) and neither is wrong.
  // The screen must say which one it is showing; see app.js renderWorldMap.
  const rows = semester.activities ?? [];
  const rowsLeft = rows.filter((item) => item.state === "not_started").length;
  return {
    id: semester.id,
    name: semester.name ?? "",
    done,
    total,
    // Rounded for display only; both operands are printed beside it.
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
    activitiesLeft,
    rowsLeft,
    // Sealed tracks the countdown the page shows and the unlock that follows it:
    // every gradebook row submitted. If this ever stops matching the
    // photo-skin-studio rule in evaluateUnlocks(), the reward fires against a
    // countdown that is still running and the site looks broken.
    sealed: rows.length > 0 && rowsLeft === 0,
    sectionsSealed: (semester.sections ?? []).filter((section) => section.complete).length,
    sectionsTotal: (semester.sections ?? []).length,
    grade: Number.isFinite(semester.percent) ? semester.percent : null,
    letter: typeof semester.letter === "string" ? semester.letter : null,
  };
}

// --- Dial scales -----------------------------------------------------------
// The gauges are analog now: numbered major ticks around the arc, unnumbered
// minors between them, and a second percentage scale on a tighter inner arc.
// Every one of those positions is arithmetic on a real value, so the geometry
// lives here with the rest of the derived numbers rather than in the renderer.
//
// Nothing in here invents a quantity. `dialScale` only picks a round full-scale
// value at or above what it is given, and `percentTicks` only expresses a value
// as a share of a basis the page already shows.

const DIAL_STEPS = [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 500];

// Round `raw` up to a full-scale value made of round steps, aiming for four to
// seven numbered ticks. Returns the scale plus every tick position as a
// fraction of the arc, so the renderer never divides anything itself.
export function dialScale(value, raw, { minors = 4 } = {}) {
  const wanted = Math.max(raw, value, 1);
  const step = DIAL_STEPS.find((candidate) => Math.ceil(wanted / candidate) <= 7)
    ?? DIAL_STEPS[DIAL_STEPS.length - 1];
  const majorCount = Math.max(1, Math.ceil(Number((wanted / step).toFixed(6))));
  const max = step * majorCount;
  const decimals = step < 1 ? 1 : 0;
  const majors = [];
  for (let index = 0; index <= majorCount; index += 1) {
    const at = index / majorCount;
    majors.push({ at, value: step * index, text: (step * index).toFixed(decimals) });
  }
  const minorAts = [];
  for (let index = 0; index < majorCount; index += 1) {
    for (let sub = 1; sub < minors; sub += 1) {
      minorAts.push((index + sub / minors) / majorCount);
    }
  }
  return {
    max,
    step,
    majors,
    minors: minorAts,
    fraction: Math.max(0, Math.min(1, value / max)),
  };
}

const PERCENT_STEPS = [5, 10, 20, 25, 50, 100];

// The inner scale: the same reading expressed as a percentage of `basis`.
// A percent p sits at value p/100 * basis, i.e. arc fraction that value / max.
// Ticks past the end of the arc are dropped, which is why the inner scale stops
// short of the outer one exactly like the reference dial's second scale does.
export function percentTicks(scaleMax, basis, { maxTicks = 6 } = {}) {
  if (!(basis > 0) || !(scaleMax > 0)) return [];
  const fullPercent = (scaleMax / basis) * 100;
  const step = PERCENT_STEPS.find((candidate) => Math.floor(fullPercent / candidate) + 1 <= maxTicks)
    ?? PERCENT_STEPS[PERCENT_STEPS.length - 1];
  const ticks = [];
  for (let percent = 0; percent <= fullPercent + 1e-9; percent += step) {
    const at = ((percent / 100) * basis) / scaleMax;
    if (at > 1 + 1e-9) break;
    ticks.push({ at: Math.min(1, at), percent, text: String(percent) });
  }
  return ticks;
}

// ---- World terrain -------------------------------------------------------
// A Minecraft-style top-down world map, generated from worldMap() and nothing
// else. Every shape in here is DECORATION: the only facts it carries are the
// ones worldMap() already established — how many regions there are, which
// semester each belongs to, how many units are in it and how many are done.
// No number is invented here and none is displayed from here; the counts on
// screen come from the region objects themselves.
//
// WHY IT IS DETERMINISTIC. The coastline is a function of (constant seed,
// region identity, unit counts). Reloading the page, or finishing one unit,
// must not hand him a differently-shaped world — a map that reshuffles is not a
// place, it is a screensaver. Terrain GROWS (more units done => more lit
// ground); it never rearranges. `terrainSignature()` exists so a test can
// assert exactly that.
//
// WHY IT IS PATHS AND NOT CELLS. The blocky look wants a ~8px cell grid, which
// is ~15,000 cells. One node per cell would be unshippable on the 2018 machine
// this has to pan smoothly on. So cells are bucketed into a few dozen layers by
// colour, merged into horizontal runs, and emitted as ONE <path> per layer.
// Node count lands in the low hundreds regardless of grid size.
//
// NO RED. Minecraft maps are full of it — badlands, mesa, red sand, lava. None
// of those biomes exist on this map and no colour below hue 25 appears in any
// palette. TERRAIN_HUE_FLOOR and the palette test enforce it rather than trust.

export const TERRAIN_SEED = 0x5eed1a;
export const TERRAIN_CELL = 8;
export const TERRAIN_COLS = 150;
export const TERRAIN_ROWS = 105;
// Ground per gradebook row. This is the whole reason a 14-unit region is
// visibly bigger than a 2-unit one: area is bought with units, not assigned.
const CELLS_PER_UNIT = 40;
// Anything below this hue reads as red. Nothing in the palettes may cross it.
export const TERRAIN_HUE_FLOOR = 25;

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1274126177);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  const top = a + (b - a) * fx;
  return top + ((c + (d - c) * fx) - top) * fy;
}

// Fractal noise in [0,1]. Three octaves is enough for a coastline at this
// cell size; more just costs milliseconds nobody sees.
function fbm(x, y, seed, octaves = 3) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    value += amplitude * valueNoise(x * frequency, y * frequency, seed + i * 1013);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / norm;
}

// Biome palettes. Three shades each, light to dark, the way a Minecraft map
// shades a slope. `tree` is the canopy colour where trees are drawn, null where
// the biome has none. Every hue here is >= 25 (checked by test).
const BIOMES = {
  plains:   { name: "plains",        shades: ["#8cbb5f", "#7cab52", "#6d9a48"], tree: "#4d7a37" },
  forest:   { name: "forest",        shades: ["#5d9046", "#4f7f3c", "#436d33"], tree: "#33582a" },
  birch:    { name: "birch forest",  shades: ["#a3c47a", "#93b86a", "#82a65c"], tree: "#5f8a45" },
  meadow:   { name: "meadow",        shades: ["#9ec96a", "#8bba5c", "#7aa851"], tree: "#5c8b3f" },
  hills:    { name: "stony hills",   shades: ["#b3b8b0", "#9aa096", "#868d83"], tree: "#5b7a4c" },
  swamp:    { name: "swamp",         shades: ["#6d8a52", "#5f7a4a", "#526a3f"], tree: "#3d5c33" },
  taiga:    { name: "taiga",         shades: ["#7fa07f", "#6c8c74", "#5c7a66"], tree: "#3f6b52" },
  savanna:  { name: "savanna",       shades: ["#c4bb62", "#b3ab4e", "#a09843"], tree: "#8a9440" },
  jungle:   { name: "jungle",        shades: ["#4b8f44", "#3f7a3a", "#356831"], tree: "#2c5a2b" },
  dunes:    { name: "dunes",         shades: ["#e6d9ab", "#d8c896", "#c6b582"], tree: null },
  darkwood: { name: "dark forest",   shades: ["#4a6b3e", "#3e5b34", "#334c2b"], tree: "#2a4224" },
  tundra:   { name: "snowy tundra",  shades: ["#e7eef2", "#d3dee4", "#bccbd3"], tree: "#5e7f6b" },
  peaks:    { name: "stone peaks",   shades: ["#c3c8cc", "#a7adb2", "#8e959b"], tree: null },
  fungal:   { name: "mushroom flats",shades: ["#b5a8bd", "#a08fa8", "#8c7b94"], tree: "#7a6a86" },
};

// Which biome each territory gets, in route order, per landmass. Sem 1 reads as
// the settled home continent; Sem 2 as somewhere else entirely, so that
// "another continent" is legible before a single word is read. Neighbours in
// route order never repeat, which is what stops two adjacent territories
// merging into one green smear.
const BIOME_ORDER = {
  sem1: ["meadow", "plains", "forest", "birch", "hills", "swamp", "taiga"],
  sem2: ["dunes", "savanna", "jungle", "darkwood", "peaks", "tundra", "fungal"],
};
const BIOME_FALLBACK = ["plains", "forest", "hills", "taiga", "savanna", "jungle", "tundra"];

function biomeFor(worldId, index) {
  const order = BIOME_ORDER[worldId] ?? BIOME_FALLBACK;
  return BIOMES[order[index % order.length]] ?? BIOMES.plains;
}

const OCEAN_DEEP = "#274a72";
const OCEAN_MID = "#356089";
const OCEAN_SHALLOW = "#4a7ba8";
const SAND_LIGHT = "#e3d5a6";
const SAND_DARK = "#cfbf8d";
const RIVER = "#5a8cba";
const TRUNK = "#6b533b";
const FOG = "#122334";

// Where each landmass sits, in fractions of the grid. Sem 1 is the near
// continent; Sem 2 is across open water to the south-east, deliberately far
// enough that the two never fuse into one blob no matter how the counts move.
const LANDMASS_PLACEMENT = [
  { cx: 0.30, cy: 0.38, halfW: 0.185, halfH: 0.150 },
  { cx: 0.725, cy: 0.645, halfW: 0.185, halfH: 0.150 },
];

/**
 * Terrain geometry for a worldMap() result.
 *
 * Returns plain data — layer fills plus SVG path strings, marker positions in
 * SVG user units, and one entry per territory carrying the SAME counts the
 * region object has. The renderer draws this and adds no facts of its own.
 */
export function worldTerrain(map, options = {}) {
  const cols = options.cols ?? TERRAIN_COLS;
  const rows = options.rows ?? TERRAIN_ROWS;
  const cell = options.cell ?? TERRAIN_CELL;
  const seed = options.seed ?? TERRAIN_SEED;
  const width = cols * cell;
  const height = rows * cell;
  const empty = {
    width, height, cell, cols, rows,
    ocean: OCEAN_DEEP, layers: [], territories: [], landmasses: [], nodeEstimate: 0,
  };
  const worlds = map?.worlds ?? [];
  if (worlds.length === 0) return empty;

  // --- 1. Seed one point per territory, laid out on the same serpentine the
  // route already uses, so the map's geography and the course order agree.
  const territories = [];
  const landmasses = [];
  worlds.forEach((world, worldIndex) => {
    const place = LANDMASS_PLACEMENT[worldIndex] ?? LANDMASS_PLACEMENT[LANDMASS_PLACEMENT.length - 1];
    const bands = Math.max(1, Math.max(...world.regions.map((region) => region.row)) - world.rowStart + 1);
    const start = territories.length;
    world.regions.forEach((region, index) => {
      const band = region.row - world.rowStart;
      const u = (region.col + 0.5) / Math.max(1, map.grid?.cols ?? 4);
      const v = (band + 0.5) / bands;
      // A little seeded jitter so the territories do not read as a lattice.
      const jx = (hash2(region.number + 7, worldIndex * 31 + 3, seed) - 0.5) * 0.20;
      const jy = (hash2(region.number + 19, worldIndex * 31 + 11, seed) - 0.5) * 0.20;
      const x = (place.cx + (u - 0.5) * 2 * place.halfW + jx * place.halfW) * cols;
      const y = (place.cy + (v - 0.5) * 2 * place.halfH + jy * place.halfH) * rows;
      territories.push({
        key: region.key,
        name: region.name,
        number: region.number,
        worldId: region.worldId,
        worldIndex,
        status: region.status,
        unitsDone: region.unitsDone,
        unitsTotal: region.unitsTotal,
        // Area is bought with units: weight is sqrt(units), and a weighted
        // Voronoi cell's area goes as the square of the weight.
        weight: Math.sqrt(Math.max(1, region.unitsTotal)),
        biome: biomeFor(region.worldId, index),
        seedX: x,
        seedY: y,
        cells: [],
        cx: x * cell,
        cy: y * cell,
      });
    });
    landmasses.push({
      worldId: world.id,
      name: world.name,
      index: worldIndex,
      from: start,
      to: territories.length,
      unitsTotal: world.unitsTotal,
      unitsDone: world.unitsDone,
      targetCells: world.unitsTotal * CELLS_PER_UNIT,
    });
  });

  const size = cols * rows;
  const owner = new Int16Array(size).fill(-1);
  const massOf = new Int8Array(size).fill(-1);
  const score = new Float64Array(size);

  // --- 2. Weighted-Voronoi field. For every cell, the nearest territory once
  // distance is divided by that territory's weight, plus a noise wobble so the
  // eventual coastline is organic rather than a polygon.
  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < cols; gx += 1) {
      const i = gy * cols + gx;
      // Domain warp: the point is nudged by low-frequency noise BEFORE the
      // nearest-territory test. Without this the territory borders come out as
      // dead-straight Voronoi edges and the thing reads as a pie chart with a
      // coastline. Warping the input warps the borders and the coast together,
      // so they agree with each other.
      const wx = gx + 0.5
        + (fbm(gx * 0.052, gy * 0.049, seed + 401) - 0.5) * 22
        + (fbm(gx * 0.15, gy * 0.15, seed + 613, 2) - 0.5) * 6;
      const wy = gy + 0.5
        + (fbm(gx * 0.047 + 11.3, gy * 0.055 + 5.7, seed + 557) - 0.5) * 22
        + (fbm(gx * 0.15 + 3.1, gy * 0.15 + 9.4, seed + 787, 2) - 0.5) * 6;
      let best = Infinity;
      let bestIndex = -1;
      for (let t = 0; t < territories.length; t += 1) {
        const territory = territories[t];
        const dx = wx - territory.seedX;
        const dy = wy - territory.seedY;
        const d = Math.sqrt(dx * dx + dy * dy) / territory.weight;
        if (d < best) { best = d; bestIndex = t; }
      }
      owner[i] = bestIndex;
      massOf[i] = territories[bestIndex].worldIndex;
      const wobble = fbm(gx * 0.055, gy * 0.055, seed + 71) - 0.5;
      score[i] = best / (1 + 0.62 * wobble);
    }
  }

  // --- 3. Cut the coastline so that every territory keeps exactly the ground
  // its unit count has earned: units x CELLS_PER_UNIT cells, taken nearest-
  // first out of its own Voronoi cell. Cutting per TERRITORY rather than per
  // landmass is what makes "more units => physically larger" literally true
  // instead of approximately true — an earlier version cut one global coastline
  // per continent and a 13-unit territory came out smaller than a 12-unit one,
  // which is a lie the map is not allowed to tell.
  const land = new Uint8Array(size);
  const pools = territories.map(() => []);
  for (let i = 0; i < size; i += 1) pools[owner[i]].push(i);
  territories.forEach((territory, t) => {
    const pool = pools[t];
    pool.sort((a, b) => score[a] - score[b] || a - b);
    const quota = Math.min(pool.length, Math.round(territory.unitsTotal * CELLS_PER_UNIT));
    for (let k = 0; k < quota; k += 1) land[pool[k]] = 1;
  });
  // Quotas are taken outward from each seed, so two neighbours can leave an
  // unclaimed pocket between them. A lake in the middle of a continent reads as
  // a hole in the world, so anything water cannot reach from the map edge is
  // filled back in. Flood from the border; whatever is not reached is land.
  {
    const sea = new Uint8Array(size);
    const stack = [];
    for (let gx = 0; gx < cols; gx += 1) { stack.push(gx, (rows - 1) * cols + gx); }
    for (let gy = 0; gy < rows; gy += 1) { stack.push(gy * cols, gy * cols + cols - 1); }
    while (stack.length) {
      const i = stack.pop();
      if (sea[i] || land[i]) continue;
      sea[i] = 1;
      const gx = i % cols;
      if (gx > 0) stack.push(i - 1);
      if (gx < cols - 1) stack.push(i + 1);
      if (i >= cols) stack.push(i - cols);
      if (i < size - cols) stack.push(i + cols);
    }
    for (let i = 0; i < size; i += 1) if (!sea[i]) land[i] = 1;
  }

  // --- 4. Rivers. Ridged noise near its own midline, which reads as a channel
  // wandering across the continent instead of a drawn line.
  const river = new Uint8Array(size);
  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < cols; gx += 1) {
      const i = gy * cols + gx;
      if (!land[i]) continue;
      const n = fbm(gx * 0.042, gy * 0.042, seed + 907, 2);
      if (Math.abs(n - 0.5) < 0.016) river[i] = 1;
    }
  }

  const at = (gx, gy) => (gx < 0 || gy < 0 || gx >= cols || gy >= rows ? 0 : land[gy * cols + gx]);
  // --- 5. Beaches: land within one cell of water. One ring, so a coast reads as
  // a coast and not as a desert.
  const sand = new Uint8Array(size);
  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < cols; gx += 1) {
      const i = gy * cols + gx;
      if (!land[i]) continue;
      if (!at(gx - 1, gy) || !at(gx + 1, gy) || !at(gx, gy - 1) || !at(gx, gy + 1)
        || !at(gx - 1, gy - 1) || !at(gx + 1, gy + 1)) sand[i] = 1;
    }
  }
  // Shallows: water near land, two bands of it, which is the single cheapest
  // thing that makes an ocean look like an ocean. Built by dilating the coast
  // three cells rather than scanning a 7x7 window per cell — same picture, a
  // fifth of the work, and the work is on the machine that has to stay smooth.
  const shallow = new Uint8Array(size);
  {
    let frontier = new Uint8Array(land);
    for (let ring = 0; ring < 3; ring += 1) {
      const next = new Uint8Array(size);
      for (let gy = 0; gy < rows; gy += 1) {
        for (let gx = 0; gx < cols; gx += 1) {
          const i = gy * cols + gx;
          if (land[i] || shallow[i]) continue;
          if ((gx > 0 && frontier[i - 1]) || (gx < cols - 1 && frontier[i + 1])
            || (i >= cols && frontier[i - cols]) || (i < size - cols && frontier[i + cols])) {
            shallow[i] = ring < 2 ? 2 : 1;
            next[i] = 1;
          }
        }
      }
      frontier = next;
    }
  }

  // --- 6. Which ground is settled. Explored terrain grows outward from the
  // territory's own seed, so completing a unit LIGHTS more ground and never
  // moves ground that was already lit. `explored` count is floor of the real
  // fraction: a region with nothing done shows nothing lit, and only a region
  // that is genuinely finished is lit edge to edge.
  const explored = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) if (land[i]) territories[owner[i]].cells.push(i);
  for (const territory of territories) {
    const total = territory.cells.length;
    territory.area = total;
    const share = territory.unitsTotal > 0 ? territory.unitsDone / territory.unitsTotal : 0;
    const lit = territory.unitsDone === territory.unitsTotal && territory.unitsTotal > 0
      ? total
      : Math.floor(total * share);
    territory.lit = lit;
    if (lit <= 0) continue;
    const ranked = territory.cells.map((i) => {
      const gx = i % cols;
      const gy = (i - gx) / cols;
      const dx = gx + 0.5 - territory.seedX;
      const dy = gy + 0.5 - territory.seedY;
      const wobble = fbm(gx * 0.09, gy * 0.09, seed + 311) - 0.5;
      return { i, d: Math.sqrt(dx * dx + dy * dy) * (1 + 0.45 * wobble) };
    }).sort((a, b) => a.d - b.d || a.i - b.i);
    for (let k = 0; k < lit; k += 1) explored[ranked[k].i] = 1;
  }

  // --- 7. Bucket every cell into a colour layer, then merge horizontal runs.
  // This is the step that keeps the node count in the hundreds.
  const buckets = new Map();
  const push = (id, fill, opacity, gx, gy, run) => {
    let layer = buckets.get(id);
    if (!layer) { layer = { id, fill, opacity, parts: [] }; buckets.set(id, layer); }
    layer.parts.push(`M${gx * cell} ${gy * cell}h${run * cell}v${cell}h${-run * cell}z`);
  };

  const keyOf = new Array(size);
  for (let i = 0; i < size; i += 1) {
    const gx = i % cols;
    const gy = (i - gx) / cols;
    if (!land[i]) {
      keyOf[i] = shallow[i] === 2 ? "sea2" : shallow[i] === 1 ? "sea1" : null;
      continue;
    }
    if (river[i] && !sand[i]) { keyOf[i] = "river"; continue; }
    if (sand[i]) {
      keyOf[i] = fbm(gx * 0.3, gy * 0.3, seed + 55) > 0.5 ? "sandA" : "sandB";
      continue;
    }
    const t = owner[i];
    const n = fbm(gx * 0.26, gy * 0.26, seed + 13);
    const shade = n < 0.42 ? 2 : n < 0.60 ? 1 : 0;
    keyOf[i] = `t${t}.${shade}`;
  }

  const fillFor = (key) => {
    if (key === "sea1") return [OCEAN_MID, 1];
    if (key === "sea2") return [OCEAN_SHALLOW, 1];
    if (key === "river") return [RIVER, 1];
    if (key === "sandA") return [SAND_LIGHT, 1];
    if (key === "sandB") return [SAND_DARK, 1];
    const [t, shade] = key.slice(1).split(".");
    return [territories[Number(t)].biome.shades[Number(shade)], 1];
  };

  for (let gy = 0; gy < rows; gy += 1) {
    let gx = 0;
    while (gx < cols) {
      const key = keyOf[gy * cols + gx];
      if (key === null) { gx += 1; continue; }
      let run = 1;
      while (gx + run < cols && keyOf[gy * cols + gx + run] === key) run += 1;
      const [fill, opacity] = fillFor(key);
      push(key, fill, opacity, gx, gy, run);
      gx += run;
    }
  }

  // --- 8. Fog of the unexplored. One flat veil over every unlit land cell plus
  // a dithered second pass, which is what gives the ragged black edge of an
  // unfilled Minecraft map instead of a hard rectangle. It dims; it never
  // marks. There is no word or count of anything missed anywhere in this map.
  for (let gy = 0; gy < rows; gy += 1) {
    let gx = 0;
    while (gx < cols) {
      const i = gy * cols + gx;
      if (!land[i] || explored[i]) { gx += 1; continue; }
      let run = 1;
      while (gx + run < cols && land[i + run] && !explored[i + run]) run += 1;
      push("fog", FOG, 0.44, gx, gy, run);
      gx += run;
    }
  }
  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < cols; gx += 1) {
      const i = gy * cols + gx;
      if (!land[i] || explored[i]) continue;
      if (hash2(gx, gy, seed + 4242) < 0.34) push("fog2", FOG, 0.26, gx, gy, 1);
    }
  }

  // --- 9. Trees and peaks, on settled ground only. Unexplored ground carries no
  // detail because he has not been there yet; that is the invitation.
  const canopy = new Map();
  const trunks = [];
  const snow = [];
  for (let gy = 1; gy < rows - 1; gy += 1) {
    for (let gx = 1; gx < cols - 1; gx += 1) {
      const i = gy * cols + gx;
      if (!land[i] || !explored[i] || sand[i] || river[i]) continue;
      const territory = territories[owner[i]];
      const x = gx * cell;
      const y = gy * cell;
      if (territory.biome.tree && hash2(gx, gy, seed + 1717) < 0.11) {
        const list = canopy.get(territory.biome.tree) ?? [];
        list.push(`M${x} ${y - cell}h${cell}v${cell}h${-cell}z`);
        canopy.set(territory.biome.tree, list);
        trunks.push(`M${x + cell * 0.25} ${y}h${cell * 0.5}v${cell * 0.5}h${-cell * 0.5}z`);
      } else if (!territory.biome.tree && fbm(gx * 0.2, gy * 0.2, seed + 88) > 0.66) {
        snow.push(`M${x} ${y}h${cell}v${cell}h${-cell}z`);
      }
    }
  }

  const layers = [];
  const order = ["sea1", "sea2", "sandA", "sandB", "river"];
  for (const key of [...buckets.keys()].sort((a, b) => {
    const rank = (k) => (k === "fog" ? 90 : k === "fog2" ? 91 : order.indexOf(k) >= 0 ? order.indexOf(k) : 50);
    return rank(a) - rank(b);
  })) {
    const layer = buckets.get(key);
    layers.push({ id: key, fill: layer.fill, opacity: layer.opacity, d: layer.parts.join("") });
  }
  if (snow.length) layers.push({ id: "snow", fill: "#eef3f6", opacity: 0.85, d: snow.join("") });
  for (const [fill, parts] of canopy) {
    layers.push({ id: `tree-${fill}`, fill, opacity: 1, d: parts.join("") });
  }
  if (trunks.length) layers.push({ id: "trunk", fill: TRUNK, opacity: 0.9, d: trunks.join("") });

  // --- 10. Where the labels, landmarks and the "you are here" marker go: the
  // centre of mass of the territory's own ground, so a label never floats in
  // the sea and never leaves its own territory.
  for (const territory of territories) {
    if (territory.cells.length === 0) continue;
    let sx = 0;
    let sy = 0;
    for (const i of territory.cells) { sx += i % cols; sy += (i - (i % cols)) / cols; }
    territory.cx = ((sx / territory.cells.length) + 0.5) * cell;
    territory.cy = ((sy / territory.cells.length) + 0.5) * cell;
    territory.biomeName = territory.biome.name;
    delete territory.cells;
    delete territory.biome;
  }

  return {
    width, height, cell, cols, rows, ocean: OCEAN_DEEP,
    layers,
    territories,
    // Landmass bounds measured off the LAND ITSELF, not off the territory
    // centres. A banner hung from the average of the centres lands in the
    // middle of the continent, on top of the territory plaques; hung from the
    // northern coast it lands in open water where it can be read.
    landmasses: landmasses.map((mass) => {
      let minX = cols;
      let maxX = 0;
      let minY = rows;
      let maxY = 0;
      for (let i = 0; i < size; i += 1) {
        if (!land[i] || territories[owner[i]].worldIndex !== mass.index) continue;
        const gx = i % cols;
        const gy = (i - gx) / cols;
        if (gx < minX) minX = gx;
        if (gx > maxX) maxX = gx;
        if (gy < minY) minY = gy;
        if (gy > maxY) maxY = gy;
      }
      return {
        ...mass,
        cx: ((minX + maxX) / 2 + 0.5) * cell,
        cy: ((minY + maxY) / 2 + 0.5) * cell,
        top: minY * cell,
        bottom: (maxY + 1) * cell,
        left: minX * cell,
        right: (maxX + 1) * cell,
      };
    }),
    // Nodes the renderer will emit for terrain: one <path> per layer, plus the
    // ocean rect. Reported so the budget is measured, not assumed.
    nodeEstimate: layers.length + 1,
  };
}

// A stable fingerprint of the generated world. Two runs on the same data must
// produce the same string; that is the whole test for "the coastline does not
// reshuffle". Deliberately cheap and order-sensitive.
export function terrainSignature(terrain) {
  let h = 2166136261;
  const eat = (text) => {
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  for (const layer of terrain.layers) { eat(layer.id); eat(layer.fill); eat(layer.d); }
  for (const territory of terrain.territories) {
    eat(`${territory.key}|${Math.round(territory.cx)}|${Math.round(territory.cy)}|${territory.area}|${territory.lit}`);
  }
  return h.toString(16).padStart(8, "0");
}

// Hue of a #rrggbb colour, 0-360. Used by the palette test to prove no red,
// rather than by reading the source and hoping.
export function hexHue(hex) {
  const value = String(hex).replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null;
  const c = max - min;
  let hue;
  if (max === r) hue = ((g - b) / c) % 6;
  else if (max === g) hue = (b - r) / c + 2;
  else hue = (r - g) / c + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

export function terrainPalette() {
  const colours = [OCEAN_DEEP, OCEAN_MID, OCEAN_SHALLOW, SAND_LIGHT, SAND_DARK, RIVER, TRUNK, "#eef3f6"];
  for (const biome of Object.values(BIOMES)) {
    colours.push(...biome.shades);
    if (biome.tree) colours.push(biome.tree);
  }
  return colours;
}
