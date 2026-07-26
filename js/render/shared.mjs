import { effortStats as questEffort, worldMap, worldTerrain, regionHorizon, UNIT_TYPE_LABELS, UNIT_TYPE_PLURALS } from "../quest.mjs";

// Shared render helpers, extracted verbatim from app.js.
//
// Every function here is state-free and DOM-free: none reads or writes a module-scope
// `let`, none touches document/window/localStorage, and the set is closed under calls —
// nothing in this file calls anything outside it. That is why the move is safe, and it is
// the property to preserve. A helper that needs page state belongs in app.js, not here.

export const DAY_MS = 86_400_000;

export const ZONE = "America/Los_Angeles";

// Must match the crontab entry in _redcomet/cron-refresh.sh (0 8,15,21 * * *).
// This previously returned 14:00/06:00, which was simply not when the scraper runs,
// so the header told him a time that was never true.
export const SCRAPE_HOURS = [8, 15, 21];

// ---- World map ------------------------------------------------------------
// This panel replaced the trophy wall. The two were the same picture drawn
// twice: a grid of tiles saying "this much is done". The map says the same
// thing and also says WHERE, WHAT IS IN IT, and WHAT IS AT THE END OF IT, so
// keeping both would have left two progress visuals arguing about the same
// work. Everything the trophy wall carried that was not the tile grid — the
// headline percent, the sections sealed, the grade so far, the countdown to
// sealing Semester 1 — is on the World I header below, and nothing else of it
// survives.
//
// WHICH DENOMINATOR LEADS, and why. A request came in to "lie that we are past
// 50% so he doesn't get unmotivated". The fabrication was declined — nothing on
// this page may be a number he cannot check — but the point underneath it was
// real. 46% was never more true than 93%: it is the same work, counted against
// the most discouraging denominator available. So World I leads: Semester 1 is
// the nearest real finish line he has, and it is the first thing on the page.
//
// THE UNIT IS THE GRADEBOOK ROW AND ONLY THE GRADEBOOK ROW. Every block, every
// count, every percent in here comes off worldMap() in quest.mjs, which counts
// rows. That makes the map reconcile by hand with the effort dials (62 done,
// 71 left, 133 total), the quest board and the calendar. The trophy wall used
// allDone/allTotal — LMS *activities*, 105 in Semester 1 against 67 rows — and
// had to print a disclaimer beside every figure to stop the two reading as an
// arithmetic error. Rows removed the need for the disclaimer. If you ever put
// an activities figure back on this page, it must say "activities" out loud.
//
// There is no count of missed, late or overdue work anywhere in here, and
// lmsDue is deliberately never rendered: most of those dates are in the past
// and would turn an inviting map into a list of things he is behind on.
// "Unexplored" is the strongest word used about ground he has not reached.
export const REGION_STATE_COPY = {
  settled: "settled",
  here: "you are here",
  started: "in progress",
  ahead: "unexplored"
};

export const WORLD_NUMERAL = ["", "I", "II", "III"];

// Which colour each kind of work is drawn in, everywhere on the map: the
// bands inside a node, the icons over it, and the legend below it. Literal
// values rather than theme tokens, so the map cannot inherit a colour from a
// theme and quietly break the no-red rule. Every hue here is 40 or above.
export const TYPE_INK = {
  lesson: "#f0c86a",
  quiz: "#79c0a4",
  activity: "#a89ad6",
  check: "#c8b48a",
  test: "#ffd67a",
  orientation: "#9fb6c4",
};

export const TYPE_EMPTY = "#31414e";

// The one-off kinds of work, as small blocky icons in a row along the top of
// the node. Jaime's rule, and it applies to ANY kind with exactly one row in
// the section rather than only to tests — in this curriculum that is reliably
// the end-of-section assignment and the section test, and occasionally a lone
// activity or quiz. One row would be a band two pixels tall, which is noise;
// as an icon it is a thing you can actually see the state of.
//
// Filled and bright when done, hollow and quiet when not. Never crossed out,
// never padlocked, never marked.
export const ICON_GLYPH = {
  // chest: lid band over a body
  check: (x, y, ink) => `<path class="wm-icon wm-icon-check" fill="${ink}" d="M${x - 5} ${y - 4}h10v3h-10zm0 4h10v5h-10z"/>`,
  // sword: blade over a crossguard
  test: (x, y, ink) => `<path class="wm-icon wm-icon-test" fill="${ink}" d="M${x - 1} ${y - 5}h3v9h-3zm-3 6h9v3h-9z"/>`,
  // scroll: two stacked bars
  quiz: (x, y, ink) => `<path class="wm-icon wm-icon-quiz" fill="${ink}" d="M${x - 5} ${y - 4}h10v3h-10zm0 5h10v3h-10z"/>`,
  // block: a solid square
  lesson: (x, y, ink) => `<path class="wm-icon wm-icon-lesson" fill="${ink}" d="M${x - 4} ${y - 4}h9v9h-9z"/>`,
  // diamond, stepped so it stays blocky
  activity: (x, y, ink) => `<path class="wm-icon wm-icon-activity" fill="${ink}" d="M${x - 1} ${y - 5}h3v2h-3zm-3 2h9v3h-9zm-2 3h13v3h-13zm3 3h7v2h-7z"/>`,
  orientation: (x, y, ink) => `<path class="wm-icon wm-icon-orientation" fill="${ink}" d="M${x - 3} ${y - 3}h7v7h-7z"/>`,
};

// ---- Shared chart geometry ------------------------------------------------
// The per-day chart and the cumulative chart are one picture in two SVGs. They
// share the x domain (planTrack's points: first working day through Aug 15),
// the viewBox width, and both side margins, so day N is the same pixel on
// both. Aligning them by eye is what he asked us not to do — if you change a
// number here it changes in both charts or in neither.
export const CHART = { width: 760, left: 58, right: 46 };

// The plot box of each chart, in viewBox units, exported because the today
// marker outside the SVGs has to land on the GRID and not on the label gutters
// above and below it. Both SVGs are drawn `width: 100%; height: auto` off these
// viewBoxes, so an inset of `top` viewBox units is always `top / CHART.width`
// of the SVG's rendered WIDTH — which is what lets CSS place the marker exactly
// at any viewport size without measuring anything.
export const DAY_PLOT = { height: 196, top: 20, bottom: 148 };
export const CUM_PLOT = { height: 200, top: 36, bottom: 150 };

