import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodePng } from "./skin-gen.mjs";

// Target: Minecraft Java 1.21.11, whose resource-pack format is 75 (verified against
// minecraft.wiki and Mojang's version manifest on 2026-07-25). This previously said
// 1.21.11 / format 15, which would have silently failed to load on Mark's actual game.
// 1.21.11 is common on modded servers; the one-version gate avoids pretending a pack
// remains safe after a pack_format change. No server install, operator, or mod is needed.
const PACK_FORMAT = 75;
const TARGET_VERSION = "1.21.11";

const VICTORY_OGG_BASE64 =
  "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";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const dosTime = (20 << 11) | (0 << 5);
  const dosDate = ((2026 - 1980) << 9) | (7 << 5) | 24;

  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function image(width, height, paint) {
  const pixels = Buffer.alloc(width * height * 4);
  const set = (x, y, rgba) => pixels.set(rgba, (y * width + x) * 4);
  const fill = (x, y, w, h, rgba) => {
    for (let py = y; py < y + h; py += 1) {
      for (let px = x; px < x + w; px += 1) set(px, py, rgba);
    }
  };
  paint({ set, fill });
  return encodePng(width, height, pixels);
}

function packIcon() {
  return image(64, 64, ({ set, fill }) => {
    fill(0, 0, 64, 64, [17, 22, 27, 255]);
    for (let y = 0; y < 64; y += 8) {
      for (let x = 0; x < 64; x += 8) {
        fill(x, y, 7, 7, (x + y) % 16 === 0 ? [37, 49, 57, 255] : [28, 36, 43, 255]);
      }
    }
    fill(13, 12, 38, 40, [18, 25, 30, 255]);
    for (let i = 0; i < 28; i += 1) set(17 + i, 44 - i, [240, 184, 51, 255]);
    for (const [x, y] of [[19, 19], [23, 25], [27, 31], [31, 37]]) {
      fill(x, y, 3, 3, [63, 220, 198, 255]);
    }
    fill(39, 14, 12, 4, [235, 242, 237, 255]);
  });
}

function editionAccent() {
  return image(128, 16, ({ fill }) => {
    fill(0, 0, 128, 16, [0, 0, 0, 0]);
    fill(9, 5, 110, 7, [20, 28, 32, 235]);
    for (let x = 12; x < 116; x += 8) {
      fill(x, 7, 5, 3, x % 16 === 4 ? [63, 220, 198, 255] : [240, 184, 51, 255]);
    }
    fill(5, 3, 4, 11, [240, 184, 51, 255]);
    fill(119, 3, 4, 11, [63, 220, 198, 255]);
  });
}

const baseStyle = `
  :root{color-scheme:dark;--bg:#0b0d10;--panel:#12151a;--line:#2b333d;--text:#e9edf1;--dim:#98a2ad;--accent:#6fdc82;--gold:#f2c14e}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 ui-monospace,monospace}
  main{max-width:860px;margin:32px auto;padding:24px;border:1px solid var(--line);background:var(--panel)}
  h1,h2{font-size:20px}label{display:grid;gap:5px;color:var(--dim)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px}
  input,button{font:inherit;color:var(--text);background:#0e1115;border:1px solid var(--line);padding:10px}
  button{border-color:var(--accent);cursor:pointer}.result{margin-top:18px;padding:16px;border-left:4px solid var(--accent);white-space:pre-wrap}
  .note{color:var(--dim)}code{color:var(--gold)}svg{max-width:100%;height:auto;background:#0e1115;border:1px solid var(--line)}
`;

