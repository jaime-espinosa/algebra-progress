// Tests for the code labs.
//
// The point of these is NOT that the runtime has functions in it. It is that the code
// Mark actually sees in the editor computes the right algebra. So each test pulls the
// starter program straight out of the lab's HTML, runs it against stub drawing
// functions, and checks the numbers it produced against the maths done by hand.
//
// If someone edits a lab and breaks the maths, this fails. A lab that draws the wrong
// parabola teaches him something false, which is worse than shipping nothing.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { guardLoops, describeNumber, sandboxDocument } from "./lab-runtime.mjs";

const labsDir = path.dirname(fileURLToPath(import.meta.url));

async function starterOf(file) {
  const html = await readFile(path.join(labsDir, file), "utf8");
  const match = html.match(
    /<script type="text\/plain" id="starter-code">([\s\S]*?)<\/script>/,
  );
  assert.ok(match, `${file} must carry a starter program`);
  return match[1];
}

// Runs a starter program with recording stubs in place of the drawing API.
function runStarter(code) {
  const record = { plots: [], points: [], pointLists: [], pictures: [], said: [] };
  const graph = (xMin, xMax, yMin, yMax) => {
    record.window = { xMin, xMax, yMin, yMax };
    const api = {
      plot(fn, label) {
        record.plots.push({ fn, label });
        return api;
      },
      point(x, y, label) {
        record.points.push({ x, y, label });
        return api;
      },
      points(list, label) {
        record.pointLists.push({ list, label });
        return api;
      },
    };
    return api;
  };
  const picture = (xMin, xMax, yMin, yMax, fn, maxSteps) => {
    record.pictures.push({ xMin, xMax, yMin, yMax, fn, maxSteps });
    return { width: 240, height: 160, insidePercent: 0 };
  };
  const say = (...values) => record.said.push(values);
  const tick = () => true;
  const program = new Function("graph", "picture", "say", "__tick", `"use strict";\n${guardLoops(code)}`);
  program(graph, picture, say, tick);
  return record;
}

test("sem1-05: the line is y = mx + b and the marked points sit on it", async () => {
  const run = runStarter(await starterOf("sem1-05-line.html"));
  assert.equal(run.plots.length, 1);
  const line = run.plots[0].fn;
  // Starter values are m = 2, b = -3.
  assert.equal(line(0), -3);
  assert.equal(line(1), -1);
  assert.equal(line(4), 5);
  // Slope is the change in y per single step in x, at any x.
  assert.equal(line(1) - line(0), 2);
  assert.equal(line(101) - line(100), 2);
  // (0, b) and (1, m + b) are marked, and both are genuinely on the line.
  const marks = run.points.map((point) => [point.x, point.y]);
  assert.deepEqual(marks, [[0, -3], [1, -1]]);
  for (const [x, y] of marks) assert.equal(line(x), y);
});

test("sem1-03: the solved crossing satisfies both equations", async () => {
  const run = runStarter(await starterOf("sem1-03-crossing.html"));
  assert.equal(run.plots.length, 2);
  const [lineA, lineB] = run.plots.map((entry) => entry.fn);
  assert.equal(run.points.length, 1);
  const { x, y } = run.points[0];
  // y = 2x - 3 and y = -x + 3 meet at (2, 1).
  assert.equal(x, 2);
  assert.equal(y, 1);
  // The real test: the point the code found is on BOTH lines.
  assert.equal(lineA(x), y);
  assert.equal(lineB(x), y);
  assert.notEqual(lineA(x + 1), lineB(x + 1));
});

test("sem1-03: parallel and identical lines fall out of the same formula", async () => {
  const starter = await starterOf("sem1-03-crossing.html");
  const parallel = runStarter(starter.replace("let m2 = -1;", "let m2 = 2;"));
  assert.equal(parallel.points[0].x, Infinity, "parallel lines: no solution");
  const identical = runStarter(
    starter.replace("let m2 = -1;", "let m2 = 2;").replace("let b2 = 3;", "let b2 = -3;"),
  );
  assert.ok(Number.isNaN(identical.points[0].x), "same line twice: every point solves it");
});

