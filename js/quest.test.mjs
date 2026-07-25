import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildSchedule,
  computePace,
  computeStreak,
  evaluateUnlocks,
  questBoard,
} from "./quest.mjs";

const fixtureUrl = new URL("../../../_redcomet/data.json", import.meta.url);
const realData = JSON.parse(await readFile(fixtureUrl, "utf8"));
const referenceDay = "2026-07-24";

test("computePace matches the worked example using the real data", () => {
  const pace = computePace(realData, referenceDay);

  assert.equal(pace.daysLeft, 22);
  assert.equal(pace.rowsLeft, 72);
  assert.equal(pace.requiredPerDay, 72 / 22);
  // Pace is measured over working days, not calendar days. The old 1.7 figure
  // averaged in every day he never opened the course, which understated his speed by
  // half and projected a September finish that was both wrong and demoralising.
  assert.ok(pace.provenPerDay > 3 && pace.provenPerDay < 5,
    `expected working-day pace near 3.8, got ${pace.provenPerDay}`);
  assert.ok(pace.provenPerDay >= pace.requiredPerDay,
    "he is already fast enough on the days he works");
  assert.ok(pace.projectedFinish <= "2026-08-15",
    `working-day pace should reach the deadline, got ${pace.projectedFinish}`);
  assert.equal(pace.dailyAsk, 4);
  assert.deepEqual(Object.keys(pace), [
    "daysLeft",
    "rowsLeft",
    "requiredPerDay",
    "provenPerDay",
    "projectedFinish",
    "dailyAsk",
  ]);
});

test("buildSchedule puts all six remaining Semester 1 rows before Semester 2", () => {
  const schedule = buildSchedule(realData, referenceDay);

  assert.equal(schedule.length, 72);
  assert.deepEqual(
    schedule.slice(0, 6).map((item) => item.id),
    realData.semesters
      .find((semester) => semester.id === "sem1")
      .activities.filter((activity) => activity.state === "not_started")
      .sort(
        (left, right) =>
          left.sectionNumber - right.sectionNumber ||
          left.rowIndex - right.rowIndex,
      )
      .map((activity) => activity.id),
  );
  assert.ok(schedule.slice(0, 6).every((item) => item.id.startsWith("sem1:")));
  assert.ok(schedule.slice(6).every((item) => item.id.startsWith("sem2:")));
  assert.deepEqual(
    schedule.slice(0, 5).map((item) => item.ourTarget),
    [
      "2026-07-24",
      "2026-07-24",
      "2026-07-24",
      "2026-07-24",
      "2026-07-25",
    ],
  );
});

test("questBoard returns exactly three capped days from the schedule", () => {
  const board = questBoard(realData, referenceDay);
  const schedule = buildSchedule(realData, referenceDay);

  assert.equal(board.length, 3);
  assert.deepEqual(
    board.map((day) => day.date),
    ["2026-07-24", "2026-07-25", "2026-07-26"],
  );
  assert.ok(board.every((day) => day.items.length <= 4));
  assert.deepEqual(
    board.flatMap((day) => day.items.map((item) => item.id)),
    schedule.slice(0, 12).map((item) => item.id),
  );
});

test("computeStreak treats a Tuesday 1am submission as Monday in Los Angeles", () => {
  const history = [
    {
      timestamp: "2026-07-27T05:00:00-07:00",
      state: "submitted_ungraded",
    },
    {
      timestamp: "2026-07-28T01:00:00-07:00",
      state: "graded",
    },
  ];

  assert.equal(computeStreak(history, "2026-07-28T02:00:00-07:00"), 1);
});

test("evaluateUnlocks counts submissions and never revokes an earned artifact", () => {
  const progressed = structuredClone(realData);
  const firstThree = progressed.semesters
    .find((semester) => semester.id === "sem2")
    .activities.slice(0, 3);
  for (const activity of firstThree) {
    activity.state = "submitted_ungraded";
    activity.submittedDate = "2026-07-25";
  }

  const earned = evaluateUnlocks(progressed, new Set());
  assert.ok(earned.has("first-contact"));
  assert.ok(earned.has("momentum"));
  assert.ok(earned.has("ignition"));

  const regressed = structuredClone(realData);
  const afterRegression = evaluateUnlocks(regressed, earned);
  assert.deepEqual(afterRegression, earned);
  assert.notEqual(afterRegression, earned);
});

test("dailyAsk remains capped at four when the required pace is higher", () => {
  const data = structuredClone(realData);
  data.deadline.date = "2026-07-25";

  const pace = computePace(data, referenceDay);

  assert.equal(pace.requiredPerDay, 72);
  assert.equal(pace.dailyAsk, 4);
});

test("derived results never expose deficit labels or mutate input data", () => {
  const before = JSON.stringify(realData);
  const outputs = [
    computePace(realData, referenceDay),
    buildSchedule(realData, referenceDay),
    questBoard(realData, referenceDay),
  ];

  assert.equal(JSON.stringify(realData), before);
  assert.doesNotMatch(
    JSON.stringify(outputs),
    /behind|late|overdue/i,
  );
});
