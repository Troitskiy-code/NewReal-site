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

(async () => {
  const source = await Jimp.read(LOGO);
  console.log("logo", source.bitmap.width, source.bitmap.height);

  const favicon = await makeSquare(source, 32);
  await writePng(favicon, "favicon.png");
  const pngBuffer = Buffer.from(await favicon.getBuffer("image/png"));
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(32, 6);
  header.writeUInt8(32, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pngBuffer.length, 14);
  header.writeUInt32LE(22, 18);
  writeFileSync(path.join(ROOT, "public", "favicon.ico"), Buffer.concat([header, pngBuffer]));
  console.log("wrote favicon.ico", pngBuffer.length);

  await writePng(await makeSquare(source, 180, { background: APPLE_BG }), "apple-touch-icon.png");
  await writePng(await makeSquare(source, 192), "icon-192x192.png");
  await writePng(await makeSquare(source, 512), "icon-512x512.png");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