export const GAME_KIND_FACES = {
  game: {
    ink: "#7cab52",
    head: "M2 2h20v20H2z",
    face: "M6 7h4v4H6zm8 0h4v4h-4zm-6 5h8v3h2v5h-4v-3h-4v3H6v-5h2z",
  },
  puzzle: {
    ink: "#d7b45c",
    head: "M4 2h16v3h3v14h-3v3H4v-3H1V5h3z",
    face: "M6 7h4v3H6zm8 0h4v3h-4zm-4 4h5v3h3v3h-8v-2H7v-3h3z",
  },
  tool: {
    ink: "#79c0a4",
    head: "M1 5h4V2h14v3h4v15h-4v2H5v-2H1z",
    face: "M6 7h4v4H6zm8 0h4v4h-4zM8 15h8v3H8z",
  },
  video: {
    ink: "#a89ad6",
    head: "M5 2h14v3h3v17H2V5h3z",
    face: "M7 7h3v4H7zm7 0h3v4h-3zM8 15h8v3H8z",
  },
};

  export function artifact(id, name, tier, minVersion, maxVersion, loader, files, testedOn) {
    return { id, name, tier, minVersion, maxVersion, loader, files, testedOn };
  }

  export function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
  }

  export function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  export function localIsoDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  export function parseIsoDate(value) {
    return new Date(`${value}T12:00:00-07:00`);
  }

  export function dateDiff(from, to) {
    return Math.ceil((parseIsoDate(to) - parseIsoDate(from)) / DAY_MS);
  }

  export function addDays(value, count) {
    const date = parseIsoDate(value);
    date.setUTCDate(date.getUTCDate() + count);
    return date.toISOString().slice(0, 10);
  }

  export function formatDay(value, options = {}) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE,
      month: "short",
      day: "numeric",
      ...options
    }).format(parseIsoDate(value));
  }

  export function formatTime(value) {
    if (!value) return "unknown";
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return "unknown";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  export function nextScrapeTime(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE, hour: "numeric", hour12: false
    }).formatToParts(now);
    const hour = Number(parts.find(item => item.type === "hour")?.value ?? 0);
    const next = SCRAPE_HOURS.find(h => h > hour) ?? SCRAPE_HOURS[0];
    return `${String(next).padStart(2, "0")}:00`;
  }

  export function summarySnapshot(data) {
    return Object.fromEntries(data.semesters.map(semester => [
      semester.id,
      {
        gradableDone: semester.gradableDone,
        allDone: semester.allDone,
        // Units, so the map's reveal can tell new blocks from ones he has
        // already looked at. allDone counts a different list and would hold
        // back the wrong number of blocks.
        rowsDone: (semester.activities ?? []).filter(item => item.state !== "not_started").length,
        percent: semester.percent
      }
    ]));
  }

  export function snapshotsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  export function remainingActivities(data) {
    const sem1 = data.semesters.find(semester => semester.id === "sem1");
    const semesterOrder = sem1?.activities.some(item => item.state === "not_started")
      ? ["sem1", "sem2"]
      : ["sem2", "sem1"];
    return data.semesters
      .flatMap(semester => semester.activities
        .filter(item => item.state === "not_started" && typeof item.ourTarget === "string")
        .map(item => ({ ...item, semesterId: semester.id, semesterName: semester.name })))
      .sort((left, right) =>
        semesterOrder.indexOf(left.semesterId) - semesterOrder.indexOf(right.semesterId) ||
        left.sectionNumber - right.sectionNumber ||
        left.rowIndex - right.rowIndex);
  }

  // "Since we started tracking" comes from the data itself rather than a hardcoded
  // date pasted into the source, which would silently rot.
  export function rewardBaseline(data) {
    return data.rewardBaseline || data.generatedAt?.slice(0, 10) || localIsoDate();
  }

  export function submittedAfterBaseline(data) {
    const baseline = rewardBaseline(data);
    return data.semesters.flatMap(semester => semester.activities).filter(item =>
      item.state !== "not_started" &&
      typeof item.submittedDate === "string" &&
      item.submittedDate > baseline);
  }

  // Both of these delegate to js/quest.mjs, which is the tested single source of
  // truth. app.js previously carried its own divergent copy, so the effort panel
  // rendered 3.8/day while the pace panel directly below it rendered 1.7/day.
  export function submissionsByDay(data) {
    const stats = questEffort(data, localIsoDate());
    return stats.perDay;
  }

  export function effortStats(data, today) {
    const stats = questEffort(data, today);
    return { ...stats, remaining: stats.rowsLeft, likelihood: stats.onTrack };
  }

  export function todayCompleted(data, today) {
    return data.semesters.flatMap(semester => semester.activities).filter(item =>
      item.state !== "not_started" && item.submittedDate === today).length;
  }

  export function landmarkGlyph(item, earned) {
    return `<span class="wm-landmark${earned ? " is-earned" : ""}" title="${escapeHtml(
      earned ? `${item.name} — earned` : `${item.name} — unlocks here`)}">
      <span class="wm-landmark__post" aria-hidden="true"></span>
      <span class="wm-landmark__flag" aria-hidden="true"></span>
    </span>`;
  }

  // ---- Drawing the world ----------------------------------------------------
  // The terrain is inline SVG: DOM nodes, no canvas, no WebGL, no image files.
  // worldTerrain() in quest.mjs hands back one <path> per colour — the whole
  // 150x105 cell world arrives as a few dozen nodes rather than fifteen
  // thousand, which is the only reason a 2018 machine can pan it.
  //
  // Nothing in this function computes a fact. Every number that reaches the
  // screen comes off the region objects worldMap() built. The terrain decides
  // where the green goes; it never decides how much is done.
  export function terrainSvg(terrain) {
    const layers = terrain.layers.map(layer =>
      `<path fill="${layer.fill}"${layer.opacity < 1 ? ` opacity="${layer.opacity}"` : ""} d="${layer.d}"/>`
    ).join("");
    return `<svg class="wm-terrain" viewBox="0 0 ${terrain.width} ${terrain.height}"
      width="${terrain.width}" height="${terrain.height}" aria-hidden="true" focusable="false"
      shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
      <rect width="${terrain.width}" height="${terrain.height}" fill="${terrain.ocean}"/>
      ${layers}</svg>`;
  }

  // A landmark is a little structure standing on the ground where the unlock
  // gate says it lands. Earned ones get a lit roof; the rest are outposts
  // waiting to be built. Multiple landmarks in one territory are fanned out so
  // they read as a settlement rather than one building drawn three times.
  export function landmarkStructure(x, y, earned, index) {
    const dx = x + (index - 0.5) * 22;
    const roof = earned ? "#d7b45c" : "#7e8892";
    const wall = earned ? "#b9a37e" : "#6d757d";
    return `<g class="wm-mark${earned ? " is-earned" : ""}">
      <path fill="#1d2830" opacity=".45" d="M${dx - 9} ${y + 2}h18v4h-18z"/>
      <path fill="${wall}" d="M${dx - 6} ${y - 12}h12v14h-12z"/>
      <path fill="${roof}" d="M${dx - 8} ${y - 18}h16v6h-16z"/>
      <path fill="#2c3a44" d="M${dx - 2} ${y - 6}h4v8h-4z"/>
    </g>`;
  }

  // "You are here": a planted flag on the ground of the section that holds his
  // next unit, with a beacon column behind it so it is findable from across the
  // map without zooming. It is a position, not a score.
  // The beacon column that says "he is over there" from anywhere on the map.
  // Ambience only — it lives in the terrain overlay, under the nodes.
  export function hereMarker(x, y) {
    return `<g class="wm-you">
      <path class="wm-you__beam" fill="#ffd67a" d="M${x - 8} ${y - 260}h16v260h-16z"/>
      <path class="wm-you__beam" fill="#fff2cf" opacity=".55" d="M${x - 3} ${y - 260}h6v260h-6z"/>
      <path fill="#1d2830" opacity=".5" d="M${x - 13} ${y - 2}h26v5h-26z"/>
    </g>`;
  }

  // The planted flag. It is drawn INSIDE the node's own svg rather than out in
  // the terrain overlay, because the overlay sits under the name plaques and
  // the flag kept ending up behind the neighbouring section's sign. Here it is
  // part of the control it belongs to, so it can never be covered by anything
  // except by moving the node itself. It overflows the svg box upward, which
  // .wm-node allows on purpose.
  export function hereFlag(x, y) {
    // The banner flies LEFT, away from the node, so it never sits over the
    // node's own icon row or bands.
    const bar = (w, top) => `M${x - 2 - w} ${top}h${w}v9h-${w}z`;
    return `<g class="wm-flag">
      <path fill="#16202a" opacity=".5" d="M${x - 5} ${y - 1}h10v4h-10z"/>
      <path fill="#e8dcc0" d="M${x - 2} ${y - 54}h4v55h-4z"/>
      <path fill="#3b6ea8" d="${bar(30, y - 54)}${bar(25, y - 45)}${bar(19, y - 36)}"/>
      <path fill="#8fc4e8" d="M${x - 32} ${y - 54}h30v3h-30z"/>
      <path fill="#e8dcc0" d="M${x - 4} ${y - 58}h8v5h-8z"/>
    </g>`;
  }

  // A compass rose in open water. Blocky, four-pointed, no filigree — it is
  // there so the map reads as a map, and it carries no information at all.
  export function compassRose(x, y) {
    return `<g class="wm-compass" opacity=".55">
      <path fill="#9fc0d8" d="M${x - 3} ${y - 34}h6v68h-6zM${x - 34} ${y - 3}h68v6h-68z"/>
      <path fill="#e3eef6" d="M${x - 5} ${y - 34}h10v12h-10z"/>
      <path fill="#cfe0ec" d="M${x - 8} ${y - 8}h16v16h-16z"/>
      <path fill="#24405c" d="M${x - 4} ${y - 4}h8v8h-8z"/>
    </g>`;
  }

  // The node's insides: one horizontal band per kind of work that has more than
  // one row in this section, each band as tall as that kind is numerous, filled
  // left-to-right by how much of it is done.
  //
  // A kind with exactly ONE row does not get a band — a single row would be a
  // sliver two pixels tall that reads as noise. It gets an icon over the node
  // instead, which is Jaime's rule and it lands exactly on the two kinds that
  // are always one-per-section: the end-of-section assignment and the section
  // test. A kind with no rows in this section is drawn as nothing at all rather
  // than as an empty band, so the node never implies work that does not exist.
  export function nodeBands(region, x, y, size) {
    let bands = region.types.filter((entry) => entry.total > 1);
    // A section made entirely of one-offs — Orientation is two single rows —
    // would otherwise draw a blank node. It falls back to one band for the
    // section as a whole, which is the same number in the same place, never an
    // empty box that reads as "nothing here".
    if (!bands.length) {
      bands = [{ type: "orientation", total: region.unitsTotal, done: region.unitsDone }];
    }
    const totalRows = bands.reduce((sum, entry) => sum + entry.total, 0);
    const inner = size - 8;
    let cursor = y - inner / 2;
    const out = [];
    bands.forEach((entry, index) => {
      // Last band absorbs the rounding so the stack always fills the node
      // exactly and never leaves a one-pixel gap at the bottom.
      const height = index === bands.length - 1
        ? (y + inner / 2) - cursor
        : Math.max(3, Math.round((entry.total / totalRows) * inner));
      const width = inner * (entry.done / entry.total);
      out.push(`<path fill="${TYPE_EMPTY}" d="M${x - inner / 2} ${r1(cursor)}h${inner}v${r1(height)}h-${inner}z"/>`);
      if (width > 0.5) {
        out.push(`<path fill="${TYPE_INK[entry.type]}" d="M${x - inner / 2} ${r1(cursor)}h${
          r1(width)}v${r1(height)}h-${r1(width)}z"/>`);
      }
      cursor += height;
    });
    return out.join("");
  }

  export function r1(value) {
    return Math.round(value * 10) / 10;
  }

  export function nodeIcons(region, x, y, size) {
    const singles = region.types.filter((entry) => entry.total === 1);
    if (!singles.length) return "";
    const box = 15;
    const row = singles.length * box;
    let cursor = x - row / 2 + box / 2;
    const top = y - size / 2 - 11;
    const out = [];
    for (const entry of singles) {
      const ink = entry.done ? TYPE_INK[entry.type] : "#66727d";
      out.push(`<path fill="#16202a" opacity=".78" d="M${cursor - 7} ${top - 7}h14v14h-14z"/>`);
      out.push((ICON_GLYPH[entry.type] ?? ICON_GLYPH.orientation)(cursor, top, ink));
      cursor += box;
    }
    return out.join("");
  }

  export function mapLegendGlyph(kind, body, viewBox = "0 0 24 24") {
    return `<svg class="wm-key__glyph" data-glyph="${kind}" viewBox="${viewBox}"
      aria-hidden="true" focusable="false" shape-rendering="crispEdges">${body}</svg>`;
  }

  // The key calls the same drawing functions as the map. That makes these true
  // samples rather than lookalike squares that can drift from the actual glyphs.
  export function mapLegend(terrain) {
    const node = {
      types: [
        { type: "lesson", total: 3, done: 2 },
        { type: "quiz", total: 2, done: 1 },
        { type: "activity", total: 2, done: 1 },
      ],
      unitsDone: 4,
      unitsTotal: 7,
    };
    const fog = terrain.layers.find(layer => layer.id === "fog0.7")
      ?? terrain.layers.find(layer => layer.id.startsWith("fog"));
    const ground = terrain.layers.find(layer => layer.id === "t1.1")
      ?? terrain.layers.find(layer => layer.id.startsWith("t"));
    const fogBody = `
      <rect x="2" y="2" width="20" height="20" fill="${ground?.fill ?? "#7cab52"}"/>
      <rect x="2" y="2" width="20" height="20" fill="${fog?.fill ?? "#122334"}"
        opacity="${fog?.opacity ?? 0.55}"/>`;
    const nodeBody = `
      <path class="wm-node__frame" d="M2 2h20v20h-20z"/>
      ${nodeBands(node, 12, 12, 20)}`;
    return `<div class="wm-key quiet">
      <span>${mapLegendGlyph("route",
        '<path class="wm-route is-walked" d="M1 12h22"/>')} the road, in section order</span>
      <span>${mapLegendGlyph("node", nodeBody)}
        node bands — lessons, practice quizzes and activities; dark space is still to do</span>
      <span>${mapLegendGlyph("chest", ICON_GLYPH.check(12, 12, TYPE_INK.check))}
        chest — the end-of-section assignment</span>
      <span>${mapLegendGlyph("sword", ICON_GLYPH.test(12, 12, TYPE_INK.test))}
        sword — the section test</span>
      <span>${mapLegendGlyph("scroll", ICON_GLYPH.quiz(12, 12, TYPE_INK.quiz))}
        scroll — a practice quiz</span>
      <span>${mapLegendGlyph("gem", ICON_GLYPH.activity(12, 12, TYPE_INK.activity))}
        gem — an activity</span>
      <span>${mapLegendGlyph("marker", ICON_GLYPH.orientation(12, 12, TYPE_INK.orientation))}
        marker — the orientation</span>
      <span>${mapLegendGlyph("settled",
        `<rect x="2" y="2" width="20" height="20" fill="${ground?.fill ?? "#7cab52"}"/>`)}
        settled ground</span>
      <span>${mapLegendGlyph("fog", fogBody)}
        haze — not discovered yet, and worth going to see</span>
      <span>${mapLegendGlyph("water",
        `<rect x="2" y="2" width="20" height="20" fill="${terrain.ocean}"/>`)}
        ocean</span>
      <span>${mapLegendGlyph("flag", hereFlag(20, 60), "0 0 42 64")}
        the flag — you are here</span>
      <span>${mapLegendGlyph("landmark", landmarkStructure(12, 20, true, 0.5))}
        a landmark stands or unlocks here</span>
    </div>`;
  }

  // A node on the route. This is the focusable control — a real <button> in the
  // DOM over the SVG, carrying the section's own counts AND its work-type
  // breakdown AND how far off it is in its accessible name, so everything the
  // fill and the haze say out loud is also said in words. The map is never a
  // picture a screen reader cannot read.
  export function territoryPlaque(region, spot) {
    const state = REGION_STATE_COPY[region.status] ?? "";
    const horizon = regionHorizon(region);
    const grade = region.grade === null ? "" : `, section grade ${region.grade.toFixed(1)}%`;
    const breakdown = region.types
      .filter((entry) => entry.total > 0)
      .map((entry) => `${entry.done} of ${entry.total} ${
        entry.total === 1 ? UNIT_TYPE_LABELS[entry.type] : UNIT_TYPE_PLURALS[entry.type]}`)
      .join(", ");
    // Distance is stated as discovery, never as a lock. A section he has not
    // reached is somewhere he has not been yet, and that is all it is.
    const where = region.ahead === 0 ? "" : `, ${region.discovery}`;
    const label = `${region.name}. ${region.unitsDone} of ${region.unitsTotal} units placed: ${
      breakdown}. ${state}${where}${grade}. Zoom in.`;
    const childSummary = region.status === "settled"
      ? `${region.unitsDone} done`
      : horizon.remainingCount !== null
        ? `${horizon.remainingCount} to finish`
        : horizon.nextTasks[0]
          ? `Next: ${horizon.nextTasks[0]}`
          : state;
    const size = 34;
    // The box is tight to the node and the icon row above it is allowed to
    // overflow (.wm-node is overflow:visible), so the button's layout box stays
    // the size of the node itself and the name plaque sits right under it.
    const node = `<svg class="wm-node" width="${size + 6}" height="${size + 6}"
      viewBox="${-size / 2 - 3} ${-size / 2 - 3} ${size + 6} ${size + 6}"
      aria-hidden="true" focusable="false" shape-rendering="crispEdges">
      <path fill="#16202a" opacity=".5" d="M${-size / 2 - 2} ${-size / 2 - 2}h${size + 4}v${size + 4}h-${size + 4}z"/>
      <path class="wm-node__frame" d="M${-size / 2} ${-size / 2}h${size}v${size}h-${size}z"/>
      ${nodeBands(region, 0, 0, size)}
      ${nodeIcons(region, 0, 0, size)}
      ${region.status === "here" ? hereFlag(-size / 2 - 7, size / 2 - 2) : ""}
    </svg>`;
    return `
      <button type="button" class="wm-region is-${region.status}" data-region="${escapeHtml(region.key)}"
        data-ahead="${region.ahead}" style="left:${spot.cx}px;top:${spot.cy}px"
        aria-label="${escapeHtml(label)}">
        ${node}
        <span class="wm-region__plaque" aria-hidden="true">
          <span class="wm-region__name">${escapeHtml(region.name)}</span>
          <span class="wm-region__count">${escapeHtml(childSummary)}</span>
        </span>
      </button>`;
  }

  // The dashed road threading the sections in the order he actually does them.
  // Road behind him is solid and settled; road ahead is faint. The sea leg
  // between the two semesters gets a longer dash — a crossing, not a walk.
  export function routePaths(route) {
    const all = [...route.crossings, ...route.legs];
    // Every leg is drawn twice: a dark casing underneath, then the dash on top.
    // Without the casing the road vanishes over pale sand and snow, which is
    // exactly where it crosses most often. Two passes over thirteen legs is 26
    // paths — cheap, and it is what makes the road actually readable.
    const casing = all.map((entry) =>
      `<path class="wm-route__casing" d="${entry.d}"/>`).join("");
    const ink = all.map((entry) => `<path class="wm-route${entry.walked ? " is-walked" : ""}${
      entry.sea ? " is-sea" : ""}" d="${entry.d}"/>`).join("");
    return casing + ink;
  }

  // The banner naming a landmass, pinned above its northern coast.
  export function landmassBanner(world, mass) {
    const numeral = WORLD_NUMERAL[world.index] ?? String(world.index);
    const here = world.regions.find(region => region.status === "here");
    const nextTasks = here ? regionHorizon(here).nextTasks : [];
    const state = world.sealed
      ? "SEALED"
      : world.holdsNext
        ? "YOU BUILT THIS"
        : world.unitsDone > 0
          ? "UNDER WAY"
          : "NEWLY SIGHTED";
    // The banner is also the way into the world record. It is a button rather
    // than a card above the map because the map is the only thing in this panel
    // now: the trigger lives on the landmass it describes. Its own text is the
    // label a sighted reader gets, so the accessible name is stated in full
    // here and the decorative innards are left to the aria-label to summarise.
    return `<button type="button" class="wm-banner" data-world-card="${escapeHtml(world.id)}"
      style="left:${mass.cx}px;top:${Math.max(6, mass.top - 58)}px"
      aria-haspopup="dialog" aria-controls="wm-world-popup-${escapeHtml(world.id)}"
      aria-expanded="false"
      aria-label="${escapeHtml(world.name)}, world ${numeral}, ${state.toLowerCase()}, ${
        world.unitsDone} units placed. Open the world record.">
      <span class="eyebrow" aria-hidden="true">WORLD ${numeral} // ${state}</span>
      <span class="wm-banner__name" aria-hidden="true">${escapeHtml(world.name)}</span>
      <span class="numeric quiet" aria-hidden="true">${world.unitsDone} units placed</span>
      ${nextTasks.length
        ? `<span class="wm-banner__next" aria-hidden="true">Next: ${nextTasks.map(escapeHtml).join(" · ")}</span>`
        : ""}
    </button>`;
  }

  // The one-line standing of a world, as an eyebrow. It heads the world record
  // dialog; the same wording is built inline by landmassBanner for the banner
  // that opens that dialog.
  export function worldEyebrow(world) {
    const numeral = WORLD_NUMERAL[world.index] ?? String(world.index);
    return world.sealed
      ? `WORLD ${numeral} // SEALED`
      : world.holdsNext
        ? `WORLD ${numeral} // YOU BUILT THIS`
        : world.unitsDone > 0
          ? `WORLD ${numeral} // UNDER WAY`
          : `WORLD ${numeral} // NEWLY SIGHTED CONTINENT`;
  }

  export function renderWorldPopup(world, landmarks) {
    const near = world.sealed
      ? `${escapeHtml(world.name)} is sealed. Every unit in it is submitted.`
      : `${world.unitsLeft} unit${world.unitsLeft === 1 ? "" : "s"} from sealing ${escapeHtml(world.name)}.`;
    const grade = world.grade === null
      ? ""
      : `<span class="quiet numeric">Grade so far ${world.grade.toFixed(1)}%${
          world.letter ? ` · ${escapeHtml(world.letter)}` : ""}</span>`;
    const standing = landmarks.filter(entry => entry.earned);
    return `
      <dialog class="wm-world-popup" id="wm-world-popup-${escapeHtml(world.id)}"
        aria-labelledby="wm-world-popup-title-${escapeHtml(world.id)}">
        <button type="button" class="wm-world-popup__close" data-world-close
          aria-label="Close ${escapeHtml(world.name)} world record">×</button>
        <span class="eyebrow">${escapeHtml(worldEyebrow(world))}</span>
        <h3 class="wm-world__name" id="wm-world-popup-title-${escapeHtml(world.id)}">${escapeHtml(world.name)}</h3>
        <strong class="big-number numeric">${world.unitsDone}<span class="wm-world__of"> of ${world.unitsTotal} units placed</span></strong>
        <span class="numeric">${world.percent}% · ${world.regionsSettled} of ${world.regionsTotal} regions settled</span>
        <strong class="wm-world__near">${near}</strong>
        ${grade}
        ${standing.length ? `<span class="wm-world__standing quiet">${standing.length} landmark${
          standing.length === 1 ? "" : "s"} already standing here: ${escapeHtml(
            standing.map(entry => entry.artifact.name).join(", "))}</span>` : ""}
      </dialog>`;
  }

  // The text equivalent. The map is decoration over real counts, so the counts
  // have to exist as text somewhere a screen reader and a keyboard can reach
  // without hunting across a picture. Every row here is read straight off the
  // region object — same source as the plaques, so the two cannot disagree.
  export function renderTerritoryTable(map) {
    // Every band and every icon the node draws, written out. A sighted reader
    // gets the breakdown from the fill; this is the same breakdown in words, so
    // nothing on this map is available only as a picture. The haze is here too,
    // as the discovery column, because fog that hides information from
    // assistive tech is fog that has hidden information.
    const cell = (region, type) => {
      const entry = region.types.find((item) => item.type === type);
      return entry && entry.total > 0 ? `${entry.done}/${entry.total}` : "—";
    };
    const rows = map.worlds.flatMap(world => world.regions.map(region => `
      <tr>
        <th scope="row">${escapeHtml(world.name)} · ${escapeHtml(region.name)}</th>
        <td class="numeric">${region.unitsDone}/${region.unitsTotal}</td>
        <td class="numeric">${cell(region, "lesson")}</td>
        <td class="numeric">${cell(region, "quiz")}</td>
        <td class="numeric">${cell(region, "activity")}</td>
        <td class="numeric">${cell(region, "check")}</td>
        <td class="numeric">${cell(region, "test")}</td>
        <td class="numeric">${cell(region, "orientation")}</td>
        <td>${escapeHtml(REGION_STATE_COPY[region.status] ?? "")}</td>
        <td>${escapeHtml(region.discovery ?? "")}</td>
      </tr>`).join("")).join("");
    return `
      <details class="wm-text">
        <summary>Section list, as text</summary>
        <table class="wm-text__table">
          <caption class="quiet">A dash means that section has none of that kind of work.</caption>
          <thead><tr><th scope="col">Section</th><th scope="col">Units</th>
            <th scope="col">Lessons</th><th scope="col">Practice quizzes</th>
            <th scope="col">Activities</th><th scope="col">End-of-section</th>
            <th scope="col">Section test</th><th scope="col">Orientation</th>
            <th scope="col">State</th><th scope="col">Discovery</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`;
  }

  // ---- Level 2: inside one region ------------------------------------------
  // Same rows, told as places rather than as a gradebook. A row whose title says
  // quiz or test is a battle; everything else is training. That split is made in
  // quest.mjs (activityKind) and tested, so this only draws it.
  //
  // A battle he has finished is CLEARED. A battle ahead is WAITING FOR YOU. There
  // is no wording anywhere for a battle he skipped, because there is no count of
  // missed work on this page and there is not going to be one.
  export function unitNode(unit, index) {
    const classes = ["wm-node", unit.kind === "battle" ? "is-battle" : "is-training"];
    if (unit.done) classes.push("is-done");
    if (unit.isNext) classes.push("is-next");
    const state = unit.kind === "battle"
      ? (unit.done ? "cleared" : unit.isNext ? "next battle" : "waiting for you")
      : (unit.done ? "trained" : unit.isNext ? "next" : "not yet");
    const score = unit.done && unit.score && Number.isFinite(unit.score.percent)
      ? `<span class="wm-node__score numeric quiet">${unit.score.percent}%</span>`
      : "";
    const when = unit.submittedDate
      ? `<span class="wm-node__when quiet numeric">${escapeHtml(formatDay(unit.submittedDate))}</span>`
      : "";
    return `
      <li class="${classes.join(" ")}">
        <span class="wm-node__glyph" aria-hidden="true"></span>
        <span class="wm-node__step numeric quiet" aria-hidden="true">${index + 1}</span>
        <span class="wm-node__title">${escapeHtml(unit.title)}</span>
        <span class="wm-node__state">${escapeHtml(state)}</span>
        ${score}${when}
      </li>`;
  }

  export function spriteSvg(index, earned) {
    const fill = earned ? "var(--accent)" : "var(--gap)";
    const dim = earned ? "var(--accent-dim)" : "var(--line)";
    const pattern = index % 3;
    if (pattern === 0) {
      return `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="${dim}" d="M3 2h10v12H3z"/><path fill="${fill}" d="M5 4h6v2H9v2h2v4H5V9h2V6H5z"/></svg>`;
    }
    if (pattern === 1) {
      return `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="${dim}" d="M2 5h12v8H2z"/><path fill="${fill}" d="M4 3h8v8H4z"/><path fill="var(--panel-solid)" d="M6 5h1v2H6zm3 0h1v2H9z"/></svg>`;
    }
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="${dim}" d="M7 1h2v5h4v2h-2v2H9v5H7v-5H5V8H3V6h4z"/><path fill="${fill}" d="M7 2h2v6H7z"/></svg>`;
  }

  export function validSkinCache(value) {
    return value &&
      typeof value.name === "string" &&
      typeof value.fetchedAt === "string" &&
      typeof value.dataUrl === "string" &&
      /^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i.test(value.dataUrl)
      ? value
      : null;
  }

  export function skinPlaceholderSvg() {
    return `
      <svg viewBox="0 0 8 8" aria-hidden="true">
        <path fill="var(--dim)" d="M1 1h6v6H1z"></path>
        <path fill="var(--panel-solid)" d="M2 2h4v1H2zm0 3h1v1H2zm3 0h1v1H5z"></path>
        <path fill="var(--accent)" d="M2 4h1v1H2zm3 0h1v1H5z"></path>
        <path fill="var(--line)" d="M3 6h2v1H3z"></path>
      </svg>`;
  }

  export function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result));
      reader.addEventListener("error", () => reject(reader.error || new Error("Skin file could not be read.")));
      reader.readAsDataURL(blob);
    });
  }

  export function gaugePoint(fraction, radius) {
    const angle = (135 + Math.max(0, Math.min(1, fraction)) * 270) * Math.PI / 180;
    return {
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius
    };
  }

  export function gaugeArc(from, to, radius = 38) {
    const start = gaugePoint(from, radius);
    const end = gaugePoint(to, radius);
    const largeArc = (to - from) * 270 > 180 ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  }

  // A tooltip carries HOW a number is computed, never WHAT it is. Anything a
  // reading means has to be legible with the pointer nowhere near it. Opens on
  // hover, on tap, and on keyboard focus, so a trackpad, a touchscreen and Tab
  // all reach it; the text is in the DOM at all times, so a screen reader does
  // too.
  export function tip(text) {
    return `<span class="tip" tabindex="0"><span class="tip__mark" aria-hidden="true">?</span><span class="tip__body" role="note">${escapeHtml(text)}</span></span>`;
  }

  // The two numbers at the ends of the arc sit either side of the digital
  // window at the bottom, so they are anchored AWAY from it: a three-digit
  // end label centred on the arc would have its inner half swallowed.
  export function gaugeText(at, radius, text, className, endAware = false) {
    const point = gaugePoint(at, radius);
    const anchor = !endAware ? "middle" : at <= 0.001 ? "end" : at >= 0.999 ? "start" : "middle";
    return `<text class="${className}" x="${point.x.toFixed(2)}" y="${point.y.toFixed(2)}"
      text-anchor="${anchor}" dominant-baseline="central">${escapeHtml(text)}</text>`;
  }

  export function chartX(track, index) {
    const last = Math.max(1, track.points.length - 1);
    return CHART.left + (index / last) * (CHART.width - CHART.left - CHART.right);
  }

  export function chartDayTicks(track) {
    const last = track.points.length - 1;
    const ticks = [];
    track.points.forEach((point, index) => {
      if (new Date(`${point.date}T12:00:00Z`).getUTCDay() === 5) {
        ticks.push({ index: Math.min(last, index + 17 / 24), date: point.date });
      }
    });
    return ticks;
  }

  export function chartDayAxis(track, y, labelY) {
    return chartDayTicks(track).map(({ index, date }, order) => {
      const x = chartX(track, index).toFixed(1);
      return `
        <g class="chart-friday-tick${order % 2 ? " chart-friday-tick--minor" : ""}" data-friday="${date}">
          <line class="chart-axis__tick" x1="${x}" y1="${y}" x2="${x}" y2="${y + 4}"></line>
          <text class="chart-label" x="${x}" y="${labelY}" text-anchor="middle">${escapeHtml(formatDay(date))}</text>
        </g>`;
    }).join("");
  }

  export function chartFridayGrid(track, top, bottom) {
    return chartDayTicks(track).map(({ index, date }) => {
      const x = chartX(track, index).toFixed(1);
      return `<line class="chart-grid chart-grid--friday" data-friday="${date}"
        x1="${x}" y1="${top}" x2="${x}" y2="${bottom}"></line>`;
    }).join("");
  }

  export function chartLegend(stats, series, track) {
    return `
      <div class="chart-legend numeric" role="group" aria-label="Chart legend and totals">
        <strong class="chart-legend__total">${stats.odometer} units submitted</strong>
        <span class="chart-legend__secondary">${stats.rowsLeft} remaining · ${stats.totalRows} total units</span>
        ${series?.totalSeconds ? `<strong class="chart-legend__total">${escapeHtml(series.totalText)} total · time the course page was open</strong>` : ""}
        <span><b class="chart-key__swatch is-units"></b>units/day and ${stats.requiredPerDay.toFixed(2)}/day reference</span>
        <span><b class="chart-key__swatch is-open"></b>hours open</span>
        <span><b class="chart-key__swatch is-actual"></b>cumulative units submitted</span>
        <span><b class="chart-key__swatch is-steady"></b>steady route</span>
        <span><b class="chart-key__swatch is-adjusted"></b>same line dotted past today: plan to ${escapeHtml(formatDay(track.finishesOn))}</span>
      </div>`;
  }

  // ---- Per-day chart --------------------------------------------------------
  // Two series on one x-axis, and they are deliberately NOT combined into a
  // rate. The right-hand line is the LMS's own clock on how long the course page
  // was open; nothing logs him out, so Jul 24 reads 10h 19m against one unit,
  // and 10h 8m of it is a single entry that started at 12:07 AM. Dividing one
  // series by the other produces "619 minutes per unit", which is false and is
  // the exact discouraging message this page exists to undo. Flagged days are
  // drawn hollow and say so on hover, so a spike reads as a tab left open.
  export function perDayChart(track, perDay, requiredPerDay, series) {
    const { height, top, bottom } = DAY_PLOT;
    const past = track.points.map((point, index) => ({ point, index })).filter(({ point }) => !point.future);
    const values = past.map(({ point }) => perDay.get(point.date) ?? 0);
    const maxDaily = Math.max(1, ...values, Math.ceil(requiredPerDay));
    const yAt = value => bottom - (value / maxDaily) * (bottom - top);
    const unitPoints = past.map(({ index }, order) =>
      `${chartX(track, index).toFixed(1)},${yAt(values[order]).toFixed(1)}`).join(" ");
    const unitDots = past.map(({ point, index }, order) => values[order] > 0
      ? `<rect class="chart-unit__dot" x="${(chartX(track, index) - 2).toFixed(1)}" y="${(yAt(values[order]) - 2).toFixed(1)}" width="4" height="4">
          <title>${escapeHtml(`${formatDay(point.date)}: ${values[order]} ${values[order] === 1 ? "unit" : "units"} submitted`)}</title>
        </rect>`
      : "").join("");
    const yTicks = Array.from({ length: 4 }, (_, index) => {
      const value = Math.round(maxDaily * index / 3);
      const y = yAt(value).toFixed(1);
      return `
        <line class="chart-grid" x1="${CHART.left}" y1="${y}" x2="${CHART.width - CHART.right}" y2="${y}"></line>
        <text class="chart-label chart-label--unit" x="${CHART.left - 8}" y="${(Number(y) + 3).toFixed(1)}" text-anchor="end">${value}</text>`;
    }).join("");
    const requiredY = yAt(Math.min(requiredPerDay, maxDaily));

    // Open time, on its own axis, in its own hours.
    let openAxis = "";
    let openSeries = "";
    let openFlags = "";
    if (series && series.maxSeconds > 0) {
      const maxHours = Math.max(1, Math.ceil(series.maxSeconds / 3600));
      const openY = seconds => bottom - (seconds / (maxHours * 3600)) * (bottom - top);
      const withOpen = past.filter(({ point }) => series.byDay.has(point.date));
      openSeries = `<polyline class="chart-open" points="${withOpen
        .map(({ point, index }) => `${chartX(track, index).toFixed(1)},${openY(series.byDay.get(point.date).seconds).toFixed(1)}`)
        .join(" ")}"></polyline>`;
      openFlags = withOpen.map(({ point, index }) => {
        const day = series.byDay.get(point.date);
        const x = chartX(track, index);
        const y = openY(day.seconds);
        const stretch = day.longestStretch;
        // The fact, and nothing after it. This used to end with "Nothing logs you out, so
        // a tab left open keeps counting" — an explanation of our own bookkeeping, on a
        // page that is his, not ours.
        const why = day.marked
          ? `${formatDay(point.date)}: the course page was open ${day.text}${stretch
            ? `, including one unbroken ${stretch.text}${stretch.startTime ? ` from ${stretch.startTime}` : ""}` : ""}`
          : `${formatDay(point.date)}: the course page was open ${day.text}`;
        const shape = day.marked
          ? `<polygon class="chart-open__flag" points="${x.toFixed(1)},${(y - 5).toFixed(1)} ${(x + 5).toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${(y + 5).toFixed(1)} ${(x - 5).toFixed(1)},${y.toFixed(1)}"></polygon>`
          : `<circle class="chart-open__dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2"></circle>`;
        return `<g>${shape}<title>${escapeHtml(why)}</title></g>`;
      }).join("");
      const right = CHART.width - CHART.right;
      openAxis = `
        <line class="chart-axis chart-axis--open" x1="${right}" y1="${top}" x2="${right}" y2="${bottom}"></line>
        ${[0, Math.round(maxHours / 2), maxHours].map(hours => `
          <text class="chart-label chart-label--open" x="${right + 6}" y="${(openY(hours * 3600) + 3).toFixed(1)}"
            text-anchor="start">${hours}h</text>`).join("")}
        <text class="chart-axis-title chart-axis-title--open" x="${right + 40}" y="${(top + bottom) / 2}"
          text-anchor="middle" transform="rotate(90 ${right + 40} ${(top + bottom) / 2})">hours open</text>`;
    }

    return `
      <div class="chart-block">
        <svg viewBox="0 0 ${CHART.width} ${height}" preserveAspectRatio="xMidYMid meet" role="img"
          aria-label="${escapeHtml(`Units submitted per calendar day from ${formatDay(track.firstDay)} through ${formatDay(track.deadline)}, with a reference line at ${requiredPerDay.toFixed(2)} units per day. A second line on the right axis shows how long the course page was open each day, in hours; ${series ? series.markedDays : 0} days are flagged as a tab left open.`)}">
          ${yTicks}
          ${chartFridayGrid(track, top, bottom)}
          <line class="chart-axis" x1="${CHART.left}" y1="${top}" x2="${CHART.left}" y2="${bottom}"></line>
          <line class="chart-axis" x1="${CHART.left}" y1="${bottom}" x2="${CHART.width - CHART.right}" y2="${bottom}"></line>
          ${openAxis}
          <text class="chart-axis-title chart-axis-title--unit" x="14" y="${(top + bottom) / 2}"
            text-anchor="middle" transform="rotate(-90 14 ${(top + bottom) / 2})">units/day</text>
          <line class="chart-reference" x1="${CHART.left}" y1="${requiredY.toFixed(1)}"
            x2="${CHART.width - CHART.right}" y2="${requiredY.toFixed(1)}"
            ><title>${escapeHtml(`${requiredPerDay.toFixed(2)} units a day is what finishing on time needs`)}</title></line>
          ${openSeries}
          <polyline class="chart-unit" points="${unitPoints}"></polyline>
          ${unitDots}
          ${openFlags}
          ${chartDayAxis(track, bottom, bottom + 20)}
        </svg>
      </div>`;
  }

  // ---- Cumulative chart -----------------------------------------------------
  // Moved under the dials, on the per-day chart's own x-scale, so the two read
  // as one picture: a bar on the day chart and the step it produces on this one
  // sit on the same vertical.
  // `milestones` and `overall` are optional: the chart drew nothing but the staircase
  // before them, and it still does if they are not passed. Nothing here recomputes a
  // grade — every percent arrives already true from quest.mjs.
  export function cumulativeChart(track, milestones = [], overall = null) {
    // CUM_PLOT.top is 36 rather than 24: the section labels sit in this margin on two
    // rows, and at 24 the upper row's glyphs were clipped by the top of the SVG. The plot
    // loses 12 units of height, which the day chart above does not share and does not need
    // to — only the x scale has to match between the two, and that is untouched.
    const { height, top, bottom } = CUM_PLOT;
    const yMax = Math.max(1, track.totalRows);
    const yAt = value => top + (1 - value / yMax) * (bottom - top);
    const pointList = (points, valueFor) => points
      .map(({ point, index }) => `${chartX(track, index).toFixed(1)},${yAt(valueFor(point)).toFixed(1)}`)
      .join(" ");
    const indexed = track.points.map((point, index) => ({ point, index }));
    const past = indexed.filter(({ point }) => !point.future);
    const adjusted = indexed.filter(({ point }) => point.adjusted !== null);
    const ticks = [...new Set([0, Math.round(track.totalRows / 2), track.totalRows])];
    const grid = ticks.map(value => {
      const y = yAt(value).toFixed(1);
      return `
        <line class="chart-grid" x1="${CHART.left}" y1="${y}" x2="${CHART.width - CHART.right}" y2="${y}"></line>
        <text class="chart-label chart-label--done" x="${CHART.left - 8}" y="${Number(y) + 4}" text-anchor="end">${escapeHtml(value)}</text>`;
    }).join("");
    // ---- Sections closed out, and what each scored ---------------------------
    // Two things on one x-axis, both anchored to the day the section's last unit
    // landed: a tick with the section's short name along the top, and its grade
    // read against a percent scale on the right. Points only, no line — a line
    // between section grades would imply a trend across four numbers that are not
    // a series, and it would be the third line on this chart.
    const indexOf = day => track.points.findIndex(point => point.date === day);
    const marks = milestones
      .map(milestone => ({ milestone, index: indexOf(milestone.finishedOn) }))
      .filter(({ index }) => index >= 0);
    const gradeAt = percent => top + (1 - Math.min(100, Math.max(0, percent)) / 100) * (bottom - top);
    const rightX = CHART.width - CHART.right;

    const gradeAxis = marks.length === 0 ? "" : `
      <line class="chart-axis chart-axis--grade" x1="${rightX}" y1="${top}" x2="${rightX}" y2="${bottom}"></line>
      ${[0, 50, 100].map(percent => `
        <text class="chart-label chart-label--grade" x="${rightX + 6}" y="${(gradeAt(percent) + 3).toFixed(1)}"
          text-anchor="start">${percent}%</text>`).join("")}
      <text class="chart-axis-title chart-axis-title--grade" x="${rightX + 40}" y="${(top + bottom) / 2}"
        text-anchor="middle" transform="rotate(90 ${rightX + 40} ${(top + bottom) / 2})">grade</text>`;

    // Two sections finished a day apart put their labels 12px apart on a 760-wide
    // viewBox, and a label is about 28px wide, so they overlapped into mush. Anything
    // landing within a label's width of the one before it goes up a row instead.
    let lastLabelX = -Infinity;
    let lastLabelRow = 1;
    const sectionMarks = marks.map(({ milestone, index }) => {
      const at = chartX(track, index);
      const row = at - lastLabelX < 30 && lastLabelRow === 1 ? 0 : 1;
      lastLabelX = at;
      lastLabelRow = row;
      const labelY = row === 1 ? top - 6 : top - 20;
      const x = at.toFixed(1);
      const why = `${milestone.name} — last unit in it submitted ${formatDay(milestone.finishedOn)}${
        milestone.grade === null ? "" : `, section grade ${milestone.grade.toFixed(1)}%`}`;
      const dot = milestone.grade === null ? "" : `
        <circle class="chart-grade-dot" cx="${x}" cy="${gradeAt(milestone.grade).toFixed(1)}" r="3"></circle>`;
      return `
        <g class="chart-milestone">
          <line class="chart-milestone__stem" x1="${x}" y1="${top}" x2="${x}" y2="${bottom}"></line>
          <text class="chart-milestone__label" x="${x}" y="${labelY}" text-anchor="middle">${escapeHtml(milestone.label)}</text>
          ${dot}
          <title>${escapeHtml(why)}</title>
        </g>`;
    }).join("");

    // The overall grade sits on the same right-hand scale at today, drawn hollow so it
    // reads as the running figure rather than as a fifth section.
    const overallMark = overall === null || marks.length === 0 ? "" : (() => {
      const index = indexOf(track.today);
      if (index < 0) return "";
      return `
        <g class="chart-grade-overall">
          <circle class="chart-grade-dot is-overall" cx="${chartX(track, index).toFixed(1)}"
            cy="${gradeAt(overall).toFixed(1)}" r="4"></circle>
          <title>${escapeHtml(`Grade across everything graded so far: ${overall.toFixed(1)}%`)}</title>
        </g>`;
    })();

    const gradeSaid = marks.length === 0 ? "" : ` Sections finished so far are marked along the top and scored against a percent scale on the right, as points only: ${
      marks.filter(({ milestone }) => milestone.grade !== null)
        .map(({ milestone }) => `${milestone.name} finished ${formatDay(milestone.finishedOn)} at ${milestone.grade.toFixed(1)}%`)
        .join("; ")}${overall === null ? "" : `. Across everything graded so far: ${overall.toFixed(1)}%`}.`;
    const ariaLabel = `Cumulative units done from ${formatDay(track.firstDay)} through ${formatDay(track.deadline)}, on the same Friday-at-5-PM day scale as the chart above. The solid line is what you have actually submitted; past today the same line continues dotted as the plan, which finishes all ${track.totalRows} units by ${formatDay(track.finishesOn)}; a separate long-dashed line is the steady route.${gradeSaid}`;

    return `
      <div class="chart-block">
        <svg viewBox="0 0 ${CHART.width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(ariaLabel)}">
          ${grid}
          ${chartFridayGrid(track, top, bottom)}
          <line class="chart-axis" x1="${CHART.left}" y1="${top}" x2="${CHART.left}" y2="${bottom}"></line>
          <line class="chart-axis" x1="${CHART.left}" y1="${bottom}" x2="${CHART.width - CHART.right}" y2="${bottom}"></line>
          <text class="chart-axis-title chart-axis-title--done" x="14" y="${(top + bottom) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(top + bottom) / 2})">units done</text>
          ${gradeAxis}
          ${sectionMarks}
          <polyline class="chart-steady" points="${pointList(past, point => point.steady)}"></polyline>
          <polyline class="chart-adjusted" points="${pointList(adjusted, point => point.adjusted)}"></polyline>
          <polyline class="chart-actual" points="${pointList(past, point => point.cumDone)}"></polyline>
          ${overallMark}
          ${chartDayAxis(track, bottom, bottom + 20)}
        </svg>
      </div>`;
  }

  // The honest, motivating figure is the lifetime total, so it leads and is
  // never divided by anything.
  //
  // This used to be a block of its own under the charts. It is a counter now and
  // it sits in the dial grid, because that is where the other counters live and
  // it is the same kind of thing: one number he can check, with the span it was
  // measured over. The long-stretch <details> did not come with it — a list of
  // "one unbroken 10h 8m from 12:07 AM" entries is our bookkeeping explaining
  // itself, and every one of those stretches is still on the day chart, hollow
  // and named, on hover. Same for "Activity report read ...": the top bar now
  // carries when the data was checked.
  export function openTimeCounter(series) {
    if (!series || !series.totalSeconds) return "";
    return `
      <article class="counter" aria-label="Time the course was open">
        <h3 class="counter__title">TIME ON COURSE</h3>
        <strong class="counter__value numeric">${escapeHtml(series.totalText)}</strong>
        <span class="counter__sub numeric">${series.dayCount} DAYS · ${escapeHtml(formatDay(series.firstDay))} TO ${escapeHtml(formatDay(series.lastDay))}</span>
      </article>`;
  }

  export function calendarReward(track) {
    if (track.comeback) {
      const { from, to, gain, days, rows } = track.comeback;
      // Lead with the plain count he can verify by adding up his own calendar
      // tiles, then the comparison. Showing only the difference invites him to
      // count 25, see 15, and stop trusting the page.
      return `${rows} units in ${days} days, ${formatDay(from)} to ${formatDay(to)} — ${gain} more than the route asked for.`;
    }
    const biggestPush = track.bestDays[0];
    if (biggestPush) {
      return `Your biggest push: ${biggestPush.done} units on ${formatDay(biggestPush.date)}.`;
    }
    return "Every unit you finish moves the route forward.";
  }

  export function calendarCell(point, track) {
    const classes = ["cal-cell"];
    const isToday = point.date === track.today;
    if (point.date === track.deadline) classes.push("is-deadline");
    if (isToday) classes.push("is-today");
    if (point.done > 0) {
      classes.push("is-done");
      if (point.beatPlan) classes.push("is-pushing");
    } else if (point.planned > 0 && (point.future || isToday)) {
      classes.push("is-planned");
    } else if (!point.future) {
      classes.push("is-idle");
    }
    // Drawn on top of whatever the day itself was, never instead of it: the run
    // is the achievement, so a blank day inside it keeps the bar and loses
    // nothing. There is no class for the opposite kind of stretch.
    if (point.inComeback) classes.push("is-comeback");

    // A worked day now reads back only the count he logged. The old surplus wording
    // ("N more than the steady route asked for") measured his day against our plan;
    // he asked for it gone. The is-pushing class and the ▲ marker stay — those flag
    // the day, they don't lecture about it.
    let tooltip = "nothing logged";
    if (point.done > 0) {
      tooltip = `${formatDay(point.date)}: ${point.done} ${point.done === 1 ? "unit" : "units"}`;
    } else if (point.planned > 0 && (point.future || isToday)) {
      tooltip = `planned: ${point.planned} ${point.planned === 1 ? "unit" : "units"}`;
    }
    // Two words, not a sentence. The bar under the run is the thing that says it;
    // this only makes the same fact reachable by a screen reader and on hover.
    if (point.inComeback) tooltip = `${tooltip} · best run`;

    if (point.date === track.deadline) {
      return `<div class="${classes.join(" ")}" title="${escapeHtml(tooltip)}"><strong>AUG 15</strong></div>`;
    }
    const count = point.done > 0 ? point.done : (point.planned > 0 && (point.future || isToday) ? point.planned : "");
    const marker = point.beatPlan ? `<span class="cal-cell__push" aria-hidden="true">&#9650;</span>` : "";
    return `<div class="${classes.join(" ")}" title="${escapeHtml(tooltip)}"><span class="cal-cell__d">${escapeHtml(Number(point.date.slice(8)))}</span><span class="cal-cell__n numeric">${escapeHtml(count)}</span>${marker}</div>`;
  }

  export function questDays(data) {
    const remaining = remainingActivities(data);
    const groups = [];
    for (const item of remaining) {
      if (!item.ourTarget) continue;
      let group = groups.find(candidate => candidate.date === item.ourTarget);
      if (!group) {
        if (groups.length === 3) continue;
        group = { date: item.ourTarget, items: [] };
        groups.push(group);
      }
      if (group.items.length < 4) group.items.push(item);
    }
    let cursor = groups.at(-1)?.date ?? addDays(localIsoDate(), -1);
    while (groups.length < 3) {
      cursor = addDays(cursor, 1);
      groups.push({ date: cursor, items: [] });
    }
    return groups;
  }

  export function lessonSlug(semesterId, number) {
    return `${semesterId}-${String(number).padStart(2, "0")}`;
  }

  // Every section in the syllabus, in order, whether or not a lesson file exists for it.
  export function lessonCatalog(data) {
    return (Array.isArray(data?.semesters) ? data.semesters : [])
      .flatMap(semester => (Array.isArray(semester.sections) ? semester.sections : [])
        .filter(section => Number.isInteger(section.number) && section.number > 0)
        .slice()
        .sort((left, right) => left.number - right.number)
        .map(section => ({
          slug: lessonSlug(semester.id, section.number),
          semesterId: semester.id,
          number: section.number,
          name: section.name || "",
          complete: section.complete === true,
        })));
  }

  export function gameKindIcon(kind) {
    const face = GAME_KIND_FACES[kind] ?? GAME_KIND_FACES.tool;
    return `<svg class="game-kind-icon" data-kind="${escapeHtml(kind)}" viewBox="0 0 24 24"
      aria-hidden="true" focusable="false" shape-rendering="crispEdges">
      <path class="game-kind-icon__head" fill="${face.ink}" d="${face.head}"/>
      <path fill="#16202a" d="${face.face}"/>
    </svg>`;
  }