function cursorPetHtml() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Momentum Cursor Pet</title>
<style>${baseStyle}
html{cursor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath fill='%236fdc82' stroke='%23000' d='M2 2v17l5-5 4 8 4-2-4-8h7z'/%3E%3C/svg%3E") 2 2,auto}
#pet{position:fixed;left:0;top:0;width:36px;height:36px;pointer-events:none;transform:translate(-80px,-80px);will-change:transform}
#pet i{position:absolute;width:8px;height:8px;background:#6fdc82;box-shadow:8px 0 #2f6b3c,16px 0 #6fdc82,0 8px #2f6b3c,8px 8px #f2c14e,16px 8px #2f6b3c,8px 16px #6fdc82}
</style><main><h1>Momentum Cursor + Ore Sprite</h1><p>Move the cursor. Your original ore sprite tracks it. This file works offline.</p><p class="note">No Minecraft install, server access, or browser extension.</p></main><div id="pet" aria-hidden="true"><i></i></div>
<script>const pet=document.querySelector("#pet");let x=-80,y=-80;addEventListener("pointermove",e=>{x+=(e.clientX-x)*.35;y+=(e.clientY-y)*.35;pet.style.transform="translate("+(x+18)+"px,"+(y+18)+"px)"});</script></html>`;
}

function ballisticsHtml() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ballistics Workbench</title><style>${baseStyle}</style>
<main><h1>TNT Cannon Blueprint + Trajectory Calculator</h1><p class="note">Scratch-world design. The calculator is an ideal estimate; server tick rate and cannon geometry change real TNT motion.</p>
<svg viewBox="0 0 720 210" role="img" aria-label="side-view safe test cannon blueprint">
<g stroke="#242a33" stroke-width="1">${Array.from({ length: 36 }, (_, x) => `<path d="M${x * 20} 0v210"/>`).join("")}${Array.from({ length: 11 }, (_, y) => `<path d="M0 ${y * 20}h720"/>`).join("")}</g>
<g fill="#59636e"><path d="M80 140h300v40H80z"/><path d="M80 80h40v60H80z"/><path d="M340 100h40v40h-40z"/></g>
<g fill="#6fdc82"><path d="M120 120h220v20H120z"/></g><g fill="#f2c14e"><path d="M380 120h40v40h-40z"/></g>
<g fill="#e9edf1" font-family="monospace" font-size="14"><text x="82" y="72">backstop</text><text x="150" y="112">water channel</text><text x="366" y="94">payload</text><text x="450" y="132">clear flight path →</text></g></svg>
<h2>Ideal trajectory</h2><div class="grid"><label>Launch speed (blocks/tick)<input id="speed" type="number" step=".05" value="1.2"></label><label>Angle (degrees)<input id="angle" type="number" step="1" value="35"></label><label>Height change (blocks)<input id="height" type="number" step=".5" value="0"></label></div>
<button id="go">Estimate</button><div class="result" id="out">Enter your test values.</div>
<p class="note">Build only where you have permission. Use water containment and a backup. This blueprint never runs commands or changes a world.</p></main>
<script>function solve(){const v=+speed.value,a=+angle.value*Math.PI/180,h=+height.value,g=.05;const vx=v*Math.cos(a),vy=v*Math.sin(a);const disc=vy*vy-2*g*h;if(v<=0||disc<0){out.textContent="No ideal solution for those inputs.";return}const t=(vy+Math.sqrt(disc))/g;out.textContent="flight: "+t.toFixed(1)+" ticks\\nrange: "+(vx*t).toFixed(1)+" blocks\\napex above launch: "+(vy*vy/(2*g)).toFixed(1)+" blocks"}go.onclick=solve;solve();</script></html>`;
}

