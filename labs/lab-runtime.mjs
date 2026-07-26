// Code lab runtime.
//
// Two halves live in this file:
//
//   1. Pure functions (guardLoops, describeNumber) that node can import and test.
//   2. sandboxBoot(), which never runs here. It is serialised with toString() and
//      dropped into an iframe's srcdoc, so the code Mark writes executes inside
//      sandbox="allow-scripts" with NO allow-same-origin. That frame is a different,
//      opaque origin: it cannot read this document, cannot reach localStorage, cannot
//      touch the site. The worst his code can do is break its own picture.
//
// Runaway loops are handled twice, because once is not enough:
//   - guardLoops() rewrites every for/while condition to call __tick() first, which
//     throws a plain-English Error once the program passes its time budget. This is
//     the path that produces a friendly message.
//   - The parent also holds a watchdog timer and destroys the whole frame if no result
//     comes back. That is the backstop for the shapes guardLoops cannot reach
//     (for..of over something endless, a pathological regex).

export const TIME_BUDGET_MS = 2000;
export const WATCHDOG_MS = 4000;

// Rewrites loop conditions so every iteration passes through __tick().
//
// The scanner has to know where it is: a "while" inside a string or a comment is not a
// loop, and rewriting it would corrupt his code. So it walks the source in one pass
// tracking string/template/comment state, and only rewrites keywords found in code.
//
// for (a; b; c)  ->  for (a; __tick() && (b); c)     (empty b becomes __tick())
// while (c)      ->  while (__tick() && (c))
//
// for..of / for..in have no top-level semicolons and are left alone; the parent
// watchdog covers them.
export function guardLoops(source) {
  const isWord = (ch) => /[A-Za-z0-9_$]/.test(ch);
  let out = "";
  let i = 0;

  // Reads forward from `start` (which must be a "(") and returns the index of the
  // matching ")", skipping over strings and comments. Returns -1 if unbalanced.
  const matchParen = (start) => {
    let depth = 0;
    let j = start;
    while (j < source.length) {
      const ch = source[j];
      const next = source[j + 1];
      if (ch === "/" && next === "/") {
        j = source.indexOf("\n", j);
        if (j < 0) return -1;
        continue;
      }
      if (ch === "/" && next === "*") {
        j = source.indexOf("*/", j + 2);
        if (j < 0) return -1;
        j += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        j += 1;
        while (j < source.length && source[j] !== ch) {
          j += source[j] === "\\" ? 2 : 1;
        }
        j += 1;
        continue;
      }
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) return j;
      }
      j += 1;
    }
    return -1;
  };

  // Splits "a; b; c" on semicolons that are not nested inside brackets or strings.
  const splitTop = (text) => {
    const parts = [];
    let depth = 0;
    let last = 0;
    for (let j = 0; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === '"' || ch === "'" || ch === "`") {
        j += 1;
        while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      else if (ch === ";" && depth === 0) {
        parts.push(text.slice(last, j));
        last = j + 1;
      }
    }
    parts.push(text.slice(last));
    return parts;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, Math.min(j + 1, source.length));
      i = j + 1;
      continue;
    }

    const before = i === 0 ? "" : source[i - 1];
    const keyword = source.startsWith("while", i)
      ? "while"
      : (source.startsWith("for", i) ? "for" : "");
    if (keyword && !isWord(before)) {
      const after = i + keyword.length;
      let paren = after;
      while (paren < source.length && /\s/.test(source[paren])) paren += 1;
      if (source[paren] === "(" && !isWord(source[after] || "")) {
        const close = matchParen(paren);
        if (close > 0) {
          const inner = source.slice(paren + 1, close);
          let rebuilt = null;
          if (keyword === "while") {
            rebuilt = `(__tick() && (${inner}))`;
          } else {
            const parts = splitTop(inner);
            if (parts.length === 3) {
              const condition = parts[1].trim();
              parts[1] = condition ? ` __tick() && (${condition})` : " __tick()";
              rebuilt = `(${parts.join(";")})`;
            }
          }
          if (rebuilt !== null) {
            out += source.slice(i, paren) + rebuilt;
            i = close + 1;
            continue;
          }
        }
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

// Short, honest number formatting for the text description. 3 stays 3; 0.333333 does
// not sprawl; 1e21 does not become "1000000000000000000000".
export function describeNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  if (Math.abs(value) >= 1e6 || (Math.abs(value) < 1e-4 && value !== 0)) {
    return value.toExponential(3);
  }
  return String(Math.round(value * 1000) / 1000);
}

// ---------------------------------------------------------------------------
// Everything below this line is stringified into the sandbox frame.
// ---------------------------------------------------------------------------

function sandboxBoot() {
  const SVG_NS = "http://www.w3.org/2000/svg";
  // Four series colours and a palette that never enters the red end of the wheel.
  const SERIES = [
    { hex: "#6fdc82", name: "green" },
    { hex: "#f2c14e", name: "amber" },
    { hex: "#8ab4ff", name: "blue" },
    { hex: "#c4a2ff", name: "violet" },
  ];
  const stage = document.getElementById("stage");
  const notes = [];
  const said = [];
  let deadline = 0;
  let ticks = 0;

  function tick() {
    ticks += 1;
    if ((ticks & 1023) === 0 && Date.now() > deadline) {
      throw new Error(
        "Stopped after " + TIME_BUDGET_MS + "ms. Nothing is broken — a loop in " +
        "this program just never reaches its finish condition, so it would run " +
        "forever. Check that the counter in your loop actually changes.",
      );
    }
    return true;
  }

  function num(value) {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
    if (Math.abs(value) >= 1e6 || (Math.abs(value) < 1e-4 && value !== 0)) {
      return value.toExponential(3);
    }
    return String(Math.round(value * 1000) / 1000);
  }

  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const key of Object.keys(attrs || {})) node.setAttribute(key, attrs[key]);
    return node;
  }

  // A "nice" grid step: 1, 2, 5, 10, 20, 50 ... so the axis labels stay readable
  // whatever range he types.
  function gridStep(span) {
    const raw = span / 8;
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const scaled = raw / power;
    const step = scaled >= 5 ? 5 : (scaled >= 2 ? 2 : 1);
    return step * power;
  }

  function graph(xMin, xMax, yMin, yMax) {
    const x0 = Number(xMin);
    const x1 = Number(xMax);
    const y0 = Number(yMin);
    const y1 = Number(yMax);
    if (![x0, x1, y0, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
      throw new Error(
        "graph(xMin, xMax, yMin, yMax) needs four numbers with xMin < xMax and " +
        "yMin < yMax. You passed (" + [xMin, xMax, yMin, yMax].join(", ") + ").",
      );
    }

    const W = 640;
    const H = 420;
    const pad = 46;
    const svg = el("svg", {
      viewBox: "0 0 " + W + " " + H,
      role: "img",
      "aria-label": "plot drawn by the program",
    });
    const clipId = "plotclip";
    const defs = el("defs", {});
    const clip = el("clipPath", { id: clipId });
    clip.append(el("rect", {
      x: pad, y: pad, width: W - pad * 2, height: H - pad * 2,
    }));
    defs.append(clip);
    svg.append(defs);

    const sx = (x) => pad + ((x - x0) / (x1 - x0)) * (W - pad * 2);
    const sy = (y) => H - pad - ((y - y0) / (y1 - y0)) * (H - pad * 2);

    const grid = el("g", { stroke: "#242a33", "stroke-width": "1" });
    const labels = el("g", { fill: "#98a2ad", "font-size": "12", "font-family": "monospace" });
    const stepX = gridStep(x1 - x0);
    for (let x = Math.ceil(x0 / stepX) * stepX; x <= x1 + 1e-9; x += stepX) {
      grid.append(el("line", { x1: sx(x), y1: pad, x2: sx(x), y2: H - pad }));
      labels.append(text(sx(x), H - pad + 16, num(Math.round(x * 1e6) / 1e6), "middle"));
    }
    const stepY = gridStep(y1 - y0);
    for (let y = Math.ceil(y0 / stepY) * stepY; y <= y1 + 1e-9; y += stepY) {
      grid.append(el("line", { x1: pad, y1: sy(y), x2: W - pad, y2: sy(y) }));
      labels.append(text(pad - 6, sy(y) + 4, num(Math.round(y * 1e6) / 1e6), "end"));
    }
    svg.append(grid);

    const axes = el("g", { stroke: "#59636e", "stroke-width": "2" });
    if (y0 <= 0 && y1 >= 0) {
      axes.append(el("line", { x1: pad, y1: sy(0), x2: W - pad, y2: sy(0) }));
    }
    if (x0 <= 0 && x1 >= 0) {
      axes.append(el("line", { x1: sx(0), y1: pad, x2: sx(0), y2: H - pad }));
    }
    svg.append(axes);
    svg.append(el("rect", {
      x: pad, y: pad, width: W - pad * 2, height: H - pad * 2,
      fill: "none", stroke: "#2b333d", "stroke-width": "1",
    }));
    svg.append(labels);

    const plotted = el("g", { "clip-path": "url(#" + clipId + ")" });
    svg.append(plotted);
    stage.append(svg);
    notes.push(
      "Plot with x from " + num(x0) + " to " + num(x1) +
      " and y from " + num(y0) + " to " + num(y1) + ".",
    );

    let used = 0;
    const nextColour = () => SERIES[used++ % SERIES.length];

    function text(x, y, value, anchor) {
      const node = el("text", { x: x, y: y, "text-anchor": anchor || "start" });
      node.textContent = value;
      return node;
    }

    return {
      // Draws y = fn(x) across the whole x range.
      plot(fn, label) {
        if (typeof fn !== "function") {
          throw new Error(
            "plot() wants a function, like plot(f) after you have written " +
            "function f(x) { return 2 * x + 1; }",
          );
        }
        const colour = nextColour();
        const samples = 481;
        let d = "";
        let pen = false;
        let first = null;
        let last = null;
        let lowest = Infinity;
        let highest = -Infinity;
        let previous = null;
        let direction = 0;
        let turns = 0;
        for (let i = 0; i < samples; i += 1) {
          tick();
          const x = x0 + ((x1 - x0) * i) / (samples - 1);
          const y = Number(fn(x));
          if (!Number.isFinite(y)) {
            pen = false;
            continue;
          }
          if (first === null) first = { x: x, y: y };
          last = { x: x, y: y };
          if (y < lowest) lowest = y;
          if (y > highest) highest = y;
          // Counting turns is what stops a parabola being described as "falling"
          // just because its right-hand end happens to sit below its left-hand end.
          if (previous !== null && y !== previous) {
            const step = y > previous ? 1 : -1;
            if (direction !== 0 && step !== direction) turns += 1;
            direction = step;
          }
          previous = y;
          // Clamped well outside the box so a near-vertical asymptote does not
          // produce a coordinate the renderer chokes on.
          const py = Math.max(-2 * H, Math.min(3 * H, sy(y)));
          d += (pen ? "L" : "M") + sx(x).toFixed(2) + " " + py.toFixed(2) + " ";
          pen = true;
        }
        plotted.append(el("path", {
          d: d.trim() || "M0 0",
          fill: "none",
          stroke: colour.hex,
          "stroke-width": "3",
          "stroke-linejoin": "round",
        }));
        if (first && last) {
          const shape = highest - lowest < 1e-9
            ? "flat"
            : (turns === 0
              ? (last.y > first.y ? "rising the whole way" : "falling the whole way")
              : (turns === 1
                ? (direction > 0 ? "falling and then rising, with one lowest point" : "rising and then falling, with one highest point")
                : "changing direction " + turns + " times"));
          notes.push(
            (label ? label + " (" : "Curve " + used + " (") + colour.name + "): " +
            "y = " + num(first.y) + " at x = " + num(first.x) + ", " +
            "y = " + num(last.y) + " at x = " + num(last.x) + ", " + shape +
            ", lowest drawn y = " + num(lowest) + ", highest = " + num(highest) + ".",
          );
        } else {
          notes.push(
            (label || "Curve " + used) + " (" + colour.name + "): no finite values " +
            "in this window, so nothing was drawn.",
          );
        }
        return this;
      },

      // Marks a single point.
      point(x, y, label) {
        const px = Number(x);
        const py = Number(y);
        const colour = nextColour();
        if (!Number.isFinite(px) || !Number.isFinite(py)) {
          notes.push(
            "point(" + num(px) + ", " + num(py) + ")" +
            (label ? " for " + label : "") + " is not a real number, so it was not drawn.",
          );
          return this;
        }
        plotted.append(el("rect", {
          x: sx(px) - 5, y: sy(py) - 5, width: 10, height: 10, fill: colour.hex,
        }));
        if (label) {
          const t = el("text", {
            x: sx(px) + 10, y: sy(py) - 8,
            fill: "#e9edf1", "font-size": "13", "font-family": "monospace",
          });
          t.textContent = label;
          plotted.append(t);
        }
        notes.push(
          "Marked point (" + num(px) + ", " + num(py) + ")" +
          (label ? " labelled " + label : "") + " in " + colour.name + ".",
        );
        return this;
      },

      // Marks a list of [x, y] pairs — sequences, data sets.
      points(list, label) {
        if (!Array.isArray(list)) {
          throw new Error("points() wants an array of [x, y] pairs.");
        }
        const colour = nextColour();
        let drawn = 0;
        for (const pair of list) {
          tick();
          const px = Number(pair && pair[0]);
          const py = Number(pair && pair[1]);
          if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
          plotted.append(el("rect", {
            x: sx(px) - 4, y: sy(py) - 4, width: 8, height: 8, fill: colour.hex,
          }));
          drawn += 1;
        }
        notes.push(
          (label || "Points") + " (" + colour.name + "): " + drawn + " of " +
          list.length + " pairs are inside the window.",
        );
        return this;
      },
    };
  }

  // Pixel work. 240x160 is deliberate: it keeps the heaviest lab under a few million
  // operations on a slow laptop, and the CSS blows it back up with pixelated
  // rendering, which suits the site.
  function picture(xMin, xMax, yMin, yMax, fn, maxSteps) {
    const x0 = Number(xMin);
    const x1 = Number(xMax);
    const y0 = Number(yMin);
    const y1 = Number(yMax);
    const steps = Math.max(1, Math.min(150, Math.round(Number(maxSteps) || 60)));
    if (![x0, x1, y0, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
      throw new Error(
        "picture(xMin, xMax, yMin, yMax, f, maxSteps) needs xMin < xMax and yMin < yMax.",
      );
    }
    if (typeof fn !== "function") {
      throw new Error(
        "picture() wants a function of two numbers, like picture(-2, 1, -1, 1, escapeSteps, 60).",
      );
    }
    const W = 240;
    const H = 160;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "image drawn by the program");
    const context = canvas.getContext("2d");
    const image = context.createImageData(W, H);
    let inside = 0;
    for (let row = 0; row < H; row += 1) {
      const cy = y1 - ((y1 - y0) * (row + 0.5)) / H;
      for (let column = 0; column < W; column += 1) {
        tick();
        const cx = x0 + ((x1 - x0) * (column + 0.5)) / W;
        const value = Number(fn(cx, cy));
        const n = Number.isFinite(value) ? value : steps;
        const offset = (row * W + column) * 4;
        let rgb;
        if (n >= steps) {
          inside += 1;
          rgb = [10, 15, 26];
        } else {
          rgb = shade(n / steps);
        }
        image.data[offset] = rgb[0];
        image.data[offset + 1] = rgb[1];
        image.data[offset + 2] = rgb[2];
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    stage.append(canvas);
    notes.push(
      "Image " + W + "x" + H + " over x from " + num(x0) + " to " + num(x1) +
      " and y from " + num(y0) + " to " + num(y1) + ", up to " + steps + " steps. " +
      Math.round((inside / (W * H)) * 100) + "% of the pixels never escaped " +
      "(drawn dark); the rest are shaded by how fast they left.",
    );
    return { width: W, height: H, insidePercent: (inside / (W * H)) * 100 };
  }

  // Deep blue -> teal -> green -> amber. Nothing in this ramp reaches a red hue.
  function shade(t) {
    const stops = [
      [0.0, [18, 48, 90]],
      [0.35, [31, 138, 122]],
      [0.7, [111, 220, 130]],
      [1.0, [242, 193, 78]],
    ];
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
  }

  function say(...values) {
    said.push(values.map((value) => {
      if (typeof value === "number") return num(value);
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return "[" + value.map((v) => (typeof v === "number" ? num(v) : String(v))).join(", ") + "]";
      return String(value);
    }).join(" "));
    if (said.length > 200) {
      throw new Error(
        "say() was called more than 200 times. That is usually a loop printing " +
        "every step — try printing only the last one, or every tenth.",
      );
    }
  }

  function run(code) {
    stage.textContent = "";
    notes.length = 0;
    said.length = 0;
    ticks = 0;
    deadline = Date.now() + TIME_BUDGET_MS;
    try {
      const guarded = guardLoops(String(code));
      const program = new Function("graph", "picture", "say", "__tick", '"use strict";\n' + guarded);
      program(graph, picture, say, tick);
      parent.postMessage({ type: "done", notes: notes.slice(), said: said.slice() }, "*");
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error);
      const kind = error instanceof SyntaxError
        ? "The program could not be read as JavaScript."
        : "The program started and then stopped here.";
      parent.postMessage({
        type: "error",
        kind: kind,
        message: message,
        notes: notes.slice(),
        said: said.slice(),
      }, "*");
    }
  }

  addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "run") return;
    run(event.data.code);
  });
  parent.postMessage({ type: "ready" }, "*");
}

