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
// the page, so a wholesale indent shift is a rendering change.
//
// This used to pin `indents.slice(0, 12)` as a comma-joined string, and that window was the
// bug. Deleting one emitted line slid the window and dragged a previously-unguarded 13th
// line into it, so the pinned slice could not tell "a caption line was legitimately deleted"
// from "something de-indented AND a line was deleted" — the exact confusion it exists to
// prevent. It also meant any legitimate line deletion forced someone to hand-edit a magic
// number, which is how the string came to be edited in the first place.
//
// So the pin is now on the property that actually matters — NO LINE'S INDENTATION CHANGED —
// expressed against semantic landmarks instead of line positions. Each emitted line is
// reduced to its tag skeleton (tags and attribute NAMES; text and attribute values dropped),
// and each skeleton is pinned to the one indent it is emitted at. Adding or removing lines
// cannot shift this. A de-indent cannot hide behind a deletion: a de-indented line keeps its
// skeleton and lands on a different indent, which fails.
const INDENT_BY_SHAPE = {
  "<details class=_>": 6,
  "<summary></summary>": 8,
  "<table class=_>": 8,
  "<caption class=_></caption>": 10,
  "<thead><tr><th scope=_></th><th scope=_></th>": 10,
  "<th scope=_></th><th scope=_></th>": 12,
  "<th scope=_></th><th scope=_></th></tr></thead>": 12,
  "<tbody>": 10,
  "<tr>": 6,
  "<th scope=_></th>": 8,
  "<td class=_></td>": 8,
  "<td></td>": 8,
  "</tr>": 6,
  "</tr></tbody>": 6,
  "</table>": 8,
  "</details>": 6,
};

// Content-free structural fingerprint of a line: what it IS, not what it says. Stable across
// data changes, so this guard never needs a refresh when the fixture's numbers move.
function tagShape(line) {
  return line.trim()
    .replace(/="[^"]*"/g, "=_")  // attribute values carry data; names carry structure
    .replace(/>[^<>]+</g, "><")  // text between tags
    .replace(/^[^<]+/, "")       // text before the first tag
    .replace(/[^>]+$/, "");      // text after the last tag
}

const DE_INDENT_WARNING =
  "This is the de-indent defect class. Do not update these numbers to make the test pass — " +
  "find out why the emitted indentation changed.";

test("rendered markup keeps its exact leading whitespace", () => {
  const table = renderTerritoryTable(map);
  const lines = table.split("\n").filter((l) => l.trim());
  assert.ok(lines.length > 20, `expected a populated table, got ${lines.length} lines`);

  // Every line, whatever its position, sits at the indent its shape is pinned to.
  const seen = new Map();
  for (const [index, line] of lines.entries()) {
    const shape = tagShape(line);
    const indent = line.match(/^ */)[0].length;
    if (!seen.has(shape)) seen.set(shape, new Set());
    seen.get(shape).add(indent);
    const pinned = INDENT_BY_SHAPE[shape];
    assert.ok(pinned !== undefined,
      `unpinned markup shape at line ${index}: ${JSON.stringify(shape)} (indent ${indent}).\n` +
      "New markup needs its indent added to INDENT_BY_SHAPE. " + DE_INDENT_WARNING);
    assert.equal(indent, pinned,
      `line ${index} moved: ${JSON.stringify(shape)} is emitted at indent ${indent}, ` +
      `pinned at ${pinned}.\n` + DE_INDENT_WARNING);
  }

  // Independent of any pinned constant: one shape may never appear at two indents. This
  // catches a partial de-indent even in markup nobody has pinned yet.
  for (const [shape, indents] of seen) {
    assert.equal(indents.size, 1,
      `${JSON.stringify(shape)} is emitted at ${indents.size} different indents ` +
      `(${[...indents].sort((a, b) => a - b).join(", ")}).\n` + DE_INDENT_WARNING);
  }

  // And the guard itself must not rot into a no-op: the table's structural spine has to be
  // present and still under the pin. If markup is removed, delete its entry deliberately.
  for (const spine of ["<details class=_>", "<table class=_>", "<tbody>", "<tr>", "</table>"]) {
    assert.ok(seen.has(spine),
      `${JSON.stringify(spine)} is no longer emitted — the guard is measuring nothing. ` +
      "If that removal is intended, remove its INDENT_BY_SHAPE entry in the same change.");
  }
});
