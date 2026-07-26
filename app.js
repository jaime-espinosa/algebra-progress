import { effortStats as questEffort, computePace, dashboard, openTime, planTrack, evaluateUnlocks } from "./js/quest.mjs";

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
  const sectionIds = ["trophy", "effort", "vault", "calendar", "quests", "pace", "repairs", "lesson", "request", "games"];

  // vault/manifest.json is the single source of truth for artifacts. Hardcoding a
  // second copy here drifted immediately: it advertised the victory pack as 1.21.x
  // when the built pack is pack_format 15, i.e. 1.20.1 only. Telling him a reward
  // works on his version when it does not is the one unrecoverable failure.
  let artifacts = [];

  let currentData = null;
  let currentActivity = null;
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
          aria-label="${escapeHtml(`Rows submitted per calendar day from ${formatDay(firstDate)} through ${formatDay(today)}. Zero-work days are plotted as zero. A reference line marks ${requiredPerDay.toFixed(1)} rows per day.`)}">
          ${yTicks}
          <line class="effort-graph__axis" x1="${left}" y1="${top}" x2="${left}" y2="${bottom}"></line>
          <line class="effort-graph__axis" x1="${right}" y1="${top}" x2="${right}" y2="${bottom}"></line>
          <line class="effort-graph__axis" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"></line>
          <text class="effort-graph__axis-title" x="14" y="${(top + bottom) / 2}"
            text-anchor="middle" transform="rotate(-90 14 ${(top + bottom) / 2})">rows/day</text>
          <line class="effort-graph__reference" x1="${left}" y1="${requiredY.toFixed(2)}"
            x2="${right}" y2="${requiredY.toFixed(2)}"></line>
          <text class="effort-graph__reference-label" x="${left + 6}" y="${(requiredY - 5).toFixed(2)}"
            text-anchor="start">${requiredPerDay.toFixed(1)}/day — what Aug 15 needs</text>
          <polyline class="effort-graph__series" points="${points}"></polyline>
          ${squares}
          ${xLabels}
        </svg>
      </div>`;
  }

  // Deliberately NOT a second axis on the graph above. Pairing open time with rows
  // per day would imply a relationship the data does not support: Jul 20 was 13
  // rows in 7.5 hours, Jul 24 was 1 row in 10.3 hours, and one of those 10.3 hours
  // is a browser tab left open from 12:07 AM. A rate built from that reads "619
  // minutes per row", which is both wrong and the exact discouraging message this
  // page exists to undo. The honest, motivating figure is the lifetime total, so
  // that leads, sits beside the show-up gauge, and is never divided by anything.
  function openTimePanel(activity, today) {
    if (!activity) return "";
    const open = openTime(activity, today);
    if (!open.totalSeconds) return "";
    const marked = open.stretches.slice(0, 3).map(stretch =>
      `<li>${formatDay(stretch.date)} — ${escapeHtml(stretch.text)}${
        stretch.startTime ? ` starting ${escapeHtml(stretch.startTime)}` : ""}</li>`).join("");
    return `
      <section class="open-time" aria-label="Time the course was open">
        <strong class="open-time__total numeric">${escapeHtml(open.totalText)}</strong>
        <span class="open-time__caption">TIME THE COURSE HAS BEEN OPEN</span>
        <span class="quiet">across ${open.dayCount} days, ${formatDay(open.firstDay)} to ${formatDay(open.lastDay)}</span>
        <p class="open-time__note quiet">
          This is what the LMS actually measures: how long the course page was open.
          It is not a measure of how hard you worked, and it is never divided by rows.
        </p>
        ${marked ? `
        <details class="open-time__marked">
          <summary>${open.stretches.length} long stretch${open.stretches.length === 1 ? "" : "es"} counted in that total</summary>
          <p class="quiet">Nothing logs you out, so a tab left open keeps counting.
            These are still inside the ${escapeHtml(open.totalText)} above — nothing has been removed:</p>
          <ul>${marked}</ul>
        </details>` : ""}
        ${open.asOf ? `<span class="quiet open-time__asof">Activity report read ${formatDay(open.asOf)}.</span>` : ""}
      </section>`;
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

      ${openTimePanel(currentActivity, today)}

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

  function calendarReward(track) {
    if (track.comeback) {
      const { from, to, gain, days, rows } = track.comeback;
      // Lead with the plain count he can verify by adding up his own calendar
      // tiles, then the comparison. Showing only the difference invites him to
      // count 25, see 15, and stop trusting the page.
      return `${rows} rows in ${days} days, ${formatDay(from)} to ${formatDay(to)} — ${gain} more than the route asked for.`;
    }
    const biggestPush = track.bestDays[0];
    if (biggestPush) {
      return `Your biggest push: ${biggestPush.done} rows on ${formatDay(biggestPush.date)}.`;
    }
    return "Every row you finish moves the route forward.";
  }

  function calendarChart(track) {
    const width = 760;
    const height = 220;
    const left = 58;
    const right = 18;
    const top = 24;
    const bottom = 38;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const lastIndex = Math.max(1, track.points.length - 1);
    const yMax = Math.max(1, track.totalRows);
    const xAt = index => left + (index / lastIndex) * plotWidth;
    const yAt = value => top + (1 - value / yMax) * plotHeight;
    const pointList = (points, valueFor) => points
      .map(({ point, index }) => `${xAt(index).toFixed(1)},${yAt(valueFor(point)).toFixed(1)}`)
      .join(" ");
    const indexed = track.points.map((point, index) => ({ point, index }));
    const past = indexed.filter(({ point }) => !point.future);
    const adjusted = indexed.filter(({ point }) => point.adjusted !== null);
    const actualPoints = pointList(past, point => point.cumDone);
    const steadyPoints = pointList(past, point => point.steady);
    const adjustedPoints = pointList(adjusted, point => point.adjusted);
    const ticks = [...new Set([0, Math.round(track.totalRows / 2), track.totalRows])];
    const grid = ticks.map(value => {
      const y = yAt(value).toFixed(1);
      return `
        <line class="calendar-chart__grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line>
        <text class="calendar-chart__label" x="${left - 8}" y="${Number(y) + 5}" text-anchor="end">${escapeHtml(value)}</text>`;
    }).join("");
    const todayIndex = track.points.findIndex(point => point.date === track.today);
    const todayX = xAt(Math.max(0, todayIndex)).toFixed(1);
    const markers = past.filter(({ point }) => point.beatPlan).map(({ point, index }) => {
      const x = xAt(index);
      const y = yAt(point.cumDone);
      const surplus = Math.round(point.surplus);
      const title = `${formatDay(point.date)}: ${point.done} rows, ${surplus} more than the steady route asked for`;
      return `<polygon class="calendar-chart__marker" points="${x.toFixed(1)},${(y - 8).toFixed(1)} ${(x - 7).toFixed(1)},${(y + 5).toFixed(1)} ${(x + 7).toFixed(1)},${(y + 5).toFixed(1)}" shape-rendering="crispEdges"><title>${escapeHtml(title)}</title></polygon>`;
    }).join("");
    const ariaLabel = `Cumulative rows done from ${formatDay(track.firstDay)} through ${formatDay(track.deadline)}. The actual work line is compared with the steady route and the adjusted route finishing all ${track.totalRows} rows by ${formatDay(track.finishesOn)}. Triangles mark days that beat the steady route.`;

    return `
      <div class="calendar-chart">
        <div class="calendar-chart__key numeric" aria-hidden="true">
          <span><b class="calendar-chart__swatch is-actual"></b>actual</span>
          <span><b class="calendar-chart__swatch is-steady"></b>steady route</span>
          <span><b class="calendar-chart__swatch is-adjusted"></b>adjusted route — all ${escapeHtml(track.totalRows)} done by ${escapeHtml(formatDay(track.finishesOn))}</span>
        </div>
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(ariaLabel)}">
          ${grid}
          <line class="calendar-chart__axis" x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}"></line>
          <line class="calendar-chart__axis" x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}"></line>
          <text class="calendar-chart__axis-title" x="18" y="${top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 18 ${top + plotHeight / 2})">rows done</text>
          <text class="calendar-chart__label" x="${left}" y="${height - 10}">${escapeHtml(formatDay(track.firstDay))}</text>
          <text class="calendar-chart__label" x="${width - right}" y="${height - 10}" text-anchor="end">${escapeHtml(formatDay(track.deadline))}</text>
          <line class="calendar-chart__today" x1="${todayX}" y1="${top}" x2="${todayX}" y2="${height - bottom}"></line>
          <text class="calendar-chart__today-label" x="${todayX}" y="17" text-anchor="middle">today</text>
          <polyline class="calendar-chart__steady" points="${steadyPoints}"></polyline>
          <polyline class="calendar-chart__adjusted" points="${adjustedPoints}"></polyline>
          <polyline class="calendar-chart__actual" points="${actualPoints}"></polyline>
          ${markers}
        </svg>
      </div>`;
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
      tooltip = `${formatDay(point.date)}: ${point.done} rows — ${roundedSurplus} more than the steady route asked for`;
    } else if (point.done > 0) {
      tooltip = `${formatDay(point.date)}: ${point.done} ${point.done === 1 ? "row" : "rows"}`;
    } else if (point.planned > 0 && (point.future || isToday)) {
      tooltip = `planned: ${point.planned} ${point.planned === 1 ? "row" : "rows"}`;
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
    const rowsLeft = track.totalRows - track.submitted;
    const plannedDaily = Math.max(0, ...track.points.map(point => point.planned));
    const daysInside = Math.max(0, dateDiff(track.finishesOn, track.deadline));
    const caption = `steady route: all ${track.totalRows} rows spread evenly from ${formatDay(track.firstDay)} to ${formatDay(track.deadline)}, about ${track.steadyRate.toFixed(1)} a day. adjusted route: the ${rowsLeft} rows still to do, ${plannedDaily} a day from today, finished ${formatDay(track.finishesOn)} — ${daysInside} days inside the deadline.`;
    document.querySelector("#calendar-content").innerHTML = `
      <div class="big-number numeric">${daysLeft} days</div>
      <div class="quiet">${escapeHtml(data.deadline.label)}</div>
      <div class="calendar-comeback">${escapeHtml(calendarReward(track))}</div>
      ${calendarChart(track)}
      <p class="calendar-chart__caption quiet numeric">${escapeHtml(caption)}</p>
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
  async function linkExistingLessons() {
    const targets = [...document.querySelectorAll("#lesson-content [data-slug]")];
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
    renderTrophy(safeData, previousSnapshot, isNewSnapshot);
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
  Promise.all([loadManifest(), loadGames(), loadActivity()]).then(loadData).finally(initSectionControls);
})();
