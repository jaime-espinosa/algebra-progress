import { effortStats as questEffort, computePace, dashboard, dialScale, percentTicks, openTimeSeries, planTrack, evaluateUnlocks, worldMap, mapLandmarks } from "./js/quest.mjs";

(() => {
  "use strict";

  const DAY_MS = 86_400_000;
  const ZONE = "America/Los_Angeles";
  const VALID_THEMES = new Set(["overworld", "nether", "end"]);
  const VALID_LOADERS = new Set(["vanilla", "fabric", "forge", "neoforge", "unsure"]);
  const VALID_GAME_KINDS = new Set(["game", "puzzle", "tool", "video"]);
  // Which mini-lessons exist is asked of the server, not kept in a list here. A second
  // catalog has drifted twice on this project (the artifact list shipped a wrong
  // Minecraft version), and a hand-maintained list of filenames is the same trap: the
  // lesson slugs come from data.json, and lessonExists() checks the file is really there
  // before anything becomes a link.
  const lessonFileCache = new Map();
  const sectionIds = ["worldmap", "effort", "vault", "calendar", "quests", "pace", "repairs", "lesson", "request", "games"];

  // vault/manifest.json is the single source of truth for artifacts. Hardcoding a
  // second copy here drifted immediately: it advertised the victory pack as 1.21.x
  // when the built pack is pack_format 15, i.e. 1.20.1 only. Telling him a reward
  // works on his version when it does not is the one unrecoverable failure.
  let artifacts = [];

  let currentData = null;
  let currentActivity = null;
  // The validated games list, kept so the world map can pin the same items to a
  // region without a second copy of the catalog.
  let currentGames = null;
  let currentMap = null;
  let currentLandmarks = [];
  let intervalId = null;
  let revealQueue = [];
  // Set when a batch of tiles is queued to reveal; cleared once the vault slots
  // that follow them have been unhidden.
  let revealPending = false;
  let pendingArtifact = null;
  let refreshMessage = "";
  let gamesRendered = false;

  function artifact(id, name, tier, minVersion, maxVersion, loader, files, testedOn) {
    return { id, name, tier, minVersion, maxVersion, loader, files, testedOn };
  }

  function storageGet(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // The page remains useful when storage is blocked.
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Forgetting still clears the visible card when storage is blocked.
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function localIsoDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  function parseIsoDate(value) {
    return new Date(`${value}T12:00:00-07:00`);
  }

  function dateDiff(from, to) {
    return Math.ceil((parseIsoDate(to) - parseIsoDate(from)) / DAY_MS);
  }

  function addDays(value, count) {
    const date = parseIsoDate(value);
    date.setUTCDate(date.getUTCDate() + count);
    return date.toISOString().slice(0, 10);
  }

  function formatDay(value, options = {}) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE,
      month: "short",
      day: "numeric",
      ...options
    }).format(parseIsoDate(value));
  }

  function formatTime(value) {
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

  // Must match the crontab entry in _redcomet/cron-refresh.sh (0 8,15,21 * * *).
  // This previously returned 14:00/06:00, which was simply not when the scraper runs,
  // so the header told him a time that was never true.
  const SCRAPE_HOURS = [8, 15, 21];

  function nextScrapeTime(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE, hour: "numeric", hour12: false
    }).formatToParts(now);
    const hour = Number(parts.find(item => item.type === "hour")?.value ?? 0);
    const next = SCRAPE_HOURS.find(h => h > hour) ?? SCRAPE_HOURS[0];
    return `${String(next).padStart(2, "0")}:00`;
  }

  function summarySnapshot(data) {
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

  function snapshotsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  // A scrape can fail while still reporting success — an expired LMS session returns
  // HTTP 200 with an empty gradebook. Trusting scrapeOk alone would render zeros, tell
  // him the semester is sealed, and overwrite the good snapshot with the bad one. So
  // check for regression against what we last saw BEFORE trusting the flag.
  function staleSafeData(data) {
    const saved = storageGet("mc.lastSnapshot", null);
    if (!saved) return data;                       // no baseline: fail open, render as-is
    const regressed = data.semesters.some(semester => {
      const prior = saved[semester.id];
      if (!prior) return false;
      return semester.allTotal === 0 ||
        (semester.allDone === 0 && prior.allDone > 0) ||
        semester.allDone < prior.allDone;
    });
    if (data.scrapeOk !== false && !regressed) return data;
    return {
      ...data,
      scrapeOk: false,
      semesters: data.semesters.map(semester => {
        const prior = saved[semester.id];
        if (!prior) return semester;
        const hasUsefulSummary = semester.allTotal > 0 &&
          !(semester.allDone === 0 && prior.allDone > 0);
        if (hasUsefulSummary) return semester;
        return {
          ...semester,
          gradableDone: prior.gradableDone,
          allDone: prior.allDone,
          percent: prior.percent
        };
      })
    };
  }

  function remainingActivities(data) {
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
  function rewardBaseline(data) {
    return data.rewardBaseline || data.generatedAt?.slice(0, 10) || localIsoDate();
  }

  function submittedAfterBaseline(data) {
    const baseline = rewardBaseline(data);
    return data.semesters.flatMap(semester => semester.activities).filter(item =>
      item.state !== "not_started" &&
      typeof item.submittedDate === "string" &&
      item.submittedDate > baseline);
  }

  // Both of these delegate to js/quest.mjs, which is the tested single source of
  // truth. app.js previously carried its own divergent copy, so the effort panel
  // rendered 3.8/day while the pace panel directly below it rendered 1.7/day.
  function submissionsByDay(data) {
    const stats = questEffort(data, localIsoDate());
    return stats.perDay;
  }

  function effortStats(data, today) {
    const stats = questEffort(data, today);
    return { ...stats, remaining: stats.rowsLeft, likelihood: stats.onTrack };
  }

  function todayCompleted(data, today) {
    return data.semesters.flatMap(semester => semester.activities).filter(item =>
      item.state !== "not_started" && item.submittedDate === today).length;
  }

  // evaluateUnlocks now lives in js/quest.mjs. It used to be defined here while
  // quest.mjs exported a divergent implementation that matched almost none of the
  // manifest ids — see the comment there.

  function unionEarned(data) {
    const stored = storageGet("vault.earned", []);
    const safeStored = Array.isArray(stored) ? stored.filter(id => artifacts.some(item => item.id === id)) : [];
    const unlocked = evaluateUnlocks(data);
    const earned = new Set([...safeStored, ...unlocked]);
    storageSet("vault.earned", [...earned]);
    return { earned, newlyEarned: [...unlocked].filter(id => !safeStored.includes(id)) };
  }

  // Derives from the authoritative earned set, not from a fresh evaluation. Otherwise a
  // bad scrape revokes theme access he already unlocked.
  function applyTheme(data, earned = null) {
    const unlocked = earned ?? evaluateUnlocks(data);
    const allowed = new Set(["overworld"]);
    if (unlocked.has("nether-theme")) allowed.add("nether");
    if (unlocked.has("end-theme-final")) allowed.add("end");
    const stored = storageGet("mc.theme", "overworld");
    const theme = VALID_THEMES.has(stored) && allowed.has(stored) ? stored : "overworld";
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll("[data-set-theme]").forEach(button => {
      const candidate = button.dataset.setTheme;
      button.disabled = !allowed.has(candidate);
      button.setAttribute("aria-pressed", String(candidate === theme));
      if (button.disabled) button.title = `${candidate} telemetry is still locked`;
    });
  }

  function renderHeader(data) {
    const today = localIsoDate();
    const days = Math.max(0, dateDiff(today, data.deadline.date));
    // Units — gradebook rows — because that is what every other number on the
    // page counts. This line used to print allDone/allTotal, which are LMS
    // activities: it said "S2 5/103" while the map, the dials and the vault all
    // agreed he had not started Semester 2, and 105 minus 99 landed one away
    // from the countdown right beside it.
    const map = worldMap(data);
    const counts = map.worlds.map(world =>
      `${world.id === "sem1" ? "S1" : "S2"} ${world.unitsDone}/${world.unitsTotal}u`
    ).join("  ");
    document.querySelector("#f3-line").textContent =
      `algebra_quest 1.0 | ${counts} | D-${days} | scraped ${formatTime(data.generatedAt)}  next ${nextScrapeTime()}`;
  }

  function renderStatus(data, previousSeen, unchanged) {
    const banner = document.querySelector("#status-banner");
    const generated = `last checked ${formatDay(data.generatedAt?.slice(0, 10) || localIsoDate())} ${formatTime(data.generatedAt)}`;
    let message = refreshMessage;
    if (data.scrapeOk === false) {
      message = `Saved telemetry shown · ${generated}`;
    } else if (previousSeen && (Date.now() - new Date(previousSeen).valueOf()) >= 2 * DAY_MS) {
      const next = remainingActivities(data)[0];
      message = next
        ? `Pick up where you left off · next: ${next.title}`
        : "Pick up where you left off · route clear";
    } else if (unchanged) {
      message = `${generated} · next scheduled check ${nextScrapeTime()}`;
    }
    banner.textContent = message;
    banner.hidden = !message;
  }

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
  const REGION_STATE_COPY = {
    settled: "settled",
    here: "you are here",
    started: "in progress",
    ahead: "unexplored"
  };

  const WORLD_NUMERAL = ["", "I", "II", "III"];
  // How far one arrow-key press moves the map, in pixels of the canvas.
  const PAN_STEP = 96;
  // Pan state for the level-1 canvas. Kept out of the DOM so a redraw on a new
  // scrape does not throw him back to the corner he started in.
  let panX = 0;
  let panY = 0;
  let zoomedRegion = null;

  // A region drawn as blocks: one block per gradebook row, filled if submitted.
  // Blocky geometry and hard edges only — no images, no canvas.
  function regionBlocks(region, revealFrom) {
    return region.units.map((unit, index) => {
      const classes = ["wm-block", unit.kind === "battle" ? "is-battle" : "is-training"];
      if (unit.done) classes.push("is-placed");
      if (unit.isNext) classes.push("is-next");
      if (unit.done && revealFrom !== null && index >= revealFrom) classes.push("reveal-hidden");
      return `<span class="${classes.join(" ")}" aria-hidden="true"></span>`;
    }).join("");
  }

  function landmarkGlyph(item, earned) {
    return `<span class="wm-landmark${earned ? " is-earned" : ""}" title="${escapeHtml(
      earned ? `${item.name} — earned` : `${item.name} — unlocks here`)}">
      <span class="wm-landmark__post" aria-hidden="true"></span>
      <span class="wm-landmark__flag" aria-hidden="true"></span>
    </span>`;
  }

  function renderRegionCard(region, landmarksHere, isNewSnapshot, previousDone) {
    // Only blocks beyond what he had last time are held back to reveal, so the
    // map never animates in from empty on a page he has already seen.
    const revealFrom = isNewSnapshot && !reducedMotion()
      ? Math.min(previousDone, region.unitsDone)
      : null;
    const state = REGION_STATE_COPY[region.status] ?? "";
    // Always rendered, empty when the section has no grade yet, so every chunk
    // has the same number of rows and a row of chunks lines up as one landscape.
    // An empty span, never a 0% — a zero would read as a score he was given.
    const grade = `<span class="wm-region__grade quiet numeric">${region.grade === null ? ""
      : `${region.grade.toFixed(1)}%${region.letter ? ` · ${escapeHtml(region.letter)}` : ""}`}</span>`;
    const marker = region.status === "here"
      ? `<span class="wm-here" aria-hidden="true"><span class="wm-here__body"></span><span class="wm-here__head"></span></span>`
      : "";
    const flags = landmarksHere.length
      ? `<span class="wm-region__landmarks">${landmarksHere
          .map(entry => landmarkGlyph(entry.artifact, false)).join("")}</span>`
      : "";
    // Training and battles are the two halves of the same row list, so they add
    // back up to the unit count printed beside them. Nothing new is counted.
    const split = `${region.trainingDone}/${region.trainingTotal} training · ${
      region.battleCleared}/${region.battleTotal} battles`;
    const label = `${region.name}, ${region.unitsDone} of ${region.unitsTotal} units placed, ${state}. Zoom in.`;
    return `
      <button type="button" class="wm-region is-${region.status}" data-region="${escapeHtml(region.key)}"
        style="grid-column:${region.col + 2};grid-row:${region.row + 1}"
        aria-label="${escapeHtml(label)}">
        <span class="wm-region__sky" aria-hidden="true">${marker}${flags}</span>
        <span class="wm-region__id numeric" aria-hidden="true">${String(region.number).padStart(2, "0")}</span>
        <span class="wm-region__name">${escapeHtml(region.name)}</span>
        <span class="wm-region__blocks" aria-hidden="true">${regionBlocks(region, revealFrom)}</span>
        <span class="wm-region__count numeric" aria-hidden="true">${region.unitsDone}/${region.unitsTotal} units</span>
        <span class="wm-region__split quiet numeric" aria-hidden="true">${escapeHtml(split)}</span>
        <span class="wm-region__state" aria-hidden="true">${escapeHtml(state)}</span>
        ${grade}
      </button>`;
  }

  // The band label for a semester, sitting in the left gutter of the map and
  // spanning exactly the rows that semester's regions occupy.
  function renderWorldBand(world, landmarks) {
    const numeral = WORLD_NUMERAL[world.index] ?? String(world.index);
    const eyebrow = world.sealed
      ? `WORLD ${numeral} // SEALED`
      : world.holdsNext
        ? `WORLD ${numeral} // YOU BUILT THIS`
        : world.unitsDone > 0
          ? `WORLD ${numeral} // UNDER WAY`
          : `WORLD ${numeral} // NEWLY OPENED TERRITORY`;
    const near = world.sealed
      ? `${escapeHtml(world.name)} is sealed. Every unit in it is submitted.`
      : `${world.unitsLeft} unit${world.unitsLeft === 1 ? "" : "s"} from sealing ${escapeHtml(world.name)}.`;
    const grade = world.grade === null
      ? ""
      : `<span class="quiet numeric">Grade so far ${world.grade.toFixed(1)}%${
          world.letter ? ` · ${escapeHtml(world.letter)}` : ""}</span>`;
    const standing = landmarks.filter(entry => entry.earned);
    return `
      <div class="wm-band" style="grid-column:1;grid-row:${world.rowStart + 1} / span ${world.rowSpan}">
        <span class="eyebrow">${escapeHtml(eyebrow)}</span>
        <h3 class="wm-world__name">${escapeHtml(world.name)}</h3>
        <strong class="big-number numeric">${world.unitsDone}<span class="wm-world__of"> of ${world.unitsTotal} units placed</span></strong>
        <span class="numeric">${world.percent}% · ${world.regionsSettled} of ${world.regionsTotal} regions settled</span>
        <strong class="wm-world__near">${near}</strong>
        ${grade}
        ${standing.length ? `<span class="wm-world__standing quiet">${standing.length} landmark${
          standing.length === 1 ? "" : "s"} already standing here: ${escapeHtml(
            standing.map(entry => entry.artifact.name).join(", "))}</span>` : ""}
      </div>`;
  }

  // ---- Level 2: inside one region ------------------------------------------
  // Same rows, told as places rather than as a gradebook. A row whose title says
  // quiz or test is a battle; everything else is training. That split is made in
  // quest.mjs (activityKind) and tested, so this only draws it.
  //
  // A battle he has finished is CLEARED. A battle ahead is WAITING FOR YOU. There
  // is no wording anywhere for a battle he skipped, because there is no count of
  // missed work on this page and there is not going to be one.
  function unitNode(unit, index) {
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

  function renderRegionMap(region, world, landmarksHere) {
    const training = region.units.filter(unit => unit.kind === "training");
    const battles = region.units.filter(unit => unit.kind === "battle");
    const list = units => units.length
      ? `<ol class="wm-nodes">${units.map((unit, index) => unitNode(unit, index)).join("")}</ol>`
      : `<p class="quiet">Nothing of this kind in this region.</p>`;

    const games = regionGames(region);
    const gamesHtml = games.length
      ? `<ul class="wm-links">${games.map(item => `
          <li><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
            <span class="meta">${escapeHtml(item.kind)}</span></li>`).join("")}</ul>`
      : `<p class="quiet">No games pinned to this region yet.</p>`;

    const landmarksHtml = landmarksHere.length
      ? `<ul class="wm-links wm-links--landmarks">${landmarksHere.map(entry => `
          <li>${landmarkGlyph(entry.artifact, false)}<span>${escapeHtml(entry.artifact.name)}</span>
            <span class="meta">unlocks when this region is settled</span></li>`).join("")}</ul>`
      : `<p class="quiet">No landmark unlocks in this region.</p>`;

    const lesson = region.lessonSlug
      ? `<p class="wm-detail__lesson"><span data-slug="${escapeHtml(region.lessonSlug)}">${escapeHtml(region.name)}</span></p>`
      : `<p class="quiet">Orientation — there is no mini-lesson for this one.</p>`;

    return `
      <div class="wm-zoom__head">
        <button type="button" class="wm-back" data-wm-back>← back to the world map</button>
        <span class="eyebrow">${escapeHtml(world.name)} // REGION ${String(region.number).padStart(2, "0")}</span>
        <h3 id="wm-zoom-heading">${escapeHtml(region.name)}</h3>
        <span class="numeric">${region.unitsDone} of ${region.unitsTotal} units placed · ${
          region.trainingDone}/${region.trainingTotal} training · ${
          region.battleCleared}/${region.battleTotal} battles${
          region.grade === null ? "" : ` · section grade ${region.grade.toFixed(1)}%`}</span>
      </div>
      <div class="wm-zoom__cols">
        <div class="wm-zoom__col">
          <h4 class="wm-zoom__label">Training <span class="quiet numeric">${
            region.trainingDone}/${region.trainingTotal}</span></h4>
          ${list(training)}
        </div>
        <div class="wm-zoom__col">
          <h4 class="wm-zoom__label">Battles <span class="quiet numeric">${
            region.battleCleared}/${region.battleTotal}</span></h4>
          ${list(battles)}
        </div>
        <div class="wm-zoom__col">
          <h4 class="wm-zoom__label">Mini-lesson</h4>
          ${lesson}
          <h4 class="wm-zoom__label">Landmarks</h4>
          ${landmarksHtml}
          <h4 class="wm-zoom__label">Games and puzzles</h4>
          ${gamesHtml}
        </div>
      </div>`;
  }

  // Games pinned to a syllabus section, out of the same validated list the games
  // panel renders. A second, hand-kept copy is exactly the drift this project has
  // already been bitten by twice, so this reads the one list or renders nothing.
  function regionGames(region) {
    if (!Array.isArray(currentGames)) return [];
    return currentGames
      .filter(section => section.semester === region.worldId && section.number === region.number)
      .flatMap(section => section.items);
  }

  function findRegion(key) {
    return currentMap?.worlds.flatMap(world => world.regions).find(item => item.key === key) ?? null;
  }

  function openRegion(key) {
    const region = findRegion(key);
    if (!region) return;
    const world = currentMap.worlds.find(item => item.id === region.worldId);
    const zoom = document.querySelector("#wm-zoom");
    const viewport = document.querySelector("#wm-viewport");
    if (!zoom || !viewport) return;
    zoom.innerHTML = renderRegionMap(region, world,
      currentLandmarks.filter(entry => entry.regionKey === key));
    zoom.hidden = false;
    zoom.dataset.region = key;
    viewport.hidden = true;
    zoomedRegion = key;
    document.querySelector("#worldmap")?.classList.add("is-zoomed");
    linkExistingLessons(zoom);
    zoom.querySelector(".wm-back")?.focus();
  }

  function closeRegion() {
    const zoom = document.querySelector("#wm-zoom");
    const viewport = document.querySelector("#wm-viewport");
    const key = zoomedRegion;
    if (!zoom || !viewport) return;
    zoom.hidden = true;
    zoom.textContent = "";
    delete zoom.dataset.region;
    viewport.hidden = false;
    zoomedRegion = null;
    document.querySelector("#worldmap")?.classList.remove("is-zoomed");
    if (key) document.querySelector(`.wm-region[data-region="${CSS.escape(key)}"]`)?.focus();
  }

  // ---- Panning the level-1 map ---------------------------------------------
  // transform only, so a 2018 machine moves layers rather than reflowing the
  // page. The wheel is deliberately left alone: scrolling over the map scrolls
  // the page, which is what every other panel does and is the one behaviour that
  // must not surprise him.
  function clampPan() {
    const viewport = document.querySelector("#wm-viewport");
    const canvas = document.querySelector("#wm-canvas");
    if (!viewport || !canvas) return;
    const slackX = Math.max(0, canvas.scrollWidth - viewport.clientWidth);
    const slackY = Math.max(0, canvas.scrollHeight - viewport.clientHeight);
    panX = Math.min(0, Math.max(-slackX, panX));
    panY = Math.min(0, Math.max(-slackY, panY));
    canvas.style.transform = `translate3d(${panX}px, ${panY}px, 0)`;
  }

  function panBy(dx, dy) {
    panX += dx;
    panY += dy;
    clampPan();
  }

  function wireViewport() {
    const viewport = document.querySelector("#wm-viewport");
    if (!viewport || viewport.dataset.wired === "1") return;
    viewport.dataset.wired = "1";

    let dragging = false;
    let originX = 0;
    let originY = 0;
    let startX = 0;
    let startY = 0;
    let moved = 0;

    // Move and release are watched on the window, not captured on the viewport:
    // capturing the pointer retargets the follow-up click at the viewport itself,
    // which silently ate every click on a region the first time this was written.
    const onMove = event => {
      if (!dragging) return;
      const dx = event.clientX - originX;
      const dy = event.clientY - originY;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      panX = startX + dx;
      panY = startY + dy;
      clampPan();
    };
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      viewport.classList.remove("is-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      // A drag is not a click: without this, pushing the map sideways by
      // grabbing a chunk would zoom into whatever was under the finger. Stamped
      // with a time rather than a flag, so the suppression belongs to THIS
      // gesture and cannot linger and eat a real click made later.
      if (moved > 6) viewport.dataset.dragEndedAt = String(Date.now());
    };

    viewport.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      dragging = true;
      moved = 0;
      originX = event.clientX;
      originY = event.clientY;
      startX = panX;
      startY = panY;
      viewport.classList.add("is-dragging");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", endDrag);
    });

    // Arrow keys pan. Only the arrows are swallowed, and only when the map
    // itself has focus, so Tab and page scrolling are untouched.
    viewport.addEventListener("keydown", event => {
      const steps = {
        ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0],
        ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP]
      };
      const step = steps[event.key];
      if (!step) return;
      // Arrows pan wherever focus sits inside the map, including on a chunk:
      // buttons have no arrow behaviour of their own to take away, and Tab is
      // left alone so he can still walk the chunks one at a time.
      event.preventDefault();
      panBy(step[0], step[1]);
    });
  }

  function renderWorldMap(data, previousSnapshot, isNewSnapshot) {
    const map = worldMap(data);
    currentMap = map;
    // Artifact names come from vault/manifest.json, the one catalog. An anchor
    // whose id is not in the manifest is dropped rather than drawn nameless.
    currentLandmarks = mapLandmarks(data)
      .map(entry => ({ ...entry, artifact: artifacts.find(item => item.id === entry.id) }))
      .filter(entry => entry.artifact);

    // How many blocks in each region he had already seen, so only genuinely new
    // ones animate. Falls back to none, which reveals nothing rather than
    // replaying the whole map.
    const previousDoneByRegion = new Map();
    for (const world of map.worlds) {
      const priorDone = previousSnapshot?.[world.id]?.rowsDone;
      let budget = Number.isFinite(priorDone) ? priorDone : world.unitsDone;
      for (const region of world.regions) {
        const seen = Math.max(0, Math.min(region.unitsDone, budget));
        previousDoneByRegion.set(region.key, seen);
        budget -= seen;
      }
    }

    const openKey = zoomedRegion;
    const landmarksFor = worldId => currentLandmarks.filter(entry =>
      entry.worldId === worldId || (entry.earned && worldId === map.worlds[0]?.id));
    const regions = map.worlds.flatMap(world => world.regions);
    const byRegion = new Map();
    for (const entry of currentLandmarks) {
      if (!entry.regionKey) continue;
      if (!byRegion.has(entry.regionKey)) byRegion.set(entry.regionKey, []);
      byRegion.get(entry.regionKey).push(entry);
    }

    document.querySelector("#worldmap-content").innerHTML = map.worlds.length
      ? `
      <p class="wm-intro">The whole of Algebra I as one place. Every block is one unit from the
        gradebook — ${map.totalDone} of ${map.totalUnits} placed, the same ${map.totalDone} the
        dials count. Drag the map, or use the arrow keys, to look around. Click a region to zoom in.</p>
      <div id="wm-viewport" class="wm-viewport" tabindex="0" role="group"
        aria-label="World map. Drag or use the arrow keys to pan. Click a region to zoom in.">
        <div id="wm-canvas" class="wm-canvas" style="--wm-cols:${map.grid.cols}">
          ${map.worlds.map(world => renderWorldBand(world, landmarksFor(world.id))).join("")}
          ${regions.map(region => renderRegionCard(
            region,
            byRegion.get(region.key) ?? [],
            isNewSnapshot,
            previousDoneByRegion.get(region.key) ?? 0
          )).join("")}
        </div>
      </div>
      <div class="wm-zoom" id="wm-zoom" role="group" aria-labelledby="wm-zoom-heading" hidden></div>
      <div class="wm-key quiet numeric">
        <span><b class="wm-key__block is-placed"></b> unit placed</span>
        <span><b class="wm-key__block"></b> not built yet</span>
        <span><b class="wm-key__block is-next"></b> your next unit</span>
        <span><b class="wm-key__block is-battle"></b> a battle (quiz or test)</span>
        <span><b class="wm-key__block is-landmark"></b> a landmark unlocks in that region</span>
      </div>`
      : `<p class="quiet">Saved telemetry is thin right now — the map redraws on the next check.</p>`;

    wireViewport();
    clampPan();
    if (openKey && findRegion(openKey)) openRegion(openKey);

    if (isNewSnapshot && !reducedMotion()) {
      revealQueue = [...document.querySelectorAll("#worldmap-content .wm-block.reveal-hidden")];
      revealPending = true;
    }
  }

  function spriteSvg(index, earned) {
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

  function validSkinCache(value) {
    return value &&
      typeof value.name === "string" &&
      typeof value.fetchedAt === "string" &&
      typeof value.dataUrl === "string" &&
      /^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i.test(value.dataUrl)
      ? value
      : null;
  }

  function skinPlaceholderSvg() {
    return `
      <svg viewBox="0 0 8 8" aria-hidden="true">
        <path fill="var(--dim)" d="M1 1h6v6H1z"></path>
        <path fill="var(--panel-solid)" d="M2 2h4v1H2zm0 3h1v1H2zm3 0h1v1H5z"></path>
        <path fill="var(--accent)" d="M2 4h1v1H2zm3 0h1v1H5z"></path>
        <path fill="var(--line)" d="M3 6h2v1H3z"></path>
      </svg>`;
  }

  function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result));
      reader.addEventListener("error", () => reject(reader.error || new Error("Skin file could not be read.")));
      reader.readAsDataURL(blob);
    });
  }

  async function loadSkin(name) {
    const savedSkin = validSkinCache(storageGet("mc.skin", null));
    storageSet("mc.username", name);
    renderSkinCard({
      username: name,
      skin: savedSkin,
      status: "Loading skin…",
      loading: true
    });

    try {
      // Fetching a skin by name necessarily sends the username to mc-heads.net from
      // his browser. That is inherent in this accepted feature and is documented here
      // so it is not discovered later. The username stays out of this public repo,
      // which carries only his first name, and is deliberately saved on his laptop.
      const response = await fetch(`https://mc-heads.net/skin/${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const dataUrl = await blobDataUrl(await response.blob());
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
        throw new Error("Skin response was not a PNG.");
      }
      const skin = { name, dataUrl, fetchedAt: new Date().toISOString() };
      storageSet("mc.skin", skin);
      renderSkinCard({
        username: name,
        skin,
        status: "Skin saved on this laptop."
      });
    } catch {
      const cached = validSkinCache(storageGet("mc.skin", null)) || savedSkin;
      renderSkinCard({
        username: name,
        skin: cached,
        failed: true,
        status: cached
          ? "Couldn't reach mc-heads.net just now — this is the copy saved on this laptop."
          : "Couldn't reach mc-heads.net just now. Check the connection, then retry."
      });
    }
  }

  function renderSkinCard(options = {}) {
    const storedUsername = storageGet("mc.username", "");
    // A data refresh re-renders the whole page, and this card can be mid-type when
    // that happens — a background poll that silently erased what he was typing
    // would look like the page fighting him. Half-typed input and focus survive.
    const liveInput = document.querySelector("#skin-name");
    const typed = liveInput && document.activeElement === liveInput ? liveInput.value : null;
    const username = typeof options.username === "string"
      ? options.username
      : typed !== null ? typed
        : typeof storedUsername === "string" ? storedUsername : "";
    const skin = options.skin === undefined
      ? validSkinCache(storageGet("mc.skin", null))
      : validSkinCache(options.skin);
    const failed = options.failed === true;
    const loading = options.loading === true;
    const status = options.status || (skin
      ? "This copy is saved on this laptop."
      : "Type your Minecraft username to put your skin in the Vault.");
    const preview = skin
      ? `<div class="skin-card__head" role="img" aria-label="Minecraft skin head for ${escapeHtml(skin.name)}">
          <div class="skin-card__head-base"></div>
          <div class="skin-card__head-hat"></div>
        </div>`
      : `<div class="skin-card__placeholder">${skinPlaceholderSvg()}</div>`;
    const nameCopy = skin ? ` // ${escapeHtml(skin.name)}` : "";
    const card = document.querySelector("#skin-card");
    card.dataset.motion = reducedMotion() ? "reduced" : "full";
    card.innerHTML = `
      <div class="skin-card__preview">
        ${preview}
      </div>
      <div class="skin-card__content">
        <strong class="skin-card__title">YOUR SKIN${nameCopy}</strong>
        <form id="skin-form" class="skin-card__form">
          <label class="skin-card__label" for="skin-name">Minecraft username</label>
          <input id="skin-name" name="skin-name" type="text" value="${escapeHtml(username)}"
            placeholder="Minecraft username" maxlength="16" autocomplete="off" spellcheck="false">
          <button type="submit"${loading ? " disabled" : ""}>Load skin</button>
          ${failed && !skin ? `<button id="skin-retry" type="button">Retry</button>` : ""}
          <button id="skin-forget" type="button"${!username && !skin ? " disabled" : ""}>Forget</button>
        </form>
        <p class="skin-card__status${failed ? " is-warning" : ""}" role="status">${escapeHtml(status)}</p>
      </div>`;

    if (typed !== null) {
      const restored = card.querySelector("#skin-name");
      restored.focus();
      restored.setSelectionRange(restored.value.length, restored.value.length);
    }

    if (skin) {
      const backgroundImage = `url(${JSON.stringify(skin.dataUrl)})`;
      card.querySelector(".skin-card__head-base").style.backgroundImage = backgroundImage;
      card.querySelector(".skin-card__head-hat").style.backgroundImage = backgroundImage;
    }

    card.querySelector("#skin-form").addEventListener("submit", event => {
      event.preventDefault();
      const name = card.querySelector("#skin-name").value.trim();
      if (!name) {
        renderSkinCard({ status: "Type your Minecraft username first." });
        return;
      }
      void loadSkin(name);
    });
    card.querySelector("#skin-retry")?.addEventListener("click", () => {
      card.querySelector("#skin-form").requestSubmit();
    });
    card.querySelector("#skin-forget").addEventListener("click", () => {
      storageRemove("mc.username");
      storageRemove("mc.skin");
      renderSkinCard();
    });
  }

  // `earned` is passed in, never re-read from storage. Re-reading meant that when
  // localStorage was blocked or full, storageSet silently no-opped and every artifact
  // he had actually earned rendered as locked.
  function renderVault(data, earned, newlyEarned, isNewSnapshot) {
    const version = storageGet("mc.version", null);
    const strongest = [...artifacts].reverse().find(item => earned.has(item.id));
    document.querySelector("#vault-status").textContent = earned.size
      ? `${earned.size} earned artifact${earned.size === 1 ? "" : "s"} ready.`
      : "Your first new submission opens a slot.";
    document.querySelector("#hotbar").innerHTML = artifacts.map((item, index) => {
      const isEarned = earned.has(item.id);
      const gated = isEarned && item.minVersion && !version;
      const featured = strongest?.id === item.id;
      const reveal = isNewSnapshot && newlyEarned.includes(item.id) && !reducedMotion();
      // An artifact that ships a page in this repo has to be reachable, or earning it
      // buys him a status line and nothing else. Anchor, not window.open, so a popup
      // blocker cannot swallow the reward.
      const page = item.files.find(file => file.endsWith(".html"));
      // A skin is only a reward once it is on his machine, so a file artifact gets a
      // real download link rather than a button that describes it.
      const file = item.files.find(entry => !entry.endsWith(".html"));
      const openable = isEarned && !gated && (page || file);
      const action = openable
        ? page
          ? `<a class="action vault-slot__open" href="${escapeHtml(`vault/${page}`)}" target="_blank" rel="noopener noreferrer" data-artifact="${item.id}">Open</a>`
          : `<a class="action vault-slot__open" href="${escapeHtml(`vault/${file}`)}" download data-artifact="${item.id}">Download</a>`
        : isEarned
          ? `<button type="button" data-artifact="${item.id}">${gated ? "Check version" : "Preview"}</button>`
          : `<span class="quiet">${escapeHtml(item.tier)} · locked</span>`;
      return `
        <article class="vault-slot${isEarned ? " is-earned" : ""}${featured ? " is-featured" : ""}${reveal ? " reveal-hidden" : ""}"
          data-vault-id="${item.id}">
          ${spriteSvg(index, isEarned)}
          <strong class="vault-slot__name">${escapeHtml(item.name)}</strong>
          ${action}
        </article>`;
    }).join("");
  }

  function gaugePoint(fraction, radius) {
    const angle = (135 + Math.max(0, Math.min(1, fraction)) * 270) * Math.PI / 180;
    return {
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius
    };
  }

  function gaugeArc(from, to, radius = 38) {
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
  function tip(text) {
    return `<span class="tip" tabindex="0"><span class="tip__mark" aria-hidden="true">?</span><span class="tip__body" role="note">${escapeHtml(text)}</span></span>`;
  }

  // The all-time count used plate numerals and he liked them, so every dial
  // reads in the same numerals. Non-digits (a decimal point, a percent sign)
  // sit between plates rather than getting a plate of their own.
  function numeralPlate(text, modifier = "") {
    const glyphs = String(text).split("").map(character => /\d/.test(character)
      ? `<span class="plate__digit">${character}</span>`
      : `<span class="plate__mark">${escapeHtml(character)}</span>`).join("");
    return `<span class="plate numeric${modifier ? ` plate--${modifier}` : ""}">${glyphs}</span>`;
  }

  // Dial anatomy, copied off the analog speedometer he pointed at: the numbers
  // sit AROUND the arc (not stacked under the face), each numbered major tick
  // has three unnumbered minors between it and the next, a second scale runs on
  // a tighter inner arc in its own colour, the unit is named on the face, and an
  // inset window carries the exact figure. Nothing is captioned underneath —
  // the numbers under the old dials were the part he said nobody reads.
  //
  // The reference dial's inner scale is red. This site has no red in any theme
  // or state, so the inner scale is drawn in the site's amber accent — the same
  // token the adjusted-route line and the calendar keys already use. It is a
  // second scale, not a warning; nothing on this panel warns about anything.
  //
  // `scale` and `secondary` come from quest.mjs (dialScale / percentTicks). This
  // function does geometry and markup only, and computes no reading of its own.
  const GAUGE = {
    track: 45.5, tickOuter: 44, majorInner: 37, minorInner: 40.5, numbers: 33.5,
    scale2Arc: 25.5, scale2Outer: 27.5, scale2Inner: 23.5, scale2Numbers: 18,
    needle: 42,
  };

  function gaugeTick(at, fromRadius, toRadius) {
    const from = gaugePoint(at, fromRadius);
    const to = gaugePoint(at, toRadius);
    return `<line x1="${from.x.toFixed(2)}" y1="${from.y.toFixed(2)}" x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}"></line>`;
  }

  // The two numbers at the ends of the arc sit either side of the digital
  // window at the bottom, so they are anchored AWAY from it: a three-digit
  // end label centred on the arc would have its inner half swallowed.
  function gaugeText(at, radius, text, className, endAware = false) {
    const point = gaugePoint(at, radius);
    const anchor = !endAware ? "middle" : at <= 0.001 ? "end" : at >= 0.999 ? "start" : "middle";
    return `<text class="${className}" x="${point.x.toFixed(2)}" y="${point.y.toFixed(2)}"
      text-anchor="${anchor}" dominant-baseline="central">${escapeHtml(text)}</text>`;
  }

  function gaugeDial({ label, hint, scale, secondary, faceUnit, readout, readoutSub, ariaText, bandTo = 1, bandAheadLabel }) {
    const clamped = Math.max(0, Math.min(1, scale.fraction));
    const majors = scale.majors.map(({ at }) => gaugeTick(at, GAUGE.majorInner, GAUGE.tickOuter)).join("");
    const minors = scale.minors.map((at) => gaugeTick(at, GAUGE.minorInner, GAUGE.tickOuter)).join("");
    const numbers = scale.majors
      .map(({ at, text }) => gaugeText(at, GAUGE.numbers, text, "gauge__number", true)).join("");

    // The inner scale is drawn from its first non-zero tick, like the reference
    // dial's second scale, which starts short of the zero end. That also keeps
    // its numbers clear of the digital window in the gap at the bottom.
    const ticks2list = secondary.ticks.filter(({ percent }) => percent > 0);
    const ticks2 = ticks2list.map(({ at }) => gaugeTick(at, GAUGE.scale2Inner, GAUGE.scale2Outer)).join("");
    // A label in the last few degrees of the inner arc would land on top of the
    // digital window in the gap at the bottom. Its tick still gets drawn; only
    // the numeral is dropped, exactly as the reference leaves its end ticks bare.
    const numbers2 = ticks2list
      .filter(({ at }) => at <= 0.955)
      .map(({ at, text }) => gaugeText(at, GAUGE.scale2Numbers, text, "gauge__number2")).join("");
    const firstTick = ticks2list.length ? ticks2list[0].at : 0;
    const lastTick = ticks2list.length ? ticks2list[ticks2list.length - 1].at : 0;
    const scale2 = ticks2list.length ? `
            <g class="gauge__scale2">
              <path class="gauge__scale2-arc" d="${gaugeArc(firstTick, lastTick, GAUGE.scale2Arc)}"></path>
              <g class="gauge__scale2-ticks" shape-rendering="crispEdges">${ticks2}</g>
              <g class="gauge__scale2-numbers">${numbers2}</g>
            </g>
            <text class="gauge__scale2-unit" x="50" y="56" text-anchor="middle">${escapeHtml(secondary.unit)}</text>` : "";

    // The rim band, from the tachometer reference — but with its meaning removed.
    // A tacho band shades green/amber/red to say "fine / careful / you are
    // redlining". There is no danger state on this site, so the band here is
    // plain range shading: a thick solid arc for the part of the range he has
    // covered, and a thin dashed arc for the part still ahead. The two are told
    // apart by THICKNESS and by DASHES as well as by colour, so the split still
    // reads for anyone who cannot separate the hues. Ahead is simply the rest of
    // the range; nothing anywhere says a reading is bad.
    const bandEnd = Math.max(clamped, Math.min(1, bandTo));
    const progress = clamped > 0 ? `
            <path class="gauge__progress" d="${gaugeArc(0, clamped, GAUGE.track)}"></path>` : "";
    const ahead = bandEnd > clamped ? `
            <path class="gauge__ahead" d="${gaugeArc(clamped, bandEnd, GAUGE.track)}"></path>` : "";
    const angle = (135 + clamped * 270).toFixed(2);

    return `
      <article class="gauge">
        <h3 class="gauge__title">${escapeHtml(label)}${hint ? tip(hint) : ""}</h3>
        <div class="gauge__face">
          <svg class="gauge__svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
            <circle class="gauge__disc" cx="50" cy="50" r="49"></circle>
            <path class="gauge__track" d="${gaugeArc(0, 1, GAUGE.track)}"></path>
            ${ahead}
            ${progress}
            <g class="gauge__minors" shape-rendering="crispEdges">${minors}</g>
            <g class="gauge__majors" shape-rendering="crispEdges">${majors}</g>
            <g class="gauge__numbers">${numbers}</g>
            ${scale2}
            <text class="gauge__face-unit" x="50" y="90" text-anchor="middle">${escapeHtml(faceUnit)}</text>
            <g class="gauge__needle" style="transform: rotate(${angle}deg)">
              <polygon points="42,48.8 92,50 42,51.2 40,50"></polygon>
            </g>
            <circle class="gauge__hub" cx="50" cy="50" r="4"></circle>
            <circle class="gauge__hub-pin" cx="50" cy="50" r="1.4"></circle>
          </svg>
          <div class="gauge__window" aria-hidden="true">
            ${numeralPlate(readout, "dial")}
            ${readoutSub ? `<span class="gauge__window-sub numeric">${escapeHtml(readoutSub)}</span>` : ""}
          </div>
          <p class="gauge__sr">${escapeHtml(ariaText)}</p>
        </div>
      </article>`;
  }

  // ---- Shared chart geometry ------------------------------------------------
  // The per-day chart and the cumulative chart are one picture in two SVGs. They
  // share the x domain (planTrack's points: first working day through Aug 15),
  // the viewBox width, and both side margins, so day N is the same pixel on
  // both. Aligning them by eye is what he asked us not to do — if you change a
  // number here it changes in both charts or in neither.
  const CHART = { width: 760, left: 58, right: 46 };

  function chartX(track, index) {
    const last = Math.max(1, track.points.length - 1);
    return CHART.left + (index / last) * (CHART.width - CHART.left - CHART.right);
  }

  function chartDayTicks(track) {
    const step = Math.max(1, Math.round(track.points.length / 6));
    const last = track.points.length - 1;
    const ticks = [];
    track.points.forEach((point, index) => {
      if (index % step === 0) ticks.push({ index, date: point.date });
    });
    // Keep the deadline labelled without letting it collide with the tick before it.
    while (ticks.length && last - ticks.at(-1).index < step * 0.6) ticks.pop();
    if (last >= 0) ticks.push({ index: last, date: track.points[last].date });
    return ticks;
  }

  function chartDayAxis(track, y, labelY) {
    return chartDayTicks(track).map(({ index, date }, order, all) => {
      const x = chartX(track, index).toFixed(1);
      const anchor = order === 0 ? "start" : order === all.length - 1 ? "end" : "middle";
      return `
        <line class="chart-axis__tick" x1="${x}" y1="${y}" x2="${x}" y2="${y + 4}"></line>
        <text class="chart-label" x="${x}" y="${labelY}" text-anchor="${anchor}">${escapeHtml(formatDay(date))}</text>`;
    }).join("");
  }

  // ---- Per-day chart --------------------------------------------------------
  // Two series on one x-axis, and they are deliberately NOT combined into a
  // rate. The right-hand line is the LMS's own clock on how long the course page
  // was open; nothing logs him out, so Jul 24 reads 10h 19m against one unit,
  // and 10h 8m of it is a single entry that started at 12:07 AM. Dividing one
  // series by the other produces "619 minutes per unit", which is false and is
  // the exact discouraging message this page exists to undo. Flagged days are
  // drawn hollow and say so on hover, so a spike reads as a tab left open.
  function perDayChart(track, perDay, requiredPerDay, series) {
    const height = 196;
    const top = 20;
    const bottom = 148;
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
        <text class="chart-label" x="${CHART.left - 8}" y="${(Number(y) + 3).toFixed(1)}" text-anchor="end">${value}</text>`;
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
        const why = day.marked
          ? `${formatDay(point.date)}: the course page was open ${day.text}${stretch
            ? `, including one unbroken ${stretch.text}${stretch.startTime ? ` from ${stretch.startTime}` : ""}` : ""}. Nothing logs you out, so a tab left open keeps counting.`
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
        <div class="chart-key numeric">
          <span><b class="chart-key__swatch is-units"></b>units submitted that day</span>
          <span><b class="chart-key__swatch is-open"></b>time the course page was open — the LMS clock, not time worked</span>
          <span><b class="chart-key__swatch is-flag"></b>a tab was probably left open${tip("A day flagged here has one unbroken entry of 3 hours or more, or 8 hours or more in total. The seconds are still counted — they are just named. This time is never divided by units.")}</span>
        </div>
        <svg viewBox="0 0 ${CHART.width} ${height}" preserveAspectRatio="xMidYMid meet" role="img"
          aria-label="${escapeHtml(`Units submitted per calendar day from ${formatDay(track.firstDay)} through ${formatDay(track.deadline)}, with a reference line at ${requiredPerDay.toFixed(2)} units per day. A second line on the right axis shows how long the course page was open each day, in hours; ${series ? series.markedDays : 0} days are flagged as a tab left open.`)}">
          ${yTicks}
          <line class="chart-axis" x1="${CHART.left}" y1="${top}" x2="${CHART.left}" y2="${bottom}"></line>
          <line class="chart-axis" x1="${CHART.left}" y1="${bottom}" x2="${CHART.width - CHART.right}" y2="${bottom}"></line>
          ${openAxis}
          <text class="chart-axis-title" x="14" y="${(top + bottom) / 2}"
            text-anchor="middle" transform="rotate(-90 14 ${(top + bottom) / 2})">units/day</text>
          <line class="chart-reference" x1="${CHART.left}" y1="${requiredY.toFixed(1)}"
            x2="${CHART.width - CHART.right}" y2="${requiredY.toFixed(1)}"></line>
          <text class="chart-reference__label" x="${CHART.left + 6}" y="${(requiredY - 5).toFixed(1)}"
            text-anchor="start">${requiredPerDay.toFixed(2)}/day — what Aug 15 needs</text>
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
  function cumulativeChart(track) {
    const height = 200;
    const top = 24;
    const bottom = 150;
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
        <text class="chart-label" x="${CHART.left - 8}" y="${Number(y) + 4}" text-anchor="end">${escapeHtml(value)}</text>`;
    }).join("");
    const todayIndex = track.points.findIndex(point => point.date === track.today);
    const todayX = chartX(track, Math.max(0, todayIndex)).toFixed(1);
    const markers = past.filter(({ point }) => point.beatPlan).map(({ point, index }) => {
      const x = chartX(track, index);
      const y = yAt(point.cumDone);
      const surplus = Math.round(point.surplus);
      const title = `${formatDay(point.date)}: ${point.done} units, ${surplus} more than the steady route asked for`;
      return `<polygon class="chart-marker" points="${x.toFixed(1)},${(y - 8).toFixed(1)} ${(x - 7).toFixed(1)},${(y + 5).toFixed(1)} ${(x + 7).toFixed(1)},${(y + 5).toFixed(1)}" shape-rendering="crispEdges"><title>${escapeHtml(title)}</title></polygon>`;
    }).join("");
    const ariaLabel = `Cumulative units done from ${formatDay(track.firstDay)} through ${formatDay(track.deadline)}, on the same day scale as the chart above. The actual line is compared with the steady route and with the adjusted route, which finishes all ${track.totalRows} units by ${formatDay(track.finishesOn)}. Triangles mark days that beat the steady route.`;

    return `
      <div class="chart-block">
        <div class="chart-key numeric">
          <span><b class="chart-key__swatch is-actual"></b>done so far</span>
          <span><b class="chart-key__swatch is-steady"></b>steady route${tip(`All ${track.totalRows} units spread evenly from ${formatDay(track.firstDay)} to Aug 15 — about ${track.steadyRate.toFixed(1)} a day.`)}</span>
          <span><b class="chart-key__swatch is-adjusted"></b>plan — all ${escapeHtml(track.totalRows)} done by ${escapeHtml(formatDay(track.finishesOn))}${tip("The dates the quest board actually assigns, started from where you stand today.")}</span>
        </div>
        <svg viewBox="0 0 ${CHART.width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(ariaLabel)}">
          ${grid}
          <line class="chart-axis" x1="${CHART.left}" y1="${top}" x2="${CHART.left}" y2="${bottom}"></line>
          <line class="chart-axis" x1="${CHART.left}" y1="${bottom}" x2="${CHART.width - CHART.right}" y2="${bottom}"></line>
          <text class="chart-axis-title" x="14" y="${(top + bottom) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(top + bottom) / 2})">units done</text>
          <line class="chart-today" x1="${todayX}" y1="${top}" x2="${todayX}" y2="${bottom}"></line>
          <text class="chart-today__label" x="${todayX}" y="17" text-anchor="middle">today</text>
          <polyline class="chart-steady" points="${pointList(past, point => point.steady)}"></polyline>
          <polyline class="chart-adjusted" points="${pointList(adjusted, point => point.adjusted)}"></polyline>
          <polyline class="chart-actual" points="${pointList(past, point => point.cumDone)}"></polyline>
          ${markers}
          ${chartDayAxis(track, bottom, bottom + 20)}
        </svg>
      </div>`;
  }

  // The honest, motivating figure is the lifetime total, so it leads and is
  // never divided by anything. The paragraph that used to explain that lives in
  // the tooltip now; what the number IS stays on screen.
  function openTimePanel(series) {
    if (!series || !series.totalSeconds) return "";
    const marked = series.stretches.slice(0, 3).map(stretch =>
      `<li>${formatDay(stretch.date)} — ${escapeHtml(stretch.text)}${
        stretch.startTime ? ` starting ${escapeHtml(stretch.startTime)}` : ""}</li>`).join("");
    return `
      <section class="open-time" aria-label="Time the course was open">
        <strong class="open-time__total numeric">${escapeHtml(series.totalText)}</strong>
        <span class="open-time__caption">TIME THE COURSE PAGE HAS BEEN OPEN${tip("The LMS's own clock, summed straight off its Activity report. It measures the page being open, not work, so it is never divided by units.")}</span>
        <span class="quiet">across ${series.dayCount} days, ${formatDay(series.firstDay)} to ${formatDay(series.lastDay)}</span>
        ${marked ? `
        <details class="open-time__marked">
          <summary>${series.stretches.length} long stretch${series.stretches.length === 1 ? "" : "es"} counted in that total</summary>
          <p class="quiet">Nothing logs you out, so a tab left open keeps counting. These are
            still inside the ${escapeHtml(series.totalText)} above — nothing has been removed:</p>
          <ul>${marked}</ul>
        </details>` : ""}
        ${series.asOf ? `<span class="quiet open-time__asof">Activity report read ${formatDay(series.asOf)}.</span>` : ""}
      </section>`;
  }

  function renderEffort(data) {
    const today = localIsoDate();
    const s = dashboard(data, today);
    const perDay = effortStats(data, today).perDay;
    const track = planTrack(data, today);
    const series = currentActivity ? openTimeSeries(currentActivity, today) : null;
    const totalUnits = s.odometer + s.rowsLeft;
    const calendarSpan = s.spanDays;
    // Each dial's inner scale is the SAME needle read as a percentage of a basis
    // that is printed on this page, so both numbers are checkable by hand and
    // neither can disagree with the other. Percentages are rounded the same way
    // everywhere on the site (nearest whole).
    const paceScale = dialScale(s.activePace, 6);
    const weekScale = dialScale(s.recent7, Math.max(28, s.recent7));
    const doneScale = dialScale(s.odometer, totalUnits);
    const daysScale = dialScale(s.activeDays, calendarSpan);
    const pacePercent = s.requiredPerDay > 0 ? Math.round((s.activePace / s.requiredPerDay) * 100) : 0;
    const weekPercent = s.rowsLeft > 0 ? Math.round((s.recent7 / s.rowsLeft) * 100) : 0;
    const donePercent = Math.round(s.tripDone * 100);
    const daysPercent = Math.round(s.showUpRate * 100);
    // Said the same way on every dial: the rim band is range shading, never a
    // verdict. Nothing here calls a reading good or bad.
    const BAND_TEXT = "The thick band on the rim covers what you have done; the thin dashed band past the needle is just the rest of the dial, not a target.";

    document.querySelector("#effort-content").innerHTML = `
      <div class="effort-gauges">
        ${gaugeDial({
          label: "UNITS PER DAY",
          hint: `Units submitted divided by the number of days you actually submitted something. Days you never opened the course are not in the divisor: ${s.odometer} units over ${s.activeDays} days. The inner amber scale is the same needle as a percentage of the ${s.requiredPerDay.toFixed(2)} a day Aug 15 needs.`,
          scale: paceScale,
          secondary: { unit: "% OF NEEDED", ticks: percentTicks(paceScale.max, s.requiredPerDay) },
          faceUnit: "UNITS / DAY",
          readout: s.activePace.toFixed(2),
          readoutSub: `NEEDS ${s.requiredPerDay.toFixed(2)}`,
          bandTo: 1,
          ariaText: `Units per day on the days you work: ${s.activePace.toFixed(2)}, on a dial reading 0 to ${paceScale.max} units per day — ${s.odometer} units over ${s.activeDays} working days. Aug 15 needs ${s.requiredPerDay.toFixed(2)} a day, so the inner amber percentage scale reads ${pacePercent} percent of that pace. ${BAND_TEXT}`
        })}

        ${gaugeDial({
          label: "LAST 7 DAYS",
          hint: `A raw count of units submitted ${formatDay(s.recent7From)} through ${formatDay(s.recent7To)}. Not a rate. The inner amber scale is that same count as a percentage of the ${s.rowsLeft} units still to do.`,
          scale: weekScale,
          secondary: { unit: `% OF ${s.rowsLeft} LEFT`, ticks: percentTicks(weekScale.max, s.rowsLeft) },
          faceUnit: "UNITS / 7 DAYS",
          readout: String(s.recent7),
          readoutSub: `PREV 7: ${s.prior7}`,
          bandTo: 1,
          ariaText: `${s.recent7} units submitted from ${formatDay(s.recent7From)} through ${formatDay(s.recent7To)}, on a dial reading 0 to ${weekScale.max} units. The seven days before that were ${s.prior7}. The inner amber percentage scale reads that week as ${weekPercent} percent of the ${s.rowsLeft} units still to do. ${BAND_TEXT}`
        })}

        ${gaugeDial({
          label: "UNITS DONE",
          hint: `Every unit you have submitted, out of ${totalUnits} across both semesters. It only ever goes up. The inner amber scale is the same needle as a percentage of all ${totalUnits}.`,
          scale: doneScale,
          secondary: { unit: `% OF ALL ${totalUnits}`, ticks: percentTicks(doneScale.max, totalUnits) },
          faceUnit: "UNITS SUBMITTED",
          readout: String(s.odometer),
          readoutSub: `${s.rowsLeft} LEFT`,
          bandTo: totalUnits / doneScale.max,
          ariaText: `${s.odometer} of ${totalUnits} units submitted across both semesters, ${s.rowsLeft} still to do, on a dial reading 0 to ${doneScale.max} units. The inner amber percentage scale reads ${donePercent} percent of all ${totalUnits}. The thick band on the rim covers the ${s.odometer} you have done and the thin dashed band runs on to the ${totalUnits}th unit.`
        })}

        ${gaugeDial({
          label: "DAYS YOU SAT DOWN",
          hint: `Calendar days since your first submission on which you submitted at least one unit — ${s.activeDays} out of ${calendarSpan}. The inner amber scale is the same needle as a percentage of those ${calendarSpan} days.`,
          scale: daysScale,
          secondary: { unit: `% OF ${calendarSpan} DAYS`, ticks: percentTicks(daysScale.max, calendarSpan) },
          faceUnit: "DAYS WORKED",
          readout: String(s.activeDays),
          readoutSub: `OF ${calendarSpan} DAYS`,
          bandTo: calendarSpan / daysScale.max,
          ariaText: `${s.activeDays} days worked out of the ${calendarSpan} calendar days since ${formatDay(track.firstDay)}, on a dial reading 0 to ${daysScale.max} days. The inner amber percentage scale reads ${daysPercent} percent of those ${calendarSpan} days. The thick band on the rim covers the ${s.activeDays} days you worked and the thin dashed band runs on to the ${calendarSpan}th day since you started.`
        })}
      </div>

      <p class="effort-line numeric">
        ${s.odometer} units in ${s.activeDays} days · ${s.activePace.toFixed(2)} a day when you sit down · Aug 15 needs ${s.requiredPerDay.toFixed(2)}${s.fastEnough ? " — <strong>you are already fast enough</strong>" : ""}.
      </p>

      ${perDayChart(track, perDay, s.requiredPerDay, series)}
      ${cumulativeChart(track)}
      ${openTimePanel(series)}`;
  }

  function calendarReward(track) {
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

  function calendarCell(point, track) {
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

    const roundedSurplus = Math.round(point.surplus);
    let tooltip = "nothing logged";
    if (point.done > 0 && roundedSurplus >= 1) {
      tooltip = `${formatDay(point.date)}: ${point.done} units — ${roundedSurplus} more than the steady route asked for`;
    } else if (point.done > 0) {
      tooltip = `${formatDay(point.date)}: ${point.done} ${point.done === 1 ? "unit" : "units"}`;
    } else if (point.planned > 0 && (point.future || isToday)) {
      tooltip = `planned: ${point.planned} ${point.planned === 1 ? "unit" : "units"}`;
    }

    if (point.date === track.deadline) {
      return `<div class="${classes.join(" ")}" title="${escapeHtml(tooltip)}"><strong>AUG 15</strong></div>`;
    }
    const count = point.done > 0 ? point.done : (point.planned > 0 && (point.future || isToday) ? point.planned : "");
    const marker = point.beatPlan ? `<span class="cal-cell__push" aria-hidden="true">&#9650;</span>` : "";
    return `<div class="${classes.join(" ")}" title="${escapeHtml(tooltip)}"><span class="cal-cell__d">${escapeHtml(Number(point.date.slice(8)))}</span><span class="cal-cell__n numeric">${escapeHtml(count)}</span>${marker}</div>`;
  }

  // planTrack owns every rate and route. This renderer only turns its bounded
  // first-day-through-deadline points into the chart and strip.
  function renderCalendar(data) {
    const today = localIsoDate();
    const daysLeft = Math.max(0, dateDiff(today, data.deadline.date));
    const track = planTrack(data, today);
    const cells = track.points.map(point => calendarCell(point, track));
    // The cumulative chart used to live here. It moved into the effort panel, under
    // the dials, so it shares an x-scale with the per-day chart and the two read as
    // one picture. The strip below is the day-by-day view and stays.
    document.querySelector("#calendar-content").innerHTML = `
      <div class="big-number numeric">${daysLeft} days</div>
      <div class="quiet">${escapeHtml(data.deadline.label)}</div>
      <div class="calendar-comeback">${escapeHtml(calendarReward(track))}</div>
      <div class="cal-strip" aria-label="Working days through Aug 15">${cells.join("")}</div>
      <div class="cal-key quiet numeric">
        <span><b class="k k--done"></b> worked</span>
        <span><b class="k k--push"></b> &#9650; beat the plan (${track.bestDays.length} days)</span>
        <span><b class="k k--plan"></b> planned</span>
        <span><b class="k k--idle"></b> nothing logged</span>
      </div>`;
  }

  function questDays(data) {
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

  function renderQuests(data) {
    const groups = questDays(data);
    const remaining = remainingActivities(data);
    const sem1Open = data.semesters.find(item => item.id === "sem1")
      ?.activities.some(item => item.state === "not_started");
    document.querySelector("#quest-content").innerHTML = groups.map((group, index) => {
      const dateName = index === 0
        ? "Today"
        : new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "long" }).format(parseIsoDate(group.date));
      const items = group.items.length
        ? group.items.map(item => `<li><strong>${escapeHtml(item.title)}</strong><br><span class="meta">${escapeHtml(item.semesterId.toUpperCase())} · Section ${item.sectionNumber}</span></li>`).join("")
        : `<li><span class="quiet">${remaining.length ? "Route buffer." : "Route clear."}</span></li>`;
      const why = sem1Open
        ? "Why this is next: seal Semester 1 first."
        : "Why this is next: syllabus order keeps concepts connected.";
      return `<article class="quest-card">
        <h3>${escapeHtml(dateName)} · ${formatDay(group.date)}</h3>
        <ol class="quest-list">${items}</ol>
        <p class="why">${escapeHtml(why)}</p>
      </article>`;
    }).join("");
  }

  function renderPace(data) {
    const today = localIsoDate();
    const remaining = remainingActivities(data);
    const submitted = submittedAfterBaseline(data).length;
    const totalWork = Math.max(1, remaining.length + submitted);
    const daysLeft = Math.max(1, dateDiff(today, data.deadline.date));
    const required = remaining.length / daysLeft;
    const todayDone = todayCompleted(data, today);
    const stats = effortStats(data, today);
    // Derived from real submission dates, by the same code the effort panel uses.
    // It was previously hardcoded to "7 (Jul 11)", a number that was never true, and
    // then recomputed here a second time — inventing or drifting a personal best he
    // never set is exactly the kind of thing he could check and catch.
    const bestDay = stats.best;
    // His number, not ours. The projection is computed from the pace HE picks, so the
    // finish date is the consequence of his own choice rather than a verdict handed
    // down. Defaults to the honest requirement, capped at 4.
    const suggested = Math.min(4, Math.max(1, Math.ceil(required)));
    const storedTarget = storageGet("mc.dailyTarget", null);
    const dailyAsk = Number.isFinite(storedTarget) && storedTarget >= 1 && storedTarget <= 8
      ? storedTarget
      : suggested;
    const projectionDays = Math.ceil(remaining.length / Math.max(dailyAsk, .1));
    const projectedDate = addDays(today, projectionDays);
    const provenDays = Math.ceil(remaining.length / Math.max(stats.activePace, .1));
    const provenDate = addDays(today, provenDays);
    const closesGap = Math.min(4, required);
    const doneWidth = (submitted / totalWork) * 100;
    const projectedRows = Math.min(remaining.length, Math.floor(stats.activePace * daysLeft));
    const projectedWidth = (projectedRows / totalWork) * 100;
    const gapWidth = Math.max(0, 100 - doneWidth - projectedWidth);
    // Describes the PLAN, not a claim about where he stands. Saying "you're 4 days
    // ahead" because he typed 4 into a box would be a lie he can check.
    const ahead = dateDiff(projectedDate, data.deadline.date);
    const statusCopy = projectedDate <= data.deadline.date
      ? `That plan lands ${Math.max(0, ahead)} days before the deadline.`
      : `That plan lands after Aug 15. ${closesGap.toFixed(1)} a day reaches it.`;
    const next = remaining[0];

    // The heading used to say REROUTING permanently, including when his own plan
    // landed early — a header that never changes is a header that stops being read,
    // and this one was quietly calling every good plan a course correction.
    const heading = remaining.length === 0
      ? "ROUTE CLEAR"
      : projectedDate <= data.deadline.date
        ? `ROUTE LOCKED&nbsp;&nbsp;//&nbsp;&nbsp;${Math.max(0, ahead)} days of slack`
        : "REROUTING";
    document.querySelector("#pace-heading").innerHTML = heading;

    document.querySelector("#pace-content").innerHTML = `
      <div class="daily-readout numeric">
        <strong>TODAY&nbsp;&nbsp;${todayDone} / ${dailyAsk}</strong>
        <span class="quiet">${bestDay ? `best day: ${bestDay.count} (${formatDay(bestDay.date)})` : ""}</span>
      </div>
      <div class="bar daily-bar" aria-label="${todayDone} of ${dailyAsk} units today">
        <span class="daily-bar__fill" style="width:${Math.min(100, todayDone / dailyAsk * 100)}%"></span>
      </div>
      <div class="bar work-bar" aria-label="${submitted} done, ${projectedRows} projected by Aug 15, ${Math.max(0, totalWork - submitted - projectedRows)} beyond current pace">
        <span class="bar__done" style="width:${doneWidth}%"></span>
        <span class="bar__projected" style="width:${projectedWidth}%"></span>
        <span class="bar__gap" style="width:${gapWidth}%"></span>
      </div>
      <div class="pace-copy numeric">
        <label class="target-picker">
          <span>my pace&nbsp;&nbsp;</span>
          <input type="number" id="daily-target" min="1" max="8" step="1" value="${dailyAsk}"
                 aria-label="units I plan to do per day">
          <span>&nbsp;a day &rarr; finishes <strong>${formatDay(projectedDate)}</strong></span>
        </label>
        <span>Aug 15 needs&nbsp;&nbsp; <strong>${required.toFixed(2)}/day</strong>. On the days you work you do <strong>${stats.activePace.toFixed(2)}</strong>${stats.fastEnough ? " — more than enough" : ""}.</span>
        <span>${escapeHtml(statusCopy)}</span>
        <span>${next ? `Next action: ${escapeHtml(next.title)}` : "Every named unit is submitted."}</span>
      </div>`;

    const targetInput = document.querySelector("#daily-target");
    targetInput?.addEventListener("change", () => {
      const value = Math.min(8, Math.max(1, Math.round(Number(targetInput.value) || suggested)));
      storageSet("mc.dailyTarget", value);
      if (currentData) renderPace(currentData);
    });
  }

  function renderRepairs(data) {
    const repairs = data.semesters
      .flatMap(semester => semester.activities.map(item => ({ ...item, semesterId: semester.id })))
      .filter(item => item.state === "graded" && item.score &&
        Number.isFinite(item.score.possible) && Number.isFinite(item.score.earned) &&
        item.score.possible > item.score.earned)
      .sort((left, right) => left.score.percent - right.score.percent)
      .slice(0, 6);
    document.querySelector("#repairs-content").innerHTML = repairs.length
      ? repairs.map(item => {
        const available = Math.max(0, item.score.possible - item.score.earned);
        return `<article class="repair">
          <h3>${escapeHtml(item.title)}</h3>
          <div class="numeric">${item.score.percent}% · ${available.toFixed(2).replace(/\.00$/, "")} points available</div>
          <div class="quiet">${escapeHtml(item.semesterId.toUpperCase())} · Section ${item.sectionNumber}</div>
        </article>`;
      }).join("")
      : `<p class="quiet">No scored repairs are available.</p>`;
  }

  function lessonSlug(semesterId, number) {
    return `${semesterId}-${String(number).padStart(2, "0")}`;
  }

  // Ask the server whether a lesson file is there. Three answers, not two:
  //   true  — it is there, safe to link.
  //   false — the server said 404. Never link it; a dead link is worse than no link.
  //   null  — the request itself failed (offline, opened from a file:// path). That is
  //           not proof of absence, so the link stays: hiding every lesson because the
  //           network blinked is a bigger failure than a link that will not open while
  //           he has no connection anyway.
  async function lessonExists(slug) {
    if (lessonFileCache.has(slug)) return lessonFileCache.get(slug);
    let answer;
    try {
      const response = await fetch(`lessons/${slug}.html`, { method: "HEAD" });
      answer = response.ok ? true : (response.status === 404 ? false : null);
    } catch {
      answer = null;
    }
    lessonFileCache.set(slug, answer);
    return answer;
  }

  // Every section in the syllabus, in order, whether or not a lesson file exists for it.
  function lessonCatalog(data) {
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

  function renderLesson(data) {
    const next = remainingActivities(data)[0];
    const section = next && data.semesters.find(item => item.id === next.semesterId)
      ?.sections.find(item => item.number === next.sectionNumber);
    const currentSlug = next ? lessonSlug(next.semesterId, next.sectionNumber) : null;
    const head = next
      ? `<span class="eyebrow">${escapeHtml(next.semesterId.toUpperCase())} // SECTION ${next.sectionNumber}</span>
         <h3>${escapeHtml(section?.name || next.sectionName || "Course orientation")}</h3>
         <span class="lesson-current-link" data-slug="${escapeHtml(currentSlug)}"></span>`
      : `<p>Every lesson is submitted. The route is clear.</p>`;
    // The library is a record of ground already covered as much as a way in to the next
    // lesson. Nothing here counts what is left, and a section he has not reached yet is
    // simply unmarked — no colour, no label, nothing that reads as a warning.
    document.querySelector("#lesson-content").innerHTML = `
      ${head}
      <h4 class="lesson-library__heading">All twelve mini-lessons</h4>
      <ol class="lesson-library">${lessonCatalog(data).map(entry => {
        const state = entry.slug === currentSlug ? "current" : (entry.complete ? "done" : "ahead");
        const mark = state === "done" ? "cleared" : (state === "current" ? "you are here" : "");
        return `<li class="lesson-library__item lesson-library__item--${state}">
          <span class="lesson-library__id">${escapeHtml(entry.semesterId.toUpperCase())} ${String(entry.number).padStart(2, "0")}</span>
          <span class="lesson-library__name" data-slug="${escapeHtml(entry.slug)}">${escapeHtml(entry.name)}</span>
          ${mark ? `<span class="lesson-library__mark">${mark}</span>` : ""}
        </li>`;
      }).join("")}</ol>`;
    linkExistingLessons();
  }

  // Links are added only after the file has been confirmed, so a missing lesson stays
  // plain text and never becomes a 404 he clicks on.
  async function linkExistingLessons(root = null) {
    const scope = root ?? document.querySelector("#lesson-content");
    const targets = [...scope.querySelectorAll("[data-slug]")];
    await Promise.all(targets.map(async node => {
      const slug = node.dataset.slug;
      if (!/^sem[12]-\d{2}$/.test(slug)) return;
      if (await lessonExists(slug) === false) return;
      const link = document.createElement("a");
      link.href = `lessons/${slug}.html`;
      const current = node.classList.contains("lesson-current-link");
      link.className = current ? "action" : "lesson-library__link";
      link.textContent = current ? "Open mini-lesson" : node.textContent;
      node.textContent = "";
      node.append(link);
    }));
  }

  function renderGames(data) {
    const content = document.querySelector("#games-content");
    gamesRendered = false;
    content.textContent = "";
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        typeof data.generatedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data.generatedAt) ||
        Number.isNaN(new Date(data.generatedAt).valueOf()) ||
        !Array.isArray(data.sections)) return;

    const sections = data.sections.flatMap(section => {
      // A group is either pinned to a syllabus section (semester + number, both
      // required together) or free-standing with neither. Half a pair is malformed
      // data, not a third kind of group, so it is dropped.
      const pinned = section && section.semester !== undefined && section.number !== undefined;
      if (!section || typeof section !== "object" || Array.isArray(section) ||
          typeof section.name !== "string" || !section.name.trim() ||
          !Array.isArray(section.items)) return [];
      if (pinned && (!/^sem[12]$/.test(section.semester) ||
          !Number.isInteger(section.number) || section.number < 1)) return [];
      if (!pinned && (section.semester !== undefined || section.number !== undefined)) return [];

      const items = section.items.flatMap(item => {
        if (!item || typeof item !== "object" || Array.isArray(item) ||
            typeof item.title !== "string" || !item.title.trim() ||
            typeof item.url !== "string" ||
            typeof item.kind !== "string" || !VALID_GAME_KINDS.has(item.kind) ||
            typeof item.why !== "string" || !item.why.trim() ||
            typeof item.free !== "boolean" || typeof item.account !== "boolean" ||
            typeof item.verifiedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.verifiedAt)) return [];
        try {
          const url = new URL(item.url);
          if (url.protocol !== "https:") return [];
          return [{ ...item, url: url.href }];
        } catch {
          return [];
        }
      });
      return items.length ? [{ ...section, items }] : [];
    });
    if (!sections.length) return;
    currentGames = sections;

    content.innerHTML = `<div class="quest-days">${sections.map(section => {
      // Free-standing groups have no section number; the heading is just their name.
      const heading = section.number === undefined
        ? escapeHtml(section.name)
        : `${section.semester === "sem1" ? "S1" : "S2"} // SECTION ${String(section.number).padStart(2, "0")} · ${escapeHtml(section.name)}`;
      const items = section.items.map(item => `
        <li>
          <strong><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></strong><br>
          <span class="meta">${escapeHtml(item.kind)}${item.sourceAvailable === true && item.remixable === true ? " · source you can read" : ""}</span>
          <p class="why">${escapeHtml(item.why)}</p>
        </li>`).join("");
      return `<article class="quest-card">
        <h3>${heading}</h3>
        <ol class="quest-list">${items}</ol>
      </article>`;
    }).join("")}</div>`;
    gamesRendered = true;
  }

  function showSections() {
    document.querySelector("#loading").hidden = true;
    sectionIds.forEach(id => {
      if (id === "games" && !gamesRendered) return;
      document.querySelector(`#${id}`).hidden = false;
    });
    document.querySelector("#main").setAttribute("aria-busy", "false");
  }

  function reducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }

  function render(data) {
    const previousSnapshot = storageGet("mc.lastSnapshot", null);
    const previousSeen = storageGet("mc.lastSeen", null);
    const snapshot = summarySnapshot(data);
    const unchanged = previousSnapshot && snapshotsEqual(previousSnapshot, snapshot);
    const isNewSnapshot = !unchanged;
    const safeData = staleSafeData(data);
    const { earned, newlyEarned } = unionEarned(safeData);

    currentData = safeData;
    applyTheme(safeData, earned);
    renderHeader(safeData);
    renderStatus(safeData, previousSeen, Boolean(unchanged));
    renderWorldMap(safeData, previousSnapshot, isNewSnapshot);
    renderEffort(safeData);
    renderVault(safeData, earned, newlyEarned, isNewSnapshot);
    renderSkinCard();
    renderCalendar(safeData);
    renderQuests(safeData);
    renderPace(safeData);
    renderRepairs(safeData);
    renderLesson(safeData);
    showSections();

    if (reducedMotion() && newlyEarned.length) {
      const status = document.querySelector("#vault-status");
      status.textContent = `${newlyEarned.length} earned artifact${newlyEarned.length === 1 ? "" : "s"} added.`;
    }

    // Snapshot the post-fallback object. Writing the raw payload here was the line that
    // could destroy a good baseline permanently.
    if (safeData.scrapeOk !== false) storageSet("mc.lastSnapshot", summarySnapshot(safeData));
    storageSet("mc.lastSeen", new Date().toISOString());
    startDriver();
  }

  async function loadManifest() {
    try {
      const response = await fetch("vault/manifest.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const entries = await response.json();
      artifacts = (Array.isArray(entries) ? entries : []).map(entry => artifact(
        entry.id, entry.name, entry.tier, entry.minVersion, entry.maxVersion,
        entry.loader, entry.files || [], entry.testedOn
      ));
    } catch {
      // Vault stays empty rather than showing rewards we cannot actually deliver.
      artifacts = [];
    }
  }

  // The Activity report is a separate scrape from the gradebook and refreshes on
  // its own schedule, so it is a separate file and the panel names the date it
  // was taken. Missing or malformed leaves the open-time panel out entirely
  // rather than showing a zero that reads as "you did nothing".
  async function loadActivity() {
    try {
      const response = await fetch("activity.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = await response.json();
      currentActivity = Array.isArray(parsed?.courses) ? parsed : null;
    } catch {
      currentActivity = null;
    }
  }

  async function loadGames() {
    try {
      const response = await fetch("games.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      renderGames(await response.json());
    } catch {
      // Games are optional; missing or malformed data leaves the panel hidden and
      // must never affect progress telemetry.
      renderGames(null);
    }
  }

  async function loadData(force = false) {
    try {
      const suffix = force ? `?refresh=${Date.now()}` : "";
      const response = await fetch(`data.json${suffix}`, { cache: force ? "no-store" : "default" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.semesters) || !data.deadline?.date) throw new Error("Invalid data shape");
      // Shape validity is not semantic validity: semesters:[] passes Array.isArray and
      // then throws mid-render, leaving a half-mutated DOM.
      if (!data.semesters.length || data.semesters.every(s => !(s.activities?.length > 0))) throw new Error("Empty payload");
      const oldSnapshot = currentData ? summarySnapshot(currentData) : null;
      refreshMessage = force && snapshotsEqual(oldSnapshot, summarySnapshot(data))
        ? `No new units yet · last checked ${formatTime(data.generatedAt)} · next ${nextScrapeTime()}`
        : "";
      render(data);
    } catch (error) {
      stopDriver();
      const loading = document.querySelector("#loading");
      loading.classList.add("fatal");
      loading.textContent = "Saved progress could not load. Try refresh.";
      document.querySelector("#f3-line").textContent = "algebra_quest 1.0 | telemetry unavailable";
      document.querySelector("#main").setAttribute("aria-busy", "false");
      console.error(error);
    }
  }

  function tick() {
    if (document.hidden || reducedMotion()) return;
    if (revealQueue.length) {
      revealQueue.splice(0, 20).forEach(tile => {
        tile.classList.remove("reveal-hidden");
        tile.classList.add("reveal-visible");
      });
      return;
    }
    if (revealPending) {
      revealPending = false;
      document.querySelectorAll(".vault-slot.reveal-hidden").forEach(slot => {
        slot.classList.remove("reveal-hidden");
      });
      return;
    }
    if (currentData) renderHeader(currentData);
  }

  function startDriver() {
    stopDriver();
    if (!document.hidden && !reducedMotion()) intervalId = window.setInterval(tick, 250);
  }

  function stopDriver() {
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  }

  function handleVisibility() {
    const hidden = document.hidden;
    document.documentElement.classList.toggle("motion-paused", hidden);
    if (hidden) stopDriver();
    else startDriver();
  }

  function openVersionGate(item) {
    pendingArtifact = item;
    document.querySelector("#version-gate").hidden = false;
    document.querySelector("#mc-version").value = storageGet("mc.version", "") || "";
    document.querySelector("#mc-loader").value = storageGet("mc.loader", "vanilla") || "vanilla";
    document.querySelector("#mc-version").focus();
  }

  function closeVersionGate() {
    pendingArtifact = null;
    document.querySelector("#version-gate").hidden = true;
  }

  function previewArtifact(item) {
    const status = document.querySelector("#vault-status");
    status.textContent = `${item.name} · ${item.testedOn}.`;
  }

  // A tooltip is anchored under its own marker, and some markers sit at the right
  // edge of a panel, where a centred body would hang off the screen. Measure and
  // nudge it back inside when it opens rather than guessing at render time; the
  // body is laid out even while faded, so the box is real.
  function nudgeTip(mark) {
    const body = mark.querySelector(".tip__body");
    if (!body) return;
    body.style.setProperty("--tip-shift", "0px");
    const box = body.getBoundingClientRect();
    const margin = 8;
    const overRight = box.right - (document.documentElement.clientWidth - margin);
    const overLeft = margin - box.left;
    const shift = overRight > 0 ? -overRight : overLeft > 0 ? overLeft : 0;
    if (shift) body.style.setProperty("--tip-shift", `${Math.round(shift)}px`);
  }

  function bindEvents() {
    // pointerover covers hover on a trackpad and the tap that precedes focus on a
    // touchscreen; focusin covers Tab.
    document.addEventListener("pointerover", event => {
      const mark = event.target?.closest?.(".tip");
      if (mark) nudgeTip(mark);
    }, { passive: true });
    document.addEventListener("focusin", event => {
      const mark = event.target?.closest?.(".tip");
      if (mark) nudgeTip(mark);
    });
    document.addEventListener("visibilitychange", handleVisibility);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && zoomedRegion) closeRegion();
    });
    document.addEventListener("click", event => {
      if (revealQueue.length || revealPending) {
        revealQueue.forEach(tile => {
          tile.classList.remove("reveal-hidden");
          tile.classList.add("reveal-visible");
        });
        revealQueue = [];
        revealPending = false;
        document.querySelectorAll(".vault-slot.reveal-hidden").forEach(slot => {
          slot.classList.remove("reveal-hidden");
        });
      }
      if (event.target.closest("[data-wm-back]")) {
        closeRegion();
        return;
      }
      // Escape leaves a sub-map too, so zooming in is never a trap.
      const regionButton = event.target.closest(".wm-region");
      if (regionButton) {
        // A drag that ended on a chunk is a pan, not a click.
        const viewport = document.querySelector("#wm-viewport");
        const draggedAt = Number(viewport?.dataset.dragEndedAt ?? 0);
        if (draggedAt && Date.now() - draggedAt < 300) return;
        openRegion(regionButton.dataset.region);
        return;
      }
      const themeButton = event.target.closest("[data-set-theme]");
      if (themeButton && !themeButton.disabled) {
        const theme = themeButton.dataset.setTheme;
        if (VALID_THEMES.has(theme)) {
          storageSet("mc.theme", theme);
          applyTheme(currentData);
        }
      }
      const artifactButton = event.target.closest("[data-artifact]");
      if (artifactButton) {
        const item = artifacts.find(candidate => candidate.id === artifactButton.dataset.artifact);
        if (!item) return;
        const version = storageGet("mc.version", null);
        if (item.minVersion && !version) openVersionGate(item);
        else previewArtifact(item);
      }
    });

    document.querySelector("#refresh").addEventListener("click", () => loadData(true));
    document.querySelector("#show-route").addEventListener("click", () => {
      document.querySelector("#calendar").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" });
    });
    document.querySelector("#version-cancel").addEventListener("click", closeVersionGate);
    document.querySelector("#version-unsure").addEventListener("click", () => {
      storageSet("mc.version", null);
      storageSet("mc.loader", "unsure");
      closeVersionGate();
      document.querySelector("#vault-status").textContent = "Showing version-agnostic artifacts.";
    });
    document.querySelector("#version-form").addEventListener("submit", event => {
      event.preventDefault();
      const version = document.querySelector("#mc-version").value.trim();
      const loader = document.querySelector("#mc-loader").value;
      if (!version || !VALID_LOADERS.has(loader)) return;
      storageSet("mc.version", version);
      storageSet("mc.loader", loader);
      const item = pendingArtifact;
      closeVersionGate();
      if (item) previewArtifact(item);
      if (currentData) renderVault(currentData, unionEarned(currentData).earned, [], false);
      if (currentData) renderSkinCard();
    });
    document.querySelector("#request-form").addEventListener("submit", async event => {
      event.preventDefault();
      const text = document.querySelector("#request-text").value.trim();
      const status = document.querySelector("#request-status");
      if (!text) {
        status.textContent = "Write one idea first.";
        return;
      }
      // Opens a prefilled GitHub issue. No token in the page, and filing issues on
      // his own site is a real thing an engineer does.
      const title = text.split("\n")[0].slice(0, 70);
      const body = `${text}\n\n---\nFiled from the vault request box.`;
      const url = "https://github.com/jaime-espinosa/algebra-progress/issues/new"
        + `?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      window.open(url, "_blank", "noopener");
      status.textContent = "Opening GitHub. Hit submit there and it lands in the queue.";
    });
  }

  window.AlgebraQuest = Object.freeze({
    worldMap,
    mapLandmarks,
    remainingActivities,
    evaluateUnlocks,
    questDays,
    summarySnapshot,
    staleSafeData
  });

  bindEvents();
  // He is going to hit F12 and poke at this. That is the correct instinct for someone
  // who wants to build software, so the console rewards it instead of hiding from it.
  // There is nothing secret in this page: no keys, no tokens, no server. The unlock
  // state lives in localStorage and he can absolutely edit it — and if he reads enough
  // of this file to work out how, he has earned whatever he unlocks. Cheating here
  // costs him only the thing he was trying to get.
  const consoleStyle = "color:#6fdc82;font-family:ui-monospace,monospace";
  console.log("%calgebra_quest 1.0 — you found the console. Good.", consoleStyle);
  console.log("%cEverything here is yours to read. Try these:", consoleStyle);
  console.log("%c  quest.data()      the raw scrape driving this page", consoleStyle);
  console.log("%c  quest.pace()      how the projection is calculated", consoleStyle);
  console.log("%c  quest.effort()    your real numbers, per day", consoleStyle);
  console.log("%c  quest.map()       the world map, region by region", consoleStyle);
  console.log("%c  quest.vault()     what is unlocked and why", consoleStyle);
  console.log("%c  quest.source()    where the code and the scraper live", consoleStyle);
  window.quest = {
    data: () => currentData,
    pace: () => {
      const today = localIsoDate();
      const stats = effortStats(currentData, today);
      console.log("required/day =", (stats.remaining / stats.daysLeft).toFixed(2),
        "\nyour pace on working days =", stats.activePace.toFixed(2),
        "\nworking days needed =", stats.daysNeeded, "of", stats.daysLeft, "left");
      return stats;
    },
    map: () => {
      const map = worldMap(currentData);
      console.table(map.worlds.flatMap(world => world.regions).map(region => ({
        region: region.key, name: region.name,
        units: `${region.unitsDone}/${region.unitsTotal}`, status: region.status
      })));
      console.log("every block is one gradebook row —", map.totalDone, "of", map.totalUnits,
        "placed, the same total the UNITS DONE dial reads.");
      return map;
    },
    effort: () => Object.fromEntries([...submissionsByDay(currentData).entries()].sort()),
    vault: () => artifacts.map(item => ({
      id: item.id, tier: item.tier,
      earned: unionEarned(currentData).earned.has(item.id), files: item.files
    })),
    source: () => {
      console.log("site + scraper: https://github.com/jaime-espinosa/algebra-progress");
      console.log("the scraper is Playwright against Red Comet, run 3x a day by cron.");
      console.log("found a bug or want a reward? the request box files a real issue.");
      return "https://github.com/jaime-espinosa/algebra-progress";
    }
  };

  // Sections collapse and reorder, and both stick. This is his page: if he never wants
  // to see the calendar again, or wants the vault at the top because that is the part
  // he cares about, the layout should obey him rather than the order we happened to
  // pick. Order lives in storage as a list of ids, so a section added later simply
  // lands at the bottom instead of breaking the saved layout.
  // Bumped when the panel set changed: a saved order from before the world map
  // existed would have filtered "trophy" out and appended "worldmap" last,
  // burying the headline feature at the bottom of his page.
  const ORDER_KEY = "mc.sectionOrder.v2";
  const COLLAPSED_KEY = "mc.collapsed";

  function initSectionControls() {
    const page = document.querySelector("#main");
    const sections = [...page.querySelectorAll("section.panel")];
    const byId = new Map(sections.map(section => [section.id, section]));
    const collapsed = new Set(storageGet(COLLAPSED_KEY, []));

    function applyOrder() {
      const saved = storageGet(ORDER_KEY, []).filter(id => byId.has(id));
      const rest = sections.filter(section => !saved.includes(section.id)).map(s => s.id);
      for (const id of [...saved, ...rest]) page.append(byId.get(id));
    }

    function saveOrder() {
      storageSet(ORDER_KEY, [...page.querySelectorAll("section.panel")].map(s => s.id));
    }

    function setCollapsed(section, want) {
      // hidden would take the section out of the flow entirely, controls and all. The
      // heading has to stay reachable or there is no way back.
      section.querySelector(".sec-fold")?.setAttribute("aria-expanded", String(!want));
      // Repairs is already a <details>, and its heading is the <summary> inside it.
      // Hiding the panel's children would take that summary with it and leave no way
      // back, so that section collapses through its own open state instead.
      const details = section.querySelector("details");
      if (details) details.open = !want;
      else section.dataset.collapsed = want ? "1" : "";
      if (want) collapsed.add(section.id); else collapsed.delete(section.id);
      storageSet(COLLAPSED_KEY, [...collapsed]);
    }

    for (const section of sections) {
      const heading = section.querySelector(".section-heading");
      if (!heading) continue;
      const bar = document.createElement("div");
      bar.className = "sec-controls";
      bar.innerHTML = `
        <button type="button" class="sec-fold" aria-expanded="true" title="Collapse">&#9662;</button>
        <button type="button" class="sec-up" title="Move up">&#9650;</button>
        <button type="button" class="sec-down" title="Move down">&#9660;</button>`;
      // The repairs section's heading is a <summary> inside a <details>; putting the
      // controls next to the panel edge rather than inside the heading keeps one
      // markup path for every section.
      section.prepend(bar);

      bar.querySelector(".sec-fold").addEventListener("click", () => {
        setCollapsed(section, section.dataset.collapsed !== "1");
      });
      bar.querySelector(".sec-up").addEventListener("click", () => {
        const previous = section.previousElementSibling;
        if (previous?.matches("section.panel")) { previous.before(section); saveOrder(); }
      });
      bar.querySelector(".sec-down").addEventListener("click", () => {
        const next = section.nextElementSibling;
        if (next?.matches("section.panel")) { next.after(section); saveOrder(); }
      });
      // Clicking the heading itself folds too — the buttons are small on a laptop
      // trackpad and the heading is a big obvious target.
      if (heading.tagName !== "SUMMARY") {
        heading.style.cursor = "pointer";
        heading.addEventListener("click", () => {
          setCollapsed(section, section.dataset.collapsed !== "1");
        });
      }
    }

    applyOrder();
    for (const section of sections) if (collapsed.has(section.id)) setCollapsed(section, true);
  }

  // finally, not then: if the data load fails the page still renders its last known
  // good state, and the controls have to come with it.
  Promise.all([loadManifest(), loadGames(), loadActivity()]).then(loadData).finally(initSectionControls);
})();