test("sem2-02: roots, vertex and discriminant match the quadratic formula", async () => {
  const run = runStarter(await starterOf("sem2-02-parabola.html"));
  const q = run.plots[0].fn;
  // a = 1, b = -2, c = -3  ->  (x - 3)(x + 1)
  assert.equal(q(0), -3);
  assert.equal(q(3), 0);
  assert.equal(q(-1), 0);
  assert.equal(q(1), -4);
  const labelled = Object.fromEntries(run.points.map((p) => [p.label + p.x, p]));
  const vertex = run.points.find((point) => point.label === "vertex");
  assert.deepEqual([vertex.x, vertex.y], [1, -4]);
  assert.equal(q(vertex.x), vertex.y);
  const roots = run.points.filter((point) => point.label === "root").map((point) => point.x);
  assert.deepEqual(roots.slice().sort((a, b) => a - b), [-1, 3]);
  for (const root of roots) assert.equal(q(root), 0);
  assert.ok(labelled !== undefined);
  const discLine = run.said.find((line) => String(line[0]).startsWith("discriminant"));
  assert.equal(discLine[1], 16);
  // The vertex is the minimum for a positive a: nothing beats it either side.
  assert.ok(q(vertex.x - 0.5) > vertex.y && q(vertex.x + 0.5) > vertex.y);
});

test("sem2-02: a negative discriminant draws no root at all", async () => {
  const starter = await starterOf("sem2-02-parabola.html");
  const run = runStarter(starter.replace("let c = -3;", "let c = 5;"));
  const q = run.plots[0].fn;
  assert.equal(run.points.filter((point) => point.label === "root").length, 0);
  // b^2 - 4ac = 4 - 20 = -16, and the curve stays above the axis everywhere.
  for (let x = -20; x <= 20; x += 0.5) assert.ok(q(x) > 0);
});

test("sem2-02: one root sits exactly under the vertex when the discriminant is zero", async () => {
  const starter = await starterOf("sem2-02-parabola.html");
  const run = runStarter(starter.replace("let c = -3;", "let c = 1;"));
  const single = run.points.filter((point) => point.label === "one root");
  assert.equal(single.length, 1);
  assert.deepEqual([single[0].x, single[0].y], [1, 0]);
});

test("sem2-01: the exponential overtakes the line on day 3", async () => {
  const run = runStarter(await starterOf("sem2-01-doubling.html"));
  const [linear, exponential] = run.plots.map((entry) => entry.fn);
  assert.equal(linear(0), 4);
  assert.equal(linear(10), 64);
  assert.equal(exponential(0), 4);
  assert.equal(exponential(1), 8);
  assert.equal(exponential(10), 4096);
  const overtaken = run.points[0];
  assert.equal(overtaken.x, 3);
  assert.equal(overtaken.y, 32);
  // Day 3 is genuinely the FIRST whole day in front: day 2 is a tie, day 3 is ahead.
  assert.ok(exponential(2) <= linear(2));
  assert.ok(exponential(3) > linear(3));
});

test("sem2-03: z -> z^2 + c behaves as the Mandelbrot set requires", async () => {
  const run = runStarter(await starterOf("sem2-03-mandelbrot.html"));
  assert.equal(run.pictures.length, 1);
  const { fn: escapeSteps, maxSteps, xMin, xMax } = run.pictures[0];
  assert.equal(maxSteps, 60);
  assert.ok(xMin < -2 && xMax > 0.25, "the window must contain the whole set");

  // Points known to be IN the set never escape, so they burn every step.
  for (const [cx, cy] of [[0, 0], [-1, 0], [-0.5, 0.5], [0.25, 0], [-2, 0], [0, 1]]) {
    assert.equal(escapeSteps(cx, cy), 60, `c = (${cx}, ${cy}) is in the set`);
  }
  // Points known to be OUT escape, and the further out, the faster.
  assert.ok(escapeSteps(0.5, 0) < 60);
  assert.ok(escapeSteps(-2.1, 0) < 60);
  assert.ok(escapeSteps(3, 3) < escapeSteps(0.5, 0));
  assert.equal(escapeSteps(3, 3), 1);

  // The number-line half: with c = -1 the orbit is 0, -1, 0, -1, ... forever.
  const values = run.said.map((line) => line[3]);
  assert.deepEqual(values, [-1, 0, -1, 0, -1, 0]);
});

