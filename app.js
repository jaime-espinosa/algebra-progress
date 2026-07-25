(() => {
  "use strict";

  const DAY_MS = 86_400_000;
  const ZONE = "America/Los_Angeles";
  const BASELINE_DATE = "2026-07-24";
  const PROVEN_PER_DAY = 1.7;
  const VALID_THEMES = new Set(["overworld", "nether", "end"]);
  const VALID_LOADERS = new Set(["vanilla", "fabric", "forge", "neoforge", "unsure"]);
  const sectionIds = ["trophy", "vault", "calendar", "quests", "pace", "repairs", "lesson", "request"];

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

  function nextScrapeTime(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE,
      hour: "numeric",
      hour12: false
    }).formatToParts(now);
    const hour = Number(parts.find(item => item.type === "hour")?.value ?? 0);
    return hour < 14 ? "14:00" : "06:00";
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

  function submittedAfterBaseline(data) {
    return data.semesters.flatMap(semester => semester.activities).filter(item =>
      item.state !== "not_started" &&
      typeof item.submittedDate === "string" &&
      item.submittedDate > BASELINE_DATE);
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

  function renderCalendar(data) {
    const today = localIsoDate();
    const daysLeft = Math.max(0, dateDiff(today, data.deadline.date));
    const days = Array.from({ length: 25 }, (_, index) => {
      const day = index + 1;
      const iso = `2026-08-${String(day).padStart(2, "0")}`;
      const classes = [
        "calendar-day",
        iso === data.deadline.date ? "is-deadline" : "",
        iso > data.deadline.date ? "is-reference" : ""
      ].filter(Boolean).join(" ");
      const label = iso === data.deadline.date ? `<strong>${day}<br>AUG 15</strong>` : day;
      return `<div class="${classes}" aria-label="${formatDay(iso)}">${label}</div>`;
    });
    days.splice(15, 0, `<div class="calendar-rule">LMS says Aug 25. Ignore it.</div>`);
    document.querySelector("#calendar-content").innerHTML = `
      <div class="big-number numeric">${daysLeft} days</div>
      <div class="quiet">${escapeHtml(data.deadline.label)}</div>
      <div class="calendar-grid" aria-label="August 2026">${days.join("")}</div>`;
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
    // Derived from real submission dates. This was previously hardcoded to "7 (Jul 11)",
    // a number that was never true — inventing a personal best he never set is exactly
    // the kind of thing he could check and catch.
    const perDay = new Map();
    for (const item of data.semesters.flatMap(semester => semester.activities)) {
      if (item.state === "not_started" || typeof item.submittedDate !== "string") continue;
      perDay.set(item.submittedDate, (perDay.get(item.submittedDate) || 0) + 1);
    }
    const bestDay = [...perDay.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((left, right) => right.count - left.count || (left.date < right.date ? -1 : 1))[0] || null;
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
    const provenDays = Math.ceil(remaining.length / Math.max(PROVEN_PER_DAY, .1));
    const provenDate = addDays(today, provenDays);
    const closesGap = Math.min(4, required);
    const doneWidth = (submitted / totalWork) * 100;
    const projectedRows = Math.min(remaining.length, Math.floor(PROVEN_PER_DAY * daysLeft));
    const projectedWidth = (projectedRows / totalWork) * 100;
    const gapWidth = Math.max(0, 100 - doneWidth - projectedWidth);
    // Describes the PLAN, not a claim about where he stands. Saying "you're 4 days
    // ahead" because he typed 4 into a box would be a lie he can check.
    const ahead = dateDiff(projectedDate, data.deadline.date);
    const statusCopy = projectedDate <= data.deadline.date
      ? `That plan lands ${Math.max(0, ahead)} days before the deadline.`
      : `That plan lands after Aug 15. ${closesGap.toFixed(1)} a day reaches it.`;
    const next = remaining[0];

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
        <span>Aug 15 needs&nbsp;&nbsp; <strong>${required.toFixed(1)}/day</strong>. You have run ${PROVEN_PER_DAY.toFixed(1)}/day, which finishes ${formatDay(provenDate)}.</span>
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
    const lessonPath = next.semesterId === "sem1" ? "lessons/sem1-06.html" : "lessons/sem2-01.html";
    const section = data.semesters.find(item => item.id === next.semesterId)
      ?.sections.find(item => item.number === next.sectionNumber);
    document.querySelector("#lesson-content").innerHTML = `
      <span class="eyebrow">${escapeHtml(next.semesterId.toUpperCase())} // SECTION ${next.sectionNumber}</span>
      <h3>${escapeHtml(section?.name || next.sectionName || "Course orientation")}</h3>
      <p>You can open the strategy card before the next row.</p>
      <a class="action" href="${lessonPath}">Open mini-lesson</a>`;
  }

  function showSections() {
    document.querySelector("#loading").hidden = true;
    sectionIds.forEach(id => {
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
  loadManifest().then(loadData);
})();
