import { effortStats as questEffort, computePace, dashboard, dialScale, percentTicks, openTimeSeries, planTrack, evaluateUnlocks, worldMap, mapLandmarks, worldTerrain, worldRoute, regionHorizon, headerSegments, questBoard, UNIT_TYPE_LABELS, UNIT_TYPE_PLURALS } from "./js/quest.mjs";
import { artifact, isTypingTarget, escapeHtml, localIsoDate, dateDiff, addDays, formatDay, formatTime, nextScrapeTime, summarySnapshot, snapshotsEqual, remainingActivities, submittedAfterBaseline, submissionsByDay, effortStats, todayCompleted, landmarkGlyph, terrainSvg, landmarkStructure, hereMarker, compassRose, mapLegend, territoryPlaque, routePaths, landmassBanner, renderWorldCard, renderWorldPopup, renderTerritoryTable, unitNode, spriteSvg, validSkinCache, skinPlaceholderSvg, blobDataUrl, gaugePoint, gaugeArc, tip, gaugeText, chartX, chartLegend, perDayChart, cumulativeChart, openTimePanel, calendarReward, calendarCell, questDays, lessonSlug, lessonCatalog, gameKindIcon, DAY_MS, CHART } from "./js/render/shared.mjs";

(() => {
  "use strict";

  const VALID_THEMES = new Set(["overworld", "nether", "end"]);
  const VALID_LOADERS = new Set(["vanilla", "fabric", "forge", "neoforge", "unsure"]);
  const VALID_GAME_KINDS = new Set(["game", "puzzle", "tool", "video"]);
  const MOMENTUM_CURSOR_ID = "momentum-cursor-pet";
  const MOMENTUM_CURSOR_KEY = "mc.momentumCursor";
  const PARENT_VIEW_KEY = "mc.parentView";
  const PARENT_PHRASE = [104, 101, 108, 108, 111]
    .map(code => String.fromCharCode(code))
    .join("");
  const finePointerQuery = window.matchMedia?.("(hover: hover) and (pointer: fine)");
  const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const contrastPointerQuery = window.matchMedia?.(
    "(forced-colors: active), (prefers-contrast: more)"
  );
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
  let currentTerrain = null;
  let intervalId = null;
  // Raised by renderVault when a newly earned slot is drawn hidden; cleared on
  // the next tick, which is what turns it into an arrival rather than a state.
  let revealPending = false;
  let pendingArtifact = null;
  let refreshMessage = "";
  let gamesRendered = false;
  let cursorEarned = false;
  let cursorFrameId = null;
  let petHasPosition = false;
  let petX = -80;
  let petY = -80;
  let pointerX = -80;
  let pointerY = -80;
  let parentKeyBuffer = "";


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

  function sessionGet(key, fallback) {
    try {
      const value = sessionStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function sessionSet(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // The curtain remains usable for this page load when session storage is blocked.
    }
  }

  function parentViewActive() {
    return document.documentElement.dataset.view === "parent";
  }

  function setParentView(active) {
    document.documentElement.dataset.view = active ? "parent" : "child";
    sessionSet(PARENT_VIEW_KEY, active);
    const exit = document.querySelector("#exit-parent");
    if (exit) exit.hidden = !active;
    document.querySelectorAll("details.parent-expanded").forEach(details => {
      details.open = active;
    });
  }


  function listenForParentPhrase(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
    if (isTypingTarget(event.target)) {
      parentKeyBuffer = "";
      return;
    }
    parentKeyBuffer = `${parentKeyBuffer}${event.key.toLowerCase()}`.slice(-PARENT_PHRASE.length);
    if (parentKeyBuffer !== PARENT_PHRASE) return;
    parentKeyBuffer = "";
    setParentView(!parentViewActive());
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
    const segments = headerSegments(data, today);
    document.querySelector("#f3-line").textContent =
      `algebra_quest 1.0 | ${segments.join(" | ")} | checked ${formatTime(data.generatedAt)}`;
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


  // How far one arrow-key press moves the map, in pixels of the canvas.
  const PAN_STEP = 96;
  // Pan state for the level-1 canvas. Kept out of the DOM so a redraw on a new
  // scrape does not throw him back to the corner he started in.
  let panX = 0;
  let panY = 0;
  let zoomedRegion = null;
  let worldPopupOpener = null;
  // First paint centres the viewport on the territory holding his next unit.
  // Only the first: a later redraw must not yank the map out from under a pan
  // he is in the middle of.
  let panInitialised = false;




















  function openWorldPopup(worldId) {
    const opener = document.querySelector(`[data-world-card="${worldId}"]`);
    const popup = document.querySelector(`#wm-world-popup-${worldId}`);
    if (!opener || !(popup instanceof HTMLDialogElement)) return;
    closeWorldPopup(false);
    worldPopupOpener = opener;
    opener.setAttribute("aria-expanded", "true");
    popup.show();
    popup.querySelector(".wm-world-popup__close")?.focus();
  }

  function closeWorldPopup(restoreFocus = true) {
    const popup = document.querySelector(".wm-world-popup[open]");
    if (popup instanceof HTMLDialogElement) popup.close();
    const opener = worldPopupOpener;
    worldPopupOpener = null;
    opener?.setAttribute("aria-expanded", "false");
    if (restoreFocus && opener?.isConnected) opener.focus();
  }

  function renderWholePicture(map, data) {
    const remaining = remainingActivities(data);
    const worldTotals = map.worlds.map(world => `
      <li><strong>${escapeHtml(world.name)}</strong>:
        <span class="numeric">${world.unitsDone} done · ${world.unitsLeft} remaining · ${world.unitsTotal} total</span>
      </li>`).join("");
    const upcoming = remaining.map(item => `
      <li><strong>${escapeHtml(item.title)}</strong>
        <span class="meta">${escapeHtml(item.semesterId.toUpperCase())} · Section ${item.sectionNumber}</span>
      </li>`).join("");
    return `
      <details id="whole-picture" class="whole-picture parent-expanded"${parentViewActive() ? " open" : ""}>
        <summary>The whole picture</summary>
        <div class="whole-picture__summary">
          <strong class="whole-picture__done numeric">${map.totalDone} units done</strong>
          <span class="whole-picture__remaining numeric">${map.totalUnits - map.totalDone} remaining · ${map.totalUnits} total</span>
          <ul class="whole-picture__worlds">${worldTotals}</ul>
        </div>
        <h3>All upcoming work</h3>
        <ol class="whole-picture__tasks">${upcoming || "<li>Every named unit is submitted.</li>"}</ol>
      </details>`;
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
          <li>${gameKindIcon(item.kind)}
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
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
    // A hidden panel measures 0 x 0. Clamping against that pins the map to the
    // corner and then never un-pins it, which is exactly how the first paint
    // lost its "centre on where he is standing" — the panel is still hidden
    // when the map is drawn. Unmeasurable means leave the pan alone.
    if (viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
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

    // The terrain. Generated here rather than shipped as data: it is a pure
    // function of the map, so sending it over the wire would only be sending
    // something the browser can rebuild in ~35ms, and it would go stale the
    // moment a unit landed.
    const terrain = worldTerrain(map);
    currentTerrain = terrain;
    const spotOf = new Map(terrain.territories.map(item => [item.key, item]));
    const massOf = new Map(terrain.landmasses.map(item => [item.worldId, item]));

    // Landmarks stand where mapLandmarks() puts them. The three he has already
    // earned carry no region — they were unlocked by work spread across the
    // whole of World I — so they are stood on World I's settled ground, in
    // route order, rather than dropped in the sea.
    const settled = map.worlds[0]?.regions.filter(region => region.status === "settled") ?? [];
    const marks = [];
    const perRegion = new Map();
    currentLandmarks.forEach((entry, index) => {
      const key = entry.regionKey
        ?? (entry.earned ? settled[index % Math.max(1, settled.length)]?.key : null);
      const spot = key ? spotOf.get(key) : null;
      if (!spot) return;
      const seen = perRegion.get(key) ?? 0;
      perRegion.set(key, seen + 1);
      marks.push(landmarkStructure(spot.cx, spot.cy + 30 + seen * 10, entry.earned, seen));
    });
    const hereSpot = map.next ? spotOf.get(map.next.regionKey) : null;
    // The road, drawn under the markers. Its order is region route order and
    // nothing else, so it can never suggest he may take the sections in some
    // other order or leave one out.
    const route = worldRoute(terrain);
    const overlaySvg = `<svg class="wm-overlay" viewBox="0 0 ${terrain.width} ${terrain.height}"
          width="${terrain.width}" height="${terrain.height}" aria-hidden="true" focusable="false"
          shape-rendering="auto" xmlns="http://www.w3.org/2000/svg">
          ${routePaths(route)}${compassRose(terrain.width * 0.53, terrain.height * 0.82)}
          ${marks.join("")}${hereSpot ? hereMarker(hereSpot.cx, hereSpot.cy + 18) : ""}</svg>`;

    document.querySelector("#worldmap-content").innerHTML = map.worlds.length
      ? `
      ${renderWholePicture(map, data)}
      <div class="wm-worlds">${map.worlds.map(world => renderWorldCard(world)).join("")}</div>
      ${map.worlds.map(world =>
        renderWorldPopup(world, landmarksFor(world.id))).join("")}
      <div id="wm-viewport" class="wm-viewport" tabindex="0" role="group"
        aria-label="World map. Drag or use the arrow keys to pan. Click a territory to zoom in.">
        <div id="wm-canvas" class="wm-canvas" style="width:${terrain.width}px;height:${terrain.height}px">
          ${terrainSvg(terrain)}
          ${overlaySvg}
          ${map.worlds.map(world => {
            const mass = massOf.get(world.id);
            return mass ? landmassBanner(world, mass) : "";
          }).join("")}
          ${regions.map(region => {
            const spot = spotOf.get(region.key);
            return spot ? territoryPlaque(region, spot) : "";
          }).join("")}
        </div>
      </div>
      <div class="wm-zoom" id="wm-zoom" role="group" aria-labelledby="wm-zoom-heading" hidden></div>
      ${mapLegend(terrain)}
      ${renderTerritoryTable(map)}`
      : `<p class="quiet">Saved telemetry is thin right now — the map redraws on the next check.</p>`;

    wireViewport();
    // Open on the ground he is standing on rather than on the top-left corner
    // of the ocean. Deferred a frame because the panel is still hidden while it
    // is being drawn, and a hidden panel cannot be measured. Once only: a later
    // redraw must not yank the map out of a pan he is in the middle of.
    if (hereSpot && !panInitialised) {
      panInitialised = true;
      const centre = () => {
        const viewport = document.querySelector("#wm-viewport");
        if (!viewport || viewport.clientWidth === 0) {
          window.requestAnimationFrame(centre);
          return;
        }
        panX = -(hereSpot.cx - viewport.clientWidth / 2);
        panY = -(hereSpot.cy - viewport.clientHeight / 2);
        clampPan();
      };
      window.requestAnimationFrame(centre);
    }
    clampPan();
    if (openKey && findRegion(openKey)) openRegion(openKey);
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
    // A newly earned slot is drawn hidden and revealed one tick later, so it
    // lands as an event rather than as part of the page. The flag used to be
    // raised by the world map — it drew the last reveal on the page and the
    // vault rode in behind it — which meant deleting the map's block reveal
    // silently left every new artifact invisible. It is raised here now,
    // beside the thing it is actually about.
    if (isNewSnapshot && !reducedMotion()
      && document.querySelector("#hotbar .vault-slot.reveal-hidden")) revealPending = true;
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
    track: 46.5, tickOuter: 44, majorInner: 37, minorInner: 40.5, numbers: 33.5,
    scale2Arc: 25.5, scale2Outer: 27.5, scale2Inner: 23.5, scale2Numbers: 18,
    needle: 42,
  };

  function gaugeTick(at, fromRadius, toRadius) {
    const from = gaugePoint(at, fromRadius);
    const to = gaugePoint(at, toRadius);
    return `<line x1="${from.x.toFixed(2)}" y1="${from.y.toFixed(2)}" x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}"></line>`;
  }


  function gaugeDial({
    label, scale, secondary, faceUnit, readout, readoutSub, ariaText,
    bandTo = 1, outOfRangeFrom = null, thresholdBands = [],
  }) {
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
            <text class="gauge__scale2-unit" x="50" y="94" text-anchor="middle">${escapeHtml(secondary.unit)}</text>` : "";

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
    const outOfRange = Number.isFinite(outOfRangeFrom) && outOfRangeFrom < 1 ? `
            <path class="gauge__out-of-range" d="${gaugeArc(Math.max(0, outOfRangeFrom), 1, GAUGE.track)}"></path>` : "";
    const thresholds = thresholdBands.map(({ className, from, to, boundary }) => `
            <path class="gauge__threshold-band ${className}"
              data-boundary="${escapeHtml(boundary)}"
              d="${gaugeArc(Math.max(0, from), Math.min(1, to), GAUGE.track)}"></path>`).join("");
    const angle = (135 + clamped * 270).toFixed(2);

    return `
      <article class="gauge">
        <div class="gauge__face">
          <svg class="gauge__svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
            <circle class="gauge__disc" cx="50" cy="50" r="49"></circle>
            <path class="gauge__track" d="${gaugeArc(0, 1, GAUGE.track)}"></path>
            ${ahead}
            ${progress}
            ${outOfRange}
            ${thresholds}
            <g class="gauge__minors" shape-rendering="crispEdges">${minors}</g>
            <g class="gauge__majors" shape-rendering="crispEdges">${majors}</g>
            <g class="gauge__numbers">${numbers}</g>
            ${scale2}
            <text class="gauge__face-unit" x="50" y="87" text-anchor="middle">${escapeHtml(faceUnit)}</text>
            <g class="gauge__needle" style="transform: rotate(${angle}deg)">
              <polygon points="42,48.3 92,50 42,51.7 40,50"></polygon>
            </g>
            <circle class="gauge__hub" cx="50" cy="50" r="4"></circle>
            <circle class="gauge__hub-pin" cx="50" cy="50" r="1.4"></circle>
          </svg>
          <div class="gauge__window" aria-hidden="true">
            ${numeralPlate(readout, "dial")}
            ${readoutSub ? `<span class="gauge__window-sub numeric">${escapeHtml(readoutSub)}</span>` : ""}
          </div>
          <p class="gauge__sr">${escapeHtml(`${label}. ${ariaText}`)}</p>
        </div>
      </article>`;
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
    const recentScale = dialScale(s.recent3, Math.max(1, s.recent3));
    const doneScale = dialScale(s.odometer, totalUnits);
    const daysScale = dialScale(s.activeDays, calendarSpan);
    // Owner-granted dial-only exception: the current Aug 15 pace boundary is
    // 3.38/day, and fifty percent above it is 3.38 × 1.5 = 5.07/day.
    const paceBandNeeded = 3.38;
    const paceBandOrange = Number((paceBandNeeded * 1.5).toFixed(2));
    const pacePercent = s.requiredPerDay > 0 ? Math.round((s.activePace / s.requiredPerDay) * 100) : 0;
    const recentPercent = s.rowsLeft > 0 ? Math.round((s.recent3 / s.rowsLeft) * 100) : 0;
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
          thresholdBands: [
            {
              className: "is-below-pace",
              from: 0,
              to: paceBandNeeded / paceScale.max,
              boundary: `below ${paceBandNeeded.toFixed(2)}`,
            },
            {
              className: "is-at-pace",
              from: paceBandNeeded / paceScale.max,
              to: paceBandOrange / paceScale.max,
              boundary: `${paceBandNeeded.toFixed(2)} to ${paceBandOrange.toFixed(2)}`,
            },
            {
              className: "is-over-fifty",
              from: paceBandOrange / paceScale.max,
              to: 1,
              boundary: `${paceBandOrange.toFixed(2)} and above`,
            },
          ],
          ariaText: `Units per day on the days you work: ${s.activePace.toFixed(2)}, on a dial reading 0 to ${paceScale.max} units per day — ${s.odometer} units over ${s.activeDays} working days. Aug 15 needs ${s.requiredPerDay.toFixed(2)} a day, so the inner amber percentage scale reads ${pacePercent} percent of that pace. Below ${paceBandNeeded.toFixed(2)} units per day is the wide solid red rim band; ${paceBandNeeded.toFixed(2)} through ${paceBandOrange.toFixed(2)} is the narrower long-dash green band; ${paceBandOrange.toFixed(2)} and above is the widest short-dash orange band, fifty percent over the needed pace.`
        })}

        ${gaugeDial({
          label: "LAST 3 DAYS",
          hint: `A raw count of units submitted ${formatDay(s.recent3From)} through ${formatDay(s.recent3To)}. Not a rate. The inner amber scale is that same count as a percentage of the ${s.rowsLeft} units still to do.`,
          scale: recentScale,
          secondary: { unit: "% OF 3-DAY SCALE", ticks: percentTicks(recentScale.max, recentScale.max) },
          faceUnit: "UNITS / 3 DAYS",
          readout: String(s.recent3),
          readoutSub: `PREV 3: ${s.prior3}`,
          bandTo: 1,
          ariaText: `${s.recent3} units submitted from ${formatDay(s.recent3From)} through ${formatDay(s.recent3To)}, on a dial reading 0 to ${recentScale.max} units. The three days before that were ${s.prior3}. The inner amber percentage scale reads those three days as ${recentPercent} percent of the ${s.rowsLeft} units still to do. ${BAND_TEXT}`
        })}

        ${gaugeDial({
          label: "UNITS DONE",
          hint: `Every unit you have submitted, out of ${totalUnits} across both semesters. It only ever goes up. The inner amber scale is the same needle as a percentage of all ${totalUnits}.`,
          scale: doneScale,
          secondary: { unit: "% COMPLETE", ticks: percentTicks(doneScale.max, totalUnits) },
          faceUnit: "UNITS SUBMITTED",
          readout: String(s.odometer),
          readoutSub: "KEEPS CLIMBING",
          bandTo: totalUnits / doneScale.max,
          outOfRangeFrom: totalUnits / doneScale.max,
          ariaText: `${s.odometer} of ${totalUnits} units submitted across both semesters, ${s.rowsLeft} still to do, on a dial reading 0 to ${doneScale.max} units. The inner amber percentage scale reads ${donePercent} percent of all ${totalUnits}. The thick band on the rim covers the ${s.odometer} you have done and the thin dashed band runs on to the ${totalUnits}th unit. The neutral shaded rim after ${totalUnits} is outside the course total.`
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

      <div class="chart-pair">
        ${chartLegend(s, series, track)}
        <div class="chart-pair__plots" style="--today-left: ${(chartX(track, Math.max(0, track.points.findIndex(point => point.date === track.today))) / CHART.width * 100).toFixed(4)}%">
          <div class="chart-today-span" aria-hidden="true"><span>today</span></div>
          ${perDayChart(track, perDay, s.requiredPerDay, series)}
          ${cumulativeChart(track)}
        </div>
      </div>
      ${openTimePanel(series)}`;
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


  function renderQuests(data) {
    const groups = questBoard(data, localIsoDate());
    const remaining = remainingActivities(data);
    const sem1Open = data.semesters.find(item => item.id === "sem1")
      ?.activities.some(item => item.state === "not_started");
    document.querySelector("#quest-content").innerHTML = groups.map((group, index) => {
      const dateName = index === 0 ? "Next up" : "Then";
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
      <details class="route-details parent-expanded"${parentViewActive() ? " open" : ""}>
        <summary>Full route controls</summary>
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
        </div>
      </details>`;

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


  // Ask the server whether a lesson file is there. Three answers, not two:
  //   true  — it is there, safe to link.
  //   false — the server said 404. Never link it; a dead link is worse than no link.
  //   null  — the request itself failed (offline, opened from a file:// path). That is
  //           not proof of absence, so the link stays: hiding every lesson because the
  //           network blinked is a bigger failure than a link that will not open while
  //           he has no connection anyway.
  async function pageExists(path) {
    if (lessonFileCache.has(path)) return lessonFileCache.get(path);
    let answer;
    try {
      const response = await fetch(path, { method: "HEAD" });
      answer = response.ok ? true : (response.status === 404 ? false : null);
    } catch {
      answer = null;
    }
    lessonFileCache.set(path, answer);
    return answer;
  }

  function lessonExists(slug) {
    return pageExists(`lessons/${slug}.html`);
  }

  // Code labs: a page with a small editor, working code already loaded, and a picture
  // that moves when he changes a number. Each one is pinned to a real section of the
  // syllabus, and like the mini-lessons it is only linked once the file is confirmed.
  const LAB_CATALOG = [
    { file: "sem1-03-crossing", semesterId: "sem1", number: 3, name: "Where Two Lines Cross" },
    { file: "sem1-05-line", semesterId: "sem1", number: 5, name: "Move the Line" },
    { file: "sem2-01-doubling", semesterId: "sem2", number: 1, name: "The Moment Doubling Wins" },
    { file: "sem2-02-parabola", semesterId: "sem2", number: 2, name: "Bend the Parabola" },
    { file: "sem2-03-mandelbrot", semesterId: "sem2", number: 3, name: "The Quadratic That Eats Itself" },
    { file: "sem1-06-piecewise", semesterId: "sem1", number: 6, name: "Move the Join" },
    { file: "sem2-04-radical", semesterId: "sem2", number: 4, name: "Where the Root Begins" },
    { file: "sem2-05-rational", semesterId: "sem2", number: 5, name: "Divide by Almost Zero" },
    { file: "sem2-06-data", semesterId: "sem2", number: 6, name: "Fit the Mess" },
    { file: "index", semesterId: null, number: null, name: "All code labs" },
  ];


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
      }).join("")}</ol>
      <h4 class="lesson-library__heading">Code labs</h4>
      <ol class="lesson-library">${LAB_CATALOG.filter(lab => lab.semesterId).map(lab => {
        const slug = lessonSlug(lab.semesterId, lab.number);
        const state = slug === currentSlug ? "current" : "ahead";
        return `<li class="lesson-library__item lesson-library__item--${state}">
          <span class="lesson-library__id">${escapeHtml(lab.semesterId.toUpperCase())} ${String(lab.number).padStart(2, "0")}</span>
          <span class="lesson-library__name" data-lab="${escapeHtml(lab.file)}">${escapeHtml(lab.name)}</span>
          ${state === "current" ? `<span class="lesson-library__mark">this section</span>` : ""}
        </li>`;
      }).join("")}</ol>
      <p class="lesson-library__all"><span data-lab="index">All code labs</span></p>`;
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
    const labTargets = [...scope.querySelectorAll("[data-lab]")];
    await Promise.all(labTargets.map(async node => {
      const file = node.dataset.lab;
      // "index" is the labs contents page — it has no section, so it fails the
      // per-section pattern every other lab matches, and is allowed explicitly.
      const isIndex = file === "index";
      if (!isIndex && !/^sem[12]-\d{2}-[a-z]+$/.test(file)) return;
      if (await pageExists(`labs/${file}.html`) === false) return;
      const link = document.createElement("a");
      link.href = `labs/${file}.html`;
      link.className = "lesson-library__link";
      link.textContent = node.textContent;
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
        <li class="game-item">
          ${gameKindIcon(item.kind)}
          <div class="game-item__body">
            <strong><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></strong><br>
            <span class="meta">${escapeHtml(item.kind)}${item.sourceAvailable === true && item.remixable === true ? " · source you can read" : ""}</span>
            <p class="why">${escapeHtml(item.why)}</p>
          </div>
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
    return reducedMotionQuery?.matches ?? false;
  }

  function drawMomentumCursor() {
    const pet = document.querySelector("#pet");
    const dx = pointerX - petX;
    const dy = pointerY - petY;
    if (Math.abs(dx) <= 0.4 && Math.abs(dy) <= 0.4) {
      petX = pointerX;
      petY = pointerY;
      pet.style.transform = `translate(${petX}px, ${petY}px)`;
      cursorFrameId = null;
      return;
    }
    petX += dx * 0.35;
    petY += dy * 0.35;
    pet.style.transform = `translate(${petX}px, ${petY}px)`;
    cursorFrameId = window.requestAnimationFrame(drawMomentumCursor);
  }

  function trackMomentumPointer(event) {
    const pet = document.querySelector("#pet");
    if (pet.hidden) return;
    pointerX = event.clientX + 18;
    pointerY = event.clientY + 18;
    if (!petHasPosition) {
      petHasPosition = true;
      petX = pointerX;
      petY = pointerY;
      pet.style.transform = `translate(${petX}px, ${petY}px)`;
      pet.style.opacity = "1";
      return;
    }
    if (cursorFrameId === null) {
      cursorFrameId = window.requestAnimationFrame(drawMomentumCursor);
    }
  }

  function updateMomentumCursor(earned = cursorEarned) {
    cursorEarned = earned;
    const toggle = document.querySelector("#cursor-toggle");
    const pet = document.querySelector("#pet");
    const wanted = storageGet(MOMENTUM_CURSOR_KEY, true) !== false;
    const cursorAllowed = earned && wanted
      && (finePointerQuery?.matches ?? true)
      && !(contrastPointerQuery?.matches ?? false);
    const chaseAllowed = cursorAllowed && !reducedMotion();

    toggle.hidden = !earned;
    toggle.textContent = wanted ? "Cursor: on" : "Cursor: off";
    toggle.setAttribute("aria-pressed", String(wanted));
    toggle.setAttribute("aria-label",
      `${wanted ? "Turn" : "Enable"} Momentum Cursor ${wanted ? "off" : ""}`.trim());
    document.documentElement.classList.toggle("momentum-cursor", cursorAllowed);
    pet.hidden = !chaseAllowed;

    if (!chaseAllowed) {
      if (cursorFrameId !== null) window.cancelAnimationFrame(cursorFrameId);
      cursorFrameId = null;
      petHasPosition = false;
      petX = -80;
      petY = -80;
      pointerX = -80;
      pointerY = -80;
      pet.style.opacity = "0";
      pet.style.transform = "translate(-80px, -80px)";
    }
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
    updateMomentumCursor(earned.has(MOMENTUM_CURSOR_ID));
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
    document.addEventListener("pointermove", trackMomentumPointer, { passive: true });
    for (const query of [finePointerQuery, reducedMotionQuery, contrastPointerQuery]) {
      query?.addEventListener?.("change", () => updateMomentumCursor());
    }
    document.addEventListener("visibilitychange", handleVisibility);
    document.addEventListener("keydown", event => {
      listenForParentPhrase(event);
      if (event.key === "Escape" && document.querySelector(".wm-world-popup[open]")) {
        event.preventDefault();
        closeWorldPopup();
        return;
      }
      if (event.key === "Escape" && zoomedRegion) closeRegion();
    });
    document.addEventListener("click", event => {
      if (revealPending) {
        revealPending = false;
        document.querySelectorAll(".vault-slot.reveal-hidden").forEach(slot => {
          slot.classList.remove("reveal-hidden");
        });
      }
      if (event.target.closest("[data-wm-back]")) {
        closeRegion();
        return;
      }
      if (event.target.closest("[data-world-close]")) {
        closeWorldPopup();
        return;
      }
      const worldCard = event.target.closest("[data-world-card]");
      if (worldCard) {
        openWorldPopup(worldCard.dataset.worldCard);
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
    document.querySelector("#exit-parent").addEventListener("click", () => {
      setParentView(false);
      document.querySelector("#refresh")?.focus();
    });
    document.querySelector("#show-route").addEventListener("click", () => {
      document.querySelector("#calendar").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" });
    });
    document.querySelector("#cursor-toggle").addEventListener("click", () => {
      storageSet(MOMENTUM_CURSOR_KEY, storageGet(MOMENTUM_CURSOR_KEY, true) === false);
      updateMomentumCursor();
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
    worldTerrain,
    // The terrain as it was actually drawn, so `AlgebraQuest.terrain().layers.length`
    // answers "how many nodes is this costing" from the page itself rather than
    // from somebody's estimate of it.
    terrain: () => currentTerrain,
    remainingActivities,
    evaluateUnlocks,
    questDays,
    summarySnapshot,
    staleSafeData
  });

  setParentView(sessionGet(PARENT_VIEW_KEY, false) === true);
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