export function sandboxDocument() {
  const script = [
    "const TIME_BUDGET_MS = " + TIME_BUDGET_MS + ";",
    guardLoops.toString(),
    sandboxBoot.toString(),
    "sandboxBoot();",
  ].join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
html,body{margin:0;background:#0e1115;color:#e9edf1;font:14px/1.4 ui-monospace,monospace}
#stage{display:grid;gap:8px;padding:8px;justify-items:center}
svg{width:100%;height:auto;max-width:660px}
canvas{width:100%;max-width:660px;height:auto;image-rendering:pixelated}
</style></head><body><div id="stage"></div><script>${script}<\/script></body></html>`;
}

// Wires one lab page: editor, Run, Reset, sandbox frame, watchdog, output panel.
export function mountLab(options = {}) {
  const editor = document.querySelector("#code");
  const starterNode = document.querySelector("#starter-code");
  const runButton = document.querySelector("#run");
  const resetButton = document.querySelector("#reset");
  const frameHolder = document.querySelector("#picture");
  const status = document.querySelector("#run-status");
  const description = document.querySelector("#description");
  const starter = starterNode.textContent.replace(/^\n/, "").replace(/\s+$/, "");

  editor.value = starter;

  let frame = null;
  let watchdog = 0;
  let pending = null;

  const setStatus = (message) => {
    status.textContent = message;
  };

  const renderResult = (data) => {
    description.textContent = "";
    const list = document.createElement("ul");
    list.className = "readout";
    const push = (line, className) => {
      const item = document.createElement("li");
      if (className) item.className = className;
      item.textContent = line;
      list.append(item);
    };
    if (data.kind) push(data.kind, "readout__note");
    if (data.message) push(data.message, "readout__note");
    for (const line of data.said || []) push(line, "readout__said");
    for (const line of data.notes || []) push(line);
    if (!list.childElementCount) push("The program ran and drew nothing yet.");
    description.append(list);
  };

  const stopWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = 0;
  };

  const onMessage = (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "ready") {
      if (pending !== null) {
        frame.contentWindow.postMessage({ type: "run", code: pending }, "*");
        pending = null;
      }
      return;
    }
    if (data.type === "done") {
      stopWatchdog();
      setStatus("Ran fine.");
      renderResult(data);
      return;
    }
    if (data.type === "error") {
      stopWatchdog();
      setStatus("Stopped early — read the note below, then try again.");
      renderResult(data);
    }
  };

  addEventListener("message", onMessage);

  const run = () => {
    stopWatchdog();
    if (frame) frame.remove();
    frame = document.createElement("iframe");
    // No allow-same-origin: the frame gets an opaque origin and cannot touch this page.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", "program output");
    frame.srcdoc = sandboxDocument();
    pending = editor.value;
    frameHolder.textContent = "";
    frameHolder.append(frame);
    setStatus("Running…");
    description.textContent = "";
    watchdog = setTimeout(() => {
      if (frame) frame.remove();
      frame = null;
      setStatus("Stopped after 4 seconds.");
      renderResult({
        kind: "The program was still going after 4 seconds, so it was shut down.",
        message: "Nothing is broken and nothing was lost. This nearly always means a " +
          "loop whose finish condition is never reached. Your code is exactly as you " +
          "left it — check the loop, then press Run again.",
      });
    }, WATCHDOG_MS);
  };

  runButton.addEventListener("click", run);
  resetButton.addEventListener("click", () => {
    editor.value = starter;
    setStatus("Back to the starting code.");
    editor.focus();
  });
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      run();
    }
  });

  if (options.autoRun !== false) run();
  return { run };
}
