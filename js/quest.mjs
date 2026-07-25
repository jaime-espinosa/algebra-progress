const DAY_MS = 24 * 60 * 60 * 1000;
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const PROVEN_PACE_SEED = 1.7;
const REWARD_START_DATE = "2026-07-24";

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
  return { perDay, activeDays, submitted, activePace, showUpRate, rowsLeft,
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

function isSubmitted(activity) {
  return (
    activity.state === "submitted_ungraded" || activity.state === "graded"
  );
}

function allSubmitted(activities) {
  return activities.length > 0 && activities.every(isSubmitted);
}

export function evaluateUnlocks(data, earnedSet) {
  const unlocked = new Set(earnedSet ?? []);
  const semesters = data.semesters ?? [];
  const allActivities = semesters.flatMap(
    (semester) => semester.activities ?? [],
  );
  const sem1Activities =
    semesters.find((semester) => semester.id === "sem1")?.activities ?? [];
  const sem2Activities =
    semesters.find((semester) => semester.id === "sem2")?.activities ?? [];
  const newSubmissions = allActivities.filter(
    (activity) =>
      isSubmitted(activity) &&
      typeof activity.submittedDate === "string" &&
      activity.submittedDate > REWARD_START_DATE,
  );

  if (newSubmissions.length >= 1) unlocked.add("first-contact");
  if (newSubmissions.length >= 3) unlocked.add("momentum");
  if (allSubmitted(sem1Activities)) unlocked.add("sem1-sealed");
  if (sem2Activities.filter(isSubmitted).length >= 3) unlocked.add("ignition");

  const sectionMilestones = new Map([
    [1, "exponential"],
    [2, "ballistics"],
    [3, "marksman"],
    [4, "surveyor"],
    [5, "engineer"],
    [6, "analyst"],
  ]);
  for (const [sectionNumber, artifactId] of sectionMilestones) {
    const sectionActivities = sem2Activities.filter(
      (activity) => activity.sectionNumber === sectionNumber,
    );
    if (allSubmitted(sectionActivities)) unlocked.add(artifactId);
  }

  if (allSubmitted(allActivities)) unlocked.add("full-clear");

  return unlocked;
}