function surveyorHtml() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Surveyor</title><style>${baseStyle}</style>
<main><h1>Coordinate + Distance Calculator</h1><div class="grid">${["x1","y1","z1","x2","y2","z2"].map((id) => `<label>${id.toUpperCase()}<input id="${id}" type="number" value="${id.endsWith("2") ? 100 : 0}"></label>`).join("")}</div>
<button id="go">Measure</button><div class="result" id="out"></div><p class="note">Nether conversion uses the vanilla 8:1 horizontal coordinate ratio. Y is unchanged.</p></main>
<script>function calc(){const dx=+x2.value-x1.value,dy=+y2.value-y1.value,dz=+z2.value-z1.value;out.textContent="horizontal: "+Math.hypot(dx,dz).toFixed(2)+" blocks\\n3D distance: "+Math.hypot(dx,dy,dz).toFixed(2)+" blocks\\nOverworld → Nether target: "+(+x2.value/8).toFixed(1)+", "+(+y2.value).toFixed(1)+", "+(+z2.value/8).toFixed(1)}go.onclick=calc;calc();</script></html>`;
}

function farmOptimizerHtml() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Farm-rate Optimizer</title><style>${baseStyle}</style>
<main><h1>Farm-rate Optimizer</h1><div class="grid"><label>Items per cycle<input id="items" type="number" value="18" min="0"></label><label>Cycle seconds<input id="seconds" type="number" value="12" min=".01" step=".1"></label><label>Parallel modules<input id="modules" type="number" value="1" min="1"></label><label>Measured uptime %<input id="uptime" type="number" value="85" min="0" max="100"></label></div>
<button id="go">Calculate</button><div class="result" id="out"></div><p class="note">Measure a real ten-minute sample, then tune uptime until the estimate matches.</p></main>
<script>function calc(){const rate=+items.value*3600/+seconds.value*+modules.value*(+uptime.value/100);out.textContent="items/hour: "+rate.toFixed(1)+"\\nstacks/hour: "+(rate/64).toFixed(2)+"\\nshulker boxes/hour: "+(rate/(64*27)).toFixed(3)}go.onclick=calc;calc();</script></html>`;
}

function analyticsCsv() {
  return [
    "Video,Published Date,Length Minutes,Views,Watch Hours,Average View Duration Seconds,Impressions,Click Through Rate Percent,Subscribers Gained,Notes",
    "\"Example: minigame build\",\"2026-07-24\",8.5,0,0,0,0,0,0,\"Replace this row with YouTube Studio data\"",
    "\"\",,0,0,0,0,0,0,0,\"\"",
    "\"\",,0,0,0,0,0,0,0,\"\"",
  ].join("\r\n") + "\r\n";
}

function resourcePack() {
  const mcmeta = {
    pack: {
      pack_format: PACK_FORMAT,
      description: `Algebra Quest victory accents (${TARGET_VERSION} only)`,
    },
  };
  const sounds = {
    "ui.toast.challenge_complete": {
      replace: true,
      sounds: [{ name: "algebra_quest:victory", stream: false }],
    },
  };
  return makeZip([
    ["pack.mcmeta", `${JSON.stringify(mcmeta, null, 2)}\n`],
    ["pack.png", packIcon()],
    ["assets/minecraft/sounds.json", `${JSON.stringify(sounds, null, 2)}\n`],
    ["assets/algebra_quest/sounds/victory.ogg", Buffer.from(VICTORY_OGG_BASE64, "base64")],
    ["assets/minecraft/textures/gui/title/edition.png", editionAccent()],
  ]);
}

export async function generatePack(outputDir) {
  await mkdir(outputDir, { recursive: true });
  const outputs = new Map([
    [`sem1-victory-pack-${TARGET_VERSION}.zip`, resourcePack()],
    ["momentum-cursor-pet.html", cursorPetHtml()],
    ["ballistics-workbench.html", ballisticsHtml()],
    ["surveyor.html", surveyorHtml()],
    ["farm-rate-optimizer.html", farmOptimizerHtml()],
    ["youtube-analytics-template.csv", analyticsCsv()],
  ]);
  for (const [name, contents] of outputs) {
    await writeFile(path.join(outputDir, name), contents);
  }
  return [...outputs.keys()];
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const vaultDir = path.dirname(path.dirname(modulePath));
  const outputDir = path.join(vaultDir, "artifacts");
  const outputs = await generatePack(outputDir);
  process.stdout.write(outputs.map((name) => path.join(outputDir, name)).join("\n") + "\n");
}
