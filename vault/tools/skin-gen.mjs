import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

export function encodePng(width, height, pixels) {
  if (pixels.length !== width * height * 4) {
    throw new Error(`Expected ${width * height * 4} RGBA bytes`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const target = y * (width * 4 + 1);
    scanlines[target] = 0;
    pixels.copy(scanlines, target + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeSkin() {
  const size = 64;
  const pixels = Buffer.alloc(size * size * 4);
  const colors = {
    charcoal: [32, 40, 48, 255],
    shadow: [19, 25, 31, 255],
    steel: [66, 82, 94, 255],
    skin: [173, 116, 77, 255],
    skinLight: [207, 151, 105, 255],
    cyan: [62, 220, 198, 255],
    cyanDark: [21, 116, 111, 255],
    gold: [241, 185, 52, 255],
    stone: [102, 110, 117, 255],
    white: [235, 242, 237, 255],
  };

  const set = (x, y, color) => {
    const offset = (y * size + x) * 4;
    pixels.set(color, offset);
  };
  const fill = (x, y, width, height, color) => {
    for (let py = y; py < y + height; py += 1) {
      for (let px = x; px < x + width; px += 1) set(px, py, color);
    }
  };
  const speckle = (x, y, width, height, color) => {
    for (let py = y; py < y + height; py += 1) {
      for (let px = x; px < x + width; px += 1) {
        if ((px * 7 + py * 11) % 13 === 0) set(px, py, color);
      }
    }
  };

  // Every classic-model base face is painted: head, torso, both arms, and both legs.
  for (const [x, y, width, height] of [
    [8, 0, 8, 8], [16, 0, 8, 8], [0, 8, 32, 8],
  ]) fill(x, y, width, height, colors.skin);
  for (const [x, y, width, height] of [
    [20, 16, 16, 4], [16, 20, 24, 12],
  ]) fill(x, y, width, height, colors.charcoal);
  for (const [x, y, width, height] of [
    [4, 16, 8, 4], [0, 20, 16, 12],
    [44, 16, 8, 4], [40, 20, 16, 12],
    [20, 48, 8, 4], [16, 52, 16, 12],
    [36, 48, 8, 4], [32, 52, 16, 12],
  ]) fill(x, y, width, height, colors.steel);

  // Face: lamp helmet, dark eyes, and a small cyan ore reflection.
  fill(8, 8, 8, 2, colors.shadow);
  fill(10, 10, 2, 1, colors.shadow);
  fill(14, 10, 2, 1, colors.shadow);
  set(15, 10, colors.cyan);
  fill(11, 13, 4, 1, colors.skinLight);
  fill(11, 7, 3, 2, colors.gold);
  set(12, 7, colors.white);

  // Torso front: y = 2x + 1 in cyan, crossed by a gold mining-pick strap.
  fill(20, 20, 8, 12, colors.shadow);
  for (let i = 0; i < 7; i += 1) set(20 + i, 30 - i, colors.gold);
  for (const [x, y] of [[21, 22], [22, 24], [23, 26], [24, 28]]) {
    set(x, y, colors.cyan);
  }
  fill(25, 22, 2, 1, colors.white);
  set(26, 21, colors.white);
  set(26, 23, colors.white);

  // Ore-flecked sleeves and boots; deterministic so regenerated skins are identical.
  for (const region of [
    [40, 20, 16, 12], [0, 20, 16, 12], [16, 52, 16, 12], [32, 52, 16, 12],
  ]) speckle(...region, colors.cyanDark);
  fill(4, 29, 4, 3, colors.shadow);
  fill(20, 61, 4, 3, colors.shadow);

  // Original helmet overlay; transparent elsewhere to keep the modern 64x64 layout.
  fill(40, 8, 8, 2, colors.gold);
  fill(40, 10, 1, 5, colors.gold);
  fill(47, 10, 1, 5, colors.gold);
  set(43, 10, colors.white);
  set(44, 10, colors.cyan);

  return encodePng(size, size, pixels);
}

export async function generateSkin(outputFile) {
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, makeSkin());
  return outputFile;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const vaultDir = path.dirname(path.dirname(modulePath));
  const outputFile = path.join(vaultDir, "artifacts", "algebra-miner.png");
  await generateSkin(outputFile);
  process.stdout.write(`${outputFile}\n`);
}
