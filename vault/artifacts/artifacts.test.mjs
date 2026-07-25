import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const artifactsDir = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.dirname(artifactsDir);
const generatedFiles = [];

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

function decodePng(buffer) {
  assert.deepEqual(
    buffer.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "PNG signature",
  );

  const chunks = [];
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    assert.equal(
      crc32(Buffer.concat([Buffer.from(type), data])),
      expectedCrc,
      `${type} CRC`,
    );
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }

  assert.equal(chunks[0]?.type, "IHDR");
  assert.equal(chunks.at(-1)?.type, "IEND");
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.equal(ihdr[8], 8, "8-bit channels");
  assert.equal(ihdr[9], 6, "RGBA color type");
  assert.equal(ihdr[12], 0, "no interlacing");

  const packed = Buffer.concat(
    chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data),
  );
  const raw = inflateSync(packed);
  const stride = width * 4;
  assert.equal(raw.length, height * (stride + 1));
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    assert.ok(filter >= 0 && filter <= 4, `supported filter ${filter}`);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + 1 + x];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      let decoded = value;
      if (filter === 1) decoded += left;
      if (filter === 2) decoded += up;
      if (filter === 3) decoded += Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        decoded += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = decoded & 0xff;
    }
  }
  return { width, height, pixels };
}

function readZip(buffer) {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocd = offset;
      break;
    }
  }
  assert.notEqual(eocd, -1, "ZIP end-of-central-directory record");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory entry");
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "local ZIP entry");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const packed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? packed : method === 8 ? inflateSync(packed) : null;
    assert.ok(data, `supported compression method for ${name}`);
    assert.equal(data.length, uncompressedSize, `${name} uncompressed size`);
    assert.equal(crc32(data), expectedCrc, `${name} CRC`);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

before(async () => {
  for (const script of ["skin-gen.mjs", "pack-gen.mjs"]) {
    await execFileAsync(process.execPath, [path.join(vaultDir, "tools", script)], {
      cwd: vaultDir,
    });
  }
});

after(() => {
  generatedFiles.length = 0;
});

test("Algebra Miner is a decoded 64x64 Java skin with opaque base regions", async () => {
  const png = decodePng(await readFile(path.join(artifactsDir, "algebra-miner.png")));
  assert.equal(png.width, 64);
  assert.equal(png.height, 64);

  const alphaAt = (x, y) => png.pixels[(y * png.width + x) * 4 + 3];
  for (const [label, x, y] of [
    ["head", 8, 8],
    ["torso", 20, 20],
    ["right leg", 4, 20],
    ["right arm", 44, 20],
    ["left leg", 20, 52],
    ["left arm", 36, 52],
  ]) {
    assert.equal(alphaAt(x, y), 255, `${label} base layer is opaque`);
  }
});

test("victory pack is a readable ZIP with a valid 1.20.1 manifest", async () => {
  const zip = readZip(await readFile(path.join(artifactsDir, "sem1-victory-pack-1.20.1.zip")));
  const mcmeta = JSON.parse(zip.get("pack.mcmeta").toString("utf8"));
  assert.equal(mcmeta.pack.pack_format, 15);
  assert.match(mcmeta.pack.description, /Algebra Quest/);
  assert.ok(mcmeta.pack.pack_format >= 1 && mcmeta.pack.pack_format <= 100);

  for (const name of [
    "pack.png",
    "assets/minecraft/sounds.json",
    "assets/algebra_quest/sounds/victory.ogg",
    "assets/minecraft/textures/gui/title/edition.png",
  ]) {
    assert.ok(zip.has(name), `${name} exists`);
  }
  assert.equal(
    zip.get("assets/algebra_quest/sounds/victory.ogg").toString("ascii", 0, 4),
    "OggS",
  );
  const sounds = JSON.parse(zip.get("assets/minecraft/sounds.json").toString("utf8"));
  assert.equal(sounds["ui.toast.challenge_complete"].replace, true);
});

test("manifest catalogs all milestones and locks untested Shareable entries", async () => {
  const manifest = JSON.parse(await readFile(path.join(vaultDir, "manifest.json"), "utf8"));
  assert.equal(manifest.length, 11);
  assert.deepEqual(
    manifest.map(({ milestoneId }) => milestoneId),
    Array.from({ length: 11 }, (_, index) => index + 1),
  );

  for (const artifact of manifest) {
    for (const field of [
      "id",
      "name",
      "tier",
      "minVersion",
      "maxVersion",
      "loader",
      "files",
      "testedOn",
      "milestoneId",
    ]) {
      assert.ok(Object.hasOwn(artifact, field), `${artifact.id ?? "artifact"} has ${field}`);
    }
    assert.ok(Array.isArray(artifact.files), `${artifact.id} files is an array`);
    assert.ok(Object.hasOwn(artifact, "maxVersion"), `${artifact.id} has maxVersion`);
    if (artifact.tier === "Shareable") {
      assert.equal(artifact.locked, true);
      assert.equal(artifact.untested, true);
      assert.equal(artifact.testedOn, null);
      assert.deepEqual(artifact.files, []);
    }
  }

  const pack = manifest.find(({ id }) => id === "sem1-victory-pack");
  assert.equal(pack.minVersion, "1.20.1");
  assert.equal(pack.maxVersion, "1.20.1");
  assert.equal(pack.loader, "vanilla");
});

test("every listed Solo file is generated and usable without server privileges", async () => {
  const manifest = JSON.parse(await readFile(path.join(vaultDir, "manifest.json"), "utf8"));
  const solo = manifest.filter(({ tier }) => tier === "Solo");
  assert.equal(solo.length, 7);
  for (const artifact of solo) {
    assert.equal(artifact.requiresServerAccess, false);
    assert.equal(artifact.requiresOperator, false);
    assert.equal(artifact.requiresMod, false);
    assert.ok(artifact.files.length > 0, `${artifact.id} has a usable file`);
    for (const file of artifact.files) {
      const contents = await readFile(path.join(vaultDir, file));
      assert.ok(contents.length > 32, `${file} is non-empty`);
      generatedFiles.push(file);
    }
  }
});