test("sem2-03: the cube rule from the challenge is still the same shape of program", async () => {
  const starter = await starterOf("sem2-03-mandelbrot.html");
  const cubed = starter
    .replace("const nextX = x * x - y * y + cx;", "const nextX = x ** 3 - 3 * x * y * y + cx;")
    .replace("const nextY = 2 * x * y + cy;", "const nextY = 3 * x * x * y - y ** 3 + cy;");
  const run = runStarter(cubed);
  const escapeSteps = run.pictures[0].fn;
  assert.equal(escapeSteps(0, 0), 60);
  // z -> z^3 + c is bounded at c = -1 on the real line too, and 1.5 runs away.
  assert.equal(escapeSteps(-1, 0), 60);
  assert.ok(escapeSteps(1.5, 0) < 60);
});

test("guardLoops rewrites loops it should and leaves alone the ones it should not", () => {
  assert.match(guardLoops("while (true) {}"), /while\s*\(__tick\(\) && \(true\)\)/);
  assert.match(guardLoops("for (let i = 0; i < 3; i += 1) {}"), /__tick\(\) && \(i < 3\)/);
  assert.match(guardLoops("for (;;) {}"), /for\s*\(; __tick\(\);\)/);
  // A "while" inside a string or a comment is not a loop.
  assert.equal(guardLoops('say("while (true) forever");'), 'say("while (true) forever");');
  assert.equal(guardLoops("// while (true)\nlet a = 1;"), "// while (true)\nlet a = 1;");
  assert.equal(guardLoops("/* for (;;) */ let a = 1;"), "/* for (;;) */ let a = 1;");
  // Identifiers that merely contain the keyword must survive untouched.
  assert.equal(guardLoops("const forecast = (1);"), "const forecast = (1);");
  assert.equal(guardLoops("meanwhile (1);"), "meanwhile (1);");
  // for..of has no top-level semicolons; it is left alone rather than corrupted.
  assert.equal(guardLoops("for (const a of list) {}"), "for (const a of list) {}");
  // do/while is guarded through its condition.
  assert.match(guardLoops("do { z += 1; } while (z < 5);"), /while\s*\(__tick\(\) && \(z < 5\)\)/);
});

test("guarded loops still compute the same answers", () => {
  const source = `
    let total = 0;
    for (let i = 1; i <= 10; i += 1) { total += i; }
    let n = 0;
    while (total > 0) { total -= 10; n += 1; }
    say(total, n);
  `;
  const seen = [];
  new Function("say", "__tick", guardLoops(source))((...args) => seen.push(args), () => true);
  assert.deepEqual(seen, [[-5, 6]]);
});

test("an endless loop throws a plain-English error instead of hanging", () => {
  const guarded = guardLoops("let i = 0;\nwhile (true) { i += 1; }");
  let ticks = 0;
  const tick = () => {
    ticks += 1;
    if (ticks > 5000) {
      throw new Error("Stopped after 2000ms. Nothing is broken — a loop in this program never finishes.");
    }
    return true;
  };
  assert.throws(
    () => new Function("__tick", guarded)(tick),
    (error) => {
      assert.match(error.message, /Nothing is broken/);
      assert.doesNotMatch(error.message, /error|fail|invalid/i);
      return true;
    },
  );
});

test("describeNumber stays short and honest", () => {
  assert.equal(describeNumber(3), "3");
  assert.equal(describeNumber(-4), "-4");
  assert.equal(describeNumber(1 / 3), "0.333");
  assert.equal(describeNumber(2 ** 40), "1.100e+12");
  assert.equal(describeNumber(Infinity), "Infinity");
  assert.equal(describeNumber(NaN), "NaN");
});

