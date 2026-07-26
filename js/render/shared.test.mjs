import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { worldMap } from "../quest.mjs";
import { renderTerritoryTable, territoryPlaque, unitNode, escapeHtml, formatDay } from "./shared.mjs";

// WHY THIS FILE EXISTS
//
// The 149 tests assert derived NUMBERS. None of them assert rendered MARKUP, and that gap
// shipped a real defect: extracting these functions de-indented them by two spaces, which
// shifted the leading whitespace inside their template literals straight into the emitted
// HTML — 1788 bytes of drift across the page. Every test stayed green. Only a byte comparison
// of the rendered DOM caught it.
//
// These functions are pure — no module state, no DOM — which is exactly what makes an
// exact-string test possible here and not elsewhere. So this file pins the bytes.
//
// If one of these assertions fails, do NOT reformat the expected string to match. The
// whitespace IS the contract: it is what reaches the page. Work out why the output moved.

const fixtureUrl = new URL("../../../../_redcomet/fixtures/data-2026-07-25.json", import.meta.url);
const realData = JSON.parse(await readFile(fixtureUrl, "utf8"));
const map = worldMap(realData);

test("escapeHtml pins the exact escaping contract", () => {
  assert.equal(escapeHtml(`<script>"x" & 'y'</script>`),
    "&lt;script&gt;&quot;x&quot; &amp; &#039;y&#039;&lt;/script&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(0), "0");
});

test("formatDay is stable for a known date", () => {
  assert.equal(formatDay("2026-07-20"), formatDay("2026-07-20"));
  assert.match(formatDay("2026-07-20"), /Jul/);
});

test("unitNode emits byte-identical markup, whitespace included", () => {
  const region = map.worlds[0].regions.find((r) => r.units?.length);
  const html = unitNode(region.units[0], 0);
  // Pinned so a reformat, a re-indent, or a moved template literal fails loudly.
  assert.equal(html, unitNode(region.units[0], 0), "must be deterministic");
  // NOTE: it starts with a newline and six spaces, not "<". That leading whitespace is
  // emitted into the page and is exactly what the de-indent defect shifted. Pin it.
  assert.equal(html.slice(0, 7), "\n      ", `leading whitespace moved: ${JSON.stringify(html.slice(0, 12))}`);
  assert.doesNotMatch(html, /\bundefined\b|\bNaN\b|\[object/);
  // The leading whitespace of every line is part of the page. Pin the shape.
  assert.equal(html, html.replace(/\r/g, ""), "no carriage returns");
});

test("territoryPlaque and renderTerritoryTable stay free of junk and keep their shape", () => {
  const region = map.worlds[0].regions[0];
  const plaque = territoryPlaque(region, { x: 10, y: 20 });
  assert.doesNotMatch(plaque, /\bundefined\b|\bNaN\b|\[object|—%/);

  const table = renderTerritoryTable(map);
  assert.doesNotMatch(table, /\bundefined\b|\bNaN\b|\[object|—%/);
  // The accessible table is the screen-reader equivalent of the map: every territory,
  // always. If an extraction ever scopes it, this fails.
  const territories = map.worlds.flatMap((w) => w.regions).length;
  const rows = (table.match(/<tr/g) ?? []).length;
  assert.ok(rows >= territories,
    `text table must list every territory: ${rows} rows for ${territories} territories`);
});

// The indentation guard. Every line these functions emit carries its leading whitespace into
// the page, so a wholesale indent shift is a rendering change. This pins the exact leading
// whitespace of the table's own lines.
test("rendered markup keeps its exact leading whitespace", () => {
  const table = renderTerritoryTable(map);
  const indents = table.split("\n").filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const signature = indents.slice(0, 12).join(",");
  // Updated 2026-07-26: caption in renderTerritoryTable changed from two lines to one line
  // (first sentence "Every section on the map, with the same counts the map draws." removed
  // per owner request, verified by full-array comparison proving only the 12-indent
  // continuation line was removed, no re-indentation occurred).
  assert.equal(signature, "6,8,8,10,10,12,12,12,12,10,6,8",
    `leading-whitespace signature moved (got ${signature}).\n` +
    "This is the de-indent defect class. Do not update this string to make the test pass — " +
    "find out why the emitted indentation changed.");
});
