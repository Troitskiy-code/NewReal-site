const { Jimp } = require("jimp");
const { writeFileSync } = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const LOGO = path.join(ROOT, "public", "logo.png");
const APPLE_BG = 0x121212ff;
const PAD = 0.08;

async function makeSquare(source, size, { background } = {}) {
  const srcW = source.bitmap.width;
  const srcH = source.bitmap.height;
  const inner = Math.max(1, Math.round(size * (1 - PAD * 2)));
  const scale = inner / Math.max(srcW, srcH);
  const nw = Math.max(1, Math.round(srcW * scale));
  const nh = Math.max(1, Math.round(srcH * scale));
  const fitted = source.clone().resize({ w: nw, h: nh });
  const canvas = new Jimp({ width: size, height: size, color: background ?? 0x00000000 });
  const x = Math.round((size - fitted.bitmap.width) / 2);
  const y = Math.round((size - fitted.bitmap.height) / 2);
  canvas.blit({ src: fitted, x, y });
  return canvas;
}

async function writePng(image, file) {
  const dest = path.join(ROOT, "public", file);
  await image.write(dest);
  console.log("wrote", file, image.bitmap.width);
}

function writePngIco(entries, file) {
  const count = entries.length;
  const headerSize = 6 + 16 * count;
  let offset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const chunks = [header];
  entries.forEach((entry, index) => {
    const dir = 6 + index * 16;
    const size = entry.width >= 256 ? 0 : entry.width;
    header.writeUInt8(size, dir);
    header.writeUInt8(size, dir + 1);
    header.writeUInt8(0, dir + 2);
    header.writeUInt8(0, dir + 3);
    header.writeUInt16LE(1, dir + 4);
    header.writeUInt16LE(32, dir + 6);
    header.writeUInt32LE(entry.buffer.length, dir + 8);
    header.writeUInt32LE(offset, dir + 12);
    offset += entry.buffer.length;
    chunks.push(entry.buffer);
  });

  const dest = path.join(ROOT, "public", file);
  writeFileSync(dest, Buffer.concat(chunks));
  console.log("wrote", file, entries.map((entry) => `${entry.width}x${entry.width}`).join("+"));
}

(async () => {
  const source = await Jimp.read(LOGO);
  console.log("logo", source.bitmap.width, source.bitmap.height);

  const favicon32 = await makeSquare(source, 32);
  const favicon48 = await makeSquare(source, 48);
  const favicon96 = await makeSquare(source, 96);

  await writePng(favicon32, "favicon.png");
  await writePng(favicon48, "favicon-48x48.png");
  await writePng(favicon96, "favicon-96x96.png");

  writePngIco(
    [
      { width: 32, buffer: Buffer.from(await favicon32.getBuffer("image/png")) },
      { width: 48, buffer: Buffer.from(await favicon48.getBuffer("image/png")) },
      { width: 96, buffer: Buffer.from(await favicon96.getBuffer("image/png")) },
    ],
    "favicon.ico"
  );

  await writePng(await makeSquare(source, 180, { background: APPLE_BG }), "apple-touch-icon.png");
  await writePng(await makeSquare(source, 192), "icon-192x192.png");
  await writePng(await makeSquare(source, 512), "icon-512x512.png");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
