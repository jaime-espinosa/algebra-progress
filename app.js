import { effortStats as questEffort, computePace, dashboard } from "./js/quest.mjs";

(() => {
  "use strict";

  const DAY_MS = 86_400_000;
  const ZONE = "America/Los_Angeles";
  const VALID_THEMES = new Set(["overworld", "nether", "end"]);
  const VALID_LOADERS = new Set(["vanilla", "fabric", "forge", "neoforge", "unsure"]);
  const VALID_GAME_KINDS = new Set(["game", "puzzle", "tool", "video"]);
  // Mini-lesson files that exist under lessons/. Keep in sync when adding one.
  const LESSON_FILES = new Set([
    "sem1-01", "sem1-02", "sem1-03", "sem1-04", "sem1-05", "sem1-06",
    "sem2-01", "sem2-02", "sem2-03", "sem2-04", "sem2-05", "sem2-06"
  ]);
  const sectionIds = ["trophy", "effort", "vault", "calendar", "quests", "pace", "repairs", "lesson", "request", "games"];

  // vault/manifest.json is the single source of truth for artifacts. Hardcoding a
  // second copy here drifted immediately: it advertised the victory pack as 1.21.x
  // when the built pack is pack_format 15, i.e. 1.20.1 only. Telling him a reward
  // works on his version when it does not is the one unrecoverable failure.
  let artifacts = [];

  let currentData = null;
  let intervalId = null;
  let revealQueue = [];
  let revealCounter = null;
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

  function evaluateUnlocks(data) {
    const sem1 = data.semesters.find(semester => semester.id === "sem1");
    const sem2 = data.semesters.find(semester => semester.id === "sem2");
    const recent = submittedAfterBaseline(data);
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
    // Ids must match vault/manifest.json exactly, or a milestone silently unlocks
    // nothing.
    const conditions = {
      "algebra-miner-skin": (sem1?.allDone ?? 0) >= 90,
      "momentum-cursor-pet": sem1SectionsSealed >= 4,
      "sem1-victory-pack": (sem1?.percent ?? 0) >= 80,
      "nether-theme": sem2Submitted.length >= 3,
      "auto-breeding-pen": sectionDone(1),
      "ballistics-workbench": sectionDone(2),
      "target-practice": sectionDone(3),
      "surveyor": sectionDone(4),
      "farm-rate-optimizer": sectionDone(5),
      "youtube-analytics-template": sectionDone(6),
      "end-theme-final": data.semesters.every(semester =>
        semester.activities.every(item => item.state !== "not_started"))
    };
    return new Set(Object.keys(conditions).filter(id => conditions[id]));
  }

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
    const counts = data.semesters.map(semester =>
      `${semester.id === "sem1" ? "S1" : "S2"} ${safeNumber(semester.allDone)}/${safeNumber(semester.allTotal)}`
    ).join("  ");
    document.querySelector("#f3-line").textContent =
      `algebra_quest 1.0 | ${counts} | D-${days} | scraped ${formatTime(data.generatedAt)}  next ${nextScrapeTime()}`;
  }

  function safeNumber(value) {
    return Number.isFinite(value) ? value : "—";
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

  function renderTrophy(data, previousSnapshot, isNewSnapshot) {
    const semester = data.semesters.find(item => item.id === "sem1") ?? data.semesters[0];
    const total = Math.max(0, semester.allTotal || 0);
    const done = Math.min(total, Math.max(0, semester.allDone || 0));
    const completeSections = semester.sections.filter(section => section.complete).length;
    const tiles = Array.from({ length: total }, (_, index) => {
      const status = index < done ? " is-complete" : "";
      const reveal = isNewSnapshot && index < done ? " reveal-hidden" : "";
      return `<span class="chunk-tile${status}${reveal}" aria-hidden="true"></span>`;
    }).join("");
    // total > 0 guard: a zeroed payload makes done === total trivially true, which
    // would tell him he sealed the semester while the page shows 0/0.
    const completeCopy = total > 0 && done === total
      ? "Semester 1 sealed. Every activity is loaded."
      : `${total - done} activities remain in Semester 1.`;
    document.querySelector("#trophy-content").innerHTML = `
      <div class="trophy-summary">
        <div class="trophy-stats">
          <span class="eyebrow">YOU BUILT THIS</span>
          <strong class="big-number numeric">${safeNumber(semester.percent)?.toString()}%</strong>
          <span>${escapeHtml(semester.letter || "in progress")} · ${completeSections} sections sealed</span>
          <span class="quiet">${escapeHtml(completeCopy)}</span>
        </div>
        <div>
          <div class="chunk-map" aria-label="${done} of ${total} activities finished">${tiles}</div>
          <div id="trophy-footer" class="trophy-footer numeric">${done} activities loaded</div>
        </div>
      </div>`;

    if (isNewSnapshot && !reducedMotion()) {
      const oldDone = previousSnapshot?.sem1?.allDone ?? 0;
      const completedTiles = [...document.querySelectorAll(".chunk-tile.is-complete")];
      completedTiles.slice(0, Math.min(oldDone, done)).forEach(tile => {
        tile.classList.remove("reveal-hidden");
        tile.classList.add("reveal-visible");
      });
      revealQueue = completedTiles.slice(Math.min(oldDone, done));
      revealCounter = {
        node: document.querySelector("#trophy-footer"),
        value: Math.min(oldDone, done),
        target: done
      };
      revealCounter.node.textContent = `${revealCounter.value} activities loaded`;
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
      const action = isEarned
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

  function gaugeSvg({ ariaLabel, fraction, targetFrom = null, fillArc = false }) {
    const clamped = Math.max(0, Math.min(1, fraction));
    const ticks = Array.from({ length: 11 }, (_, index) => {
      const outer = gaugePoint(index / 10, 42);
      const inner = gaugePoint(index / 10, index % 5 === 0 ? 35 : 38);
      return `<line x1="${inner.x.toFixed(2)}" y1="${inner.y.toFixed(2)}" x2="${outer.x.toFixed(2)}" y2="${outer.y.toFixed(2)}"></line>`;
    }).join("");
    const needle = gaugePoint(clamped, 31);
    const target = targetFrom === null ? "" : `
      <path class="gauge__target" d="${gaugeArc(Math.max(0, Math.min(1, targetFrom)), 1, 34)}"></path>`;
    const progress = fillArc && clamped > 0 ? `
      <path class="gauge__progress" d="${gaugeArc(0, clamped)}"></path>` : "";
    return `
      <svg class="gauge__svg" viewBox="0 0 100 100" role="img"
        aria-label="${escapeHtml(ariaLabel)}">
        <path class="gauge__track" d="${gaugeArc(0, 1)}"></path>
        ${target}
        ${progress}
        <g class="gauge__ticks" shape-rendering="crispEdges">${ticks}</g>
        <line class="gauge__needle" x1="50" y1="50"
          x2="${needle.x.toFixed(2)}" y2="${needle.y.toFixed(2)}"
          shape-rendering="crispEdges"></line>
        <rect class="gauge__hub" x="47" y="47" width="6" height="6"></rect>
      </svg>`;
  }

  function effortGraph(perDay, today, requiredPerDay) {
    const activeDates = [...perDay.keys()].sort();
    const firstDate = activeDates[0] ?? today;
    const dayCount = Math.max(1, dateDiff(firstDate, today) + 1);
    const days = Array.from({ length: dayCount }, (_, index) => addDays(firstDate, index));
    const values = days.map(date => perDay.get(date) ?? 0);
    const maxDaily = Math.max(...values, 0);
    const yDivisor = Math.max(1, maxDaily);
    const left = 54;
    const right = 700;
    const top = 18;
    const bottom = 135;
    const width = right - left;
    const height = bottom - top;
    const xAt = index => left + (days.length === 1 ? 0 : index / (days.length - 1)) * width;
    const yAt = value => bottom - (value / yDivisor) * height;
    const points = values.map((value, index) =>
      `${xAt(index).toFixed(2)},${yAt(value).toFixed(2)}`).join(" ");
    const squares = values.map((value, index) => value > 0
      ? `<rect class="effort-graph__point" x="${(xAt(index) - 2).toFixed(2)}" y="${(yAt(value) - 2).toFixed(2)}" width="4" height="4">
          <title>${escapeHtml(formatDay(days[index]))}: ${value} rows</title>
        </rect>`
      : "").join("");
    const yTicks = Array.from({ length: 4 }, (_, index) => {
      const value = index === 3 ? maxDaily : Math.round(maxDaily * index / 3);
      const y = yAt(value);
      return `
        <line class="effort-graph__grid" x1="${left}" y1="${y.toFixed(2)}" x2="${right}" y2="${y.toFixed(2)}"></line>
        <text class="effort-graph__label" x="${left - 8}" y="${(y + 3).toFixed(2)}" text-anchor="end">${value}</text>`;
    }).join("");
    const xLabels = days.map((date, index) => {
      if (index % 7 !== 0 && index !== days.length - 1) return "";
      return `<text class="effort-graph__label" x="${xAt(index).toFixed(2)}" y="153"
        text-anchor="${index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}">${escapeHtml(formatDay(date))}</text>`;
    }).join("");
    const requiredY = yAt(Math.min(requiredPerDay, yDivisor));

    return `
      <div class="effort-graph">
        <svg viewBox="0 0 760 172" preserveAspectRatio="xMidYMid meet" role="img"
          aria-label="${escapeHtml(`Rows submitted per calendar day from ${formatDay(firstDate)} through ${formatDay(today)}. Zero-work days are plotted as zero. A reference line marks ${requiredPerDay.toFixed(1)} rows per day. The hours axis has no data.`)}">
          ${yTicks}
          <line class="effort-graph__axis" x1="${left}" y1="${top}" x2="${left}" y2="${bottom}"></line>
          <line class="effort-graph__axis" x1="${right}" y1="${top}" x2="${right}" y2="${bottom}"></line>
          <line class="effort-graph__axis" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"></line>
          <text class="effort-graph__axis-title" x="14" y="${(top + bottom) / 2}"
            text-anchor="middle" transform="rotate(-90 14 ${(top + bottom) / 2})">rows/day</text>
          <text class="effort-graph__axis-title" x="746" y="${(top + bottom) / 2}"
            text-anchor="middle" transform="rotate(90 746 ${(top + bottom) / 2})">hrs/day</text>
          <line class="effort-graph__reference" x1="${left}" y1="${requiredY.toFixed(2)}"
            x2="${right}" y2="${requiredY.toFixed(2)}"></line>
          <text class="effort-graph__reference-label" x="${right - 5}" y="${(requiredY - 5).toFixed(2)}"
            text-anchor="end">${requiredPerDay.toFixed(1)}/day — what Aug 15 needs</text>
          <polyline class="effort-graph__series" points="${points}"></polyline>
          ${squares}
          ${xLabels}
        </svg>
        <div class="effort-graph__caption quiet">hrs/day is not measured yet — it needs the LMS Activity tab, which has not been scraped.</div>
      </div>`;
  }

  function renderEffort(data) {
    const today = localIsoDate();
    const s = dashboard(data, today);
    const perDay = effortStats(data, today).perDay;
    const odometerDigits = String(s.odometer).split("").map(digit =>
      `<span class="effort-odometer__digit">${digit}</span>`).join("");
    const tachMax = Math.max(28, s.recent7);

    document.querySelector("#effort-content").innerHTML = `
      <section class="effort-odometer" aria-label="${s.odometer} rows submitted all time">
        <div class="effort-odometer__digits numeric">${odometerDigits}</div>
        <strong class="effort-odometer__caption">ROWS SUBMITTED — ALL TIME</strong>
        <span class="quiet">across ${s.activeDays} days you sat down</span>
        <span class="effort-odometer__promise">This number only ever goes up.</span>
      </section>

      <div class="effort-gauges">
        <article class="gauge">
          <h3>SPEEDOMETER</h3>
          ${gaugeSvg({
            ariaLabel: `Speedometer: ${s.activePace.toFixed(1)} rows per working day on a scale from 0 to 6. Aug 15 needs ${s.requiredPerDay.toFixed(1)} per day.`,
            fraction: s.activePace / 6,
            targetFrom: s.requiredPerDay / 6
          })}
          <div class="gauge__scale" aria-hidden="true"><span>0</span><span>3</span><span>6</span></div>
          <strong class="gauge__readout numeric">${s.activePace.toFixed(1)} /day</strong>
          <span class="gauge__label">rows per day, on days you work</span>
          <span class="gauge__note quiet">Aug 15 needs ${s.requiredPerDay.toFixed(1)}/day</span>
        </article>

        <article class="gauge">
          <h3>TACHOMETER</h3>
          ${gaugeSvg({
            ariaLabel: `Tachometer: ${s.recent7} raw rows from ${formatDay(s.recent7From)} through ${formatDay(s.recent7To)}, on a scale from 0 to ${tachMax}.`,
            fraction: s.recent7 / tachMax
          })}
          <div class="gauge__scale" aria-hidden="true"><span>0</span><span>${Math.round(tachMax / 2)}</span><span>${tachMax}</span></div>
          <strong class="gauge__readout numeric">${s.recent7} rows · last 7 days</strong>
          <span class="gauge__label quiet">the 7 days before that: ${s.prior7}</span>
        </article>

        <article class="gauge">
          <h3>TRIP</h3>
          ${gaugeSvg({
            ariaLabel: `Trip progress: ${Math.round(s.tripDone * 100)} percent of the course, with ${s.rowsLeft} rows to go and ${s.daysLeft} days left.`,
            fraction: s.tripDone,
            fillArc: true
          })}
          <div class="gauge__scale" aria-hidden="true"><span>0%</span><span>50%</span><span>100%</span></div>
          <strong class="gauge__readout numeric">${Math.round(s.tripDone * 100)}% of the course</strong>
          <span class="gauge__label quiet">${s.rowsLeft} rows to go · ${s.daysLeft} days left</span>
        </article>

        <article class="gauge">
          <h3>SHOW-UP</h3>
          ${gaugeSvg({
            ariaLabel: `Show-up gauge: ${s.activeDays} working days, ${Math.round(s.showUpRate * 100)} percent of calendar days since work began.`,
            fraction: s.showUpRate,
            fillArc: true
          })}
          <div class="gauge__scale" aria-hidden="true"><span>0%</span><span>50%</span><span>100%</span></div>
          <strong class="gauge__readout numeric">${s.activeDays} working days</strong>
          <span class="gauge__label">days the engine ran</span>
        </article>
      </div>

      <p class="effort-copy">
        You have submitted <strong>${s.odometer} rows across ${s.activeDays} days</strong>.
        On the days you work you average <strong>${s.activePace.toFixed(1)} a day</strong>,
        and Aug 15 needs <strong>${s.requiredPerDay.toFixed(1)}</strong>.
        ${s.fastEnough ? "<strong>You are already fast enough.</strong>" : ""}
        You need about <strong>${s.daysNeeded} working days</strong> out of the ${s.daysLeft} left.
        That is the whole game — show up, and the speed takes care of itself.
      </p>
      ${effortGraph(perDay, today, s.requiredPerDay)}`;
  }

  // Nothing past Aug 15 is drawn. Showing ten dead days after the deadline made the
  // grid read as a wall of time rather than a plan. The calendar now runs from his
  // first working day to the deadline and nowhere further.
  function renderCalendar(data) {
    const today = localIsoDate();
    const daysLeft = Math.max(0, dateDiff(today, data.deadline.date));
    const stats = effortStats(data, today);
    const planned = new Map();
    for (const item of remainingActivities(data)) {
      if (item.ourTarget) planned.set(item.ourTarget, (planned.get(item.ourTarget) || 0) + 1);
    }
    const dates = [...stats.perDay.keys()].sort();
    const start = dates.length ? dates[Math.max(0, dates.length - 10)] : today;
    const cells = [];
    for (let cursor = start; cursor <= data.deadline.date; cursor = addDays(cursor, 1)) {
      const done = stats.perDay.get(cursor) || 0;
      const plan = planned.get(cursor) || 0;
      const isPast = cursor < today;
      const isToday = cursor === today;
      const target = Math.max(1, Math.round(stats.activePace || 3));
      const classes = ["cal-cell"];
      let mark = "";
      if (cursor === data.deadline.date) classes.push("is-deadline");
      if (isToday) classes.push("is-today");
      if (done > 0) {
        classes.push("is-done");
        if (done >= target) { classes.push("is-pushing"); mark = "&#9650;"; }   // ahead
      } else if (isPast) {
        classes.push("is-idle");
      } else if (plan > 0) {
        classes.push("is-planned");
      }
      const count = done > 0 ? done : (isPast ? "" : plan || "");
      const label = cursor === data.deadline.date
        ? `<strong>AUG 15</strong>`
        : `<span class="cal-cell__d">${Number(cursor.slice(8))}</span><span class="cal-cell__n numeric">${count}</span>${mark}`;
      cells.push(`<div class="${classes.join(" ")}" title="${formatDay(cursor)}: ${done ? `${done} done` : plan ? `${plan} planned` : "nothing logged"}">${label}</div>`);
    }
    const pushDays = [...stats.perDay.entries()].filter(([, n]) => n >= Math.max(1, Math.round(stats.activePace))).length;
    document.querySelector("#calendar-content").innerHTML = `
      <div class="big-number numeric">${daysLeft} days</div>
      <div class="quiet">${escapeHtml(data.deadline.label)}</div>
      <div class="cal-strip" aria-label="Working days through Aug 15">${cells.join("")}</div>
      <div class="cal-key quiet numeric">
        <span><b class="k k--done"></b> worked</span>
        <span><b class="k k--push"></b> &#9650; big day (${pushDays} so far)</span>
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
      <div class="bar daily-bar" aria-label="${todayDone} of ${dailyAsk} rows today">
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
                 aria-label="rows I plan to do per day">
          <span>&nbsp;a day &rarr; finishes <strong>${formatDay(projectedDate)}</strong></span>
        </label>
        <span>Aug 15 needs&nbsp;&nbsp; <strong>${required.toFixed(1)}/day</strong>. On the days you work you do <strong>${stats.activePace.toFixed(1)}</strong>${stats.fastEnough ? " — more than enough" : ""}.</span>
        <span>${escapeHtml(statusCopy)}</span>
        <span>${next ? `Next action: ${escapeHtml(next.title)}` : "Every named row is submitted."}</span>
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

  function renderLesson(data) {
    const next = remainingActivities(data)[0];
    if (!next) {
      document.querySelector("#lesson-content").innerHTML =
        `<p>Every lesson is submitted. The route is clear.</p>`;
      return;
    }
    // Link the lesson that matches the next section. LESSON_FILES is the list of
    // files that actually exist on disk, so an unexpected section number drops the
    // link rather than shipping a 404 — a dead reward link is worse than none.
    const slug = `${next.semesterId}-${String(next.sectionNumber).padStart(2, "0")}`;
    const section = data.semesters.find(item => item.id === next.semesterId)
      ?.sections.find(item => item.number === next.sectionNumber);
    const link = LESSON_FILES.has(slug)
      ? `<a class="action" href="lessons/${slug}.html">Open mini-lesson</a>`
      : "";
    document.querySelector("#lesson-content").innerHTML = `
      <span class="eyebrow">${escapeHtml(next.semesterId.toUpperCase())} // SECTION ${next.sectionNumber}</span>
      <h3>${escapeHtml(section?.name || next.sectionName || "Course orientation")}</h3>
      ${link}`;
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
      if (!section || typeof section !== "object" || Array.isArray(section) ||
          !/^sem[12]$/.test(section.semester) ||
          !Number.isInteger(section.number) || section.number < 1 ||
          typeof section.name !== "string" || !section.name.trim() ||
          !Array.isArray(section.items)) return [];

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

    content.innerHTML = `<div class="quest-days">${sections.map(section => {
      const semester = section.semester === "sem1" ? "S1" : "S2";
      const number = String(section.number).padStart(2, "0");
      const items = section.items.map(item => `
        <li>
          <strong><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></strong><br>
          <span class="meta">${escapeHtml(item.kind)}${item.source === true ? " · source you can read" : ""}</span>
          <p class="why">${escapeHtml(item.why)}</p>
        </li>`).join("");
      return `<article class="quest-card">
        <h3>${semester} // SECTION ${number} · ${escapeHtml(section.name)}</h3>
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
    renderTrophy(safeData, previousSnapshot, isNewSnapshot);
    renderEffort(safeData);
    renderVault(safeData, earned, newlyEarned, isNewSnapshot);
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
        ? `No new rows yet · last checked ${formatTime(data.generatedAt)} · next ${nextScrapeTime()}`
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
      if (revealCounter) {
        revealCounter.value = Math.min(revealCounter.target, revealCounter.value + 20);
        revealCounter.node.textContent = `${revealCounter.value} activities loaded`;
      }
      return;
    }
    if (revealCounter) {
      revealCounter.node.textContent = `${revealCounter.target} activities loaded`;
      revealCounter = null;
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

  function bindEvents() {
    document.addEventListener("visibilitychange", handleVisibility);
    document.addEventListener("click", event => {
      if (revealQueue.length || revealCounter) {
        revealQueue.forEach(tile => {
          tile.classList.remove("reveal-hidden");
          tile.classList.add("reveal-visible");
        });
        revealQueue = [];
        if (revealCounter) {
          revealCounter.node.textContent = `${revealCounter.target} activities loaded`;
          revealCounter = null;
        }
        document.querySelectorAll(".vault-slot.reveal-hidden").forEach(slot => {
          slot.classList.remove("reveal-hidden");
        });
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
  const ORDER_KEY = "mc.sectionOrder";
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
  Promise.all([loadManifest(), loadGames()]).then(loadData).finally(initSectionControls);
})();