test("the sandbox document runs code in an isolated frame and reaches no network", () => {
  const document = sandboxDocument();
  assert.match(document, /function guardLoops/);
  assert.match(document, /function sandboxBoot/);
  for (const forbidden of ["fetch(", "XMLHttpRequest", "http://", "https://", "import("]) {
    assert.ok(!document.includes(forbidden), `sandbox must not contain ${forbidden}`);
  }
});

test("every lab page is self-contained, sandboxed and free of dated claims", async () => {
  const files = (await readdir(labsDir)).filter((name) => name.endsWith(".html"));
  assert.ok(files.length >= 5, "expected the labs to be present");
  for (const file of files) {
    const html = await readFile(path.join(labsDir, file), "utf8");
    assert.ok(!/https?:\/\//.test(html), `${file} must not reference the network`);
    assert.ok(!/<img/i.test(html), `${file} must not need an image asset`);
    assert.match(html, /id="starter-code"/, `${file} needs pre-loaded working code`);
    assert.match(html, /mountLab\(\)/, `${file} must mount the lab runtime`);
    assert.match(html, /id="run"/, `${file} needs a Run button`);
    assert.match(html, /aria-live="polite"/, `${file} needs a live text description`);
    assert.ok(!/20(2[7-9]|[3-9]\d)/.test(html), `${file} must not name a date past Aug 15 2026`);
  }
  const runtime = await readFile(path.join(labsDir, "lab-runtime.mjs"), "utf8");
  assert.match(runtime, /sandbox", "allow-scripts"/);
  assert.ok(!runtime.includes("allow-same-origin"), "the frame must stay cross-origin");
});

// Hue check. "No red anywhere" is a hard rule, so it is enforced by arithmetic rather
// than by eye: every colour these pages can paint is converted to HSL and must sit
// outside the red wedge, or be grey enough that it has no hue to speak of.
function hueOf(hex) {
  const value = hex.length === 4
    ? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
    : [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r, g, b] = value.map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (delta === 0) return { hue: 0, saturation: 0 };
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, saturation };
}

test("no colour anywhere in the labs is red", async () => {
  const files = (await readdir(labsDir)).filter((name) => /\.(html|css|mjs)$/.test(name));
  const offenders = [];
  for (const file of files) {
    const text = await readFile(path.join(labsDir, file), "utf8");
    for (const match of text.matchAll(/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g)) {
      const { hue, saturation } = hueOf(match[0]);
      // Amber (~42 degrees) is fine. Anything with real colour below 25 degrees or
      // above 330 is in the red wedge and must not appear.
      if (saturation > 0.15 && (hue < 25 || hue > 330)) {
        offenders.push(`${file}: ${match[0]} (hue ${Math.round(hue)})`);
      }
    }
  }
  assert.deepEqual(offenders, [], "red is not allowed anywhere");
});

test("the pixel palette never enters the red wedge either", async () => {
  // shade() interpolates between four stops; walk the whole ramp, not just the stops.
  const stops = [
    [0.0, [18, 48, 90]],
    [0.35, [31, 138, 122]],
    [0.7, [111, 220, 130]],
    [1.0, [242, 193, 78]],
  ];
  const shade = (t) => {
    const clamped = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i += 1) {
      if (clamped <= stops[i][0]) {
        const span = stops[i][0] - stops[i - 1][0];
        const k = span === 0 ? 0 : (clamped - stops[i - 1][0]) / span;
        return [0, 1, 2].map((c) =>
          Math.round(stops[i - 1][1][c] + (stops[i][1][c] - stops[i - 1][1][c]) * k));
      }
    }
    return stops[stops.length - 1][1];
  };
  const runtime = await readFile(path.join(labsDir, "lab-runtime.mjs"), "utf8");
  for (const stop of stops) {
    assert.ok(runtime.includes(`[${stop[0]}, [${stop[1].join(", ")}]]`),
      `the tested ramp must match the shipped one: ${stop}`);
  }
  for (let step = 0; step <= 1000; step += 1) {
    const [r, g, b] = shade(step / 1000);
    const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    const { hue, saturation } = hueOf(hex);
    assert.ok(saturation <= 0.15 || (hue >= 25 && hue <= 330),
      `palette at ${step / 1000} is ${hex} (hue ${Math.round(hue)})`);
  }
});
