const sharp = require("sharp");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const FONT = path.join(__dirname, "brand-assets", "Unbounded.ttf");
function write(file, buffer) {
  writeFileSync(path.join(PUBLIC, file), buffer);
  console.log("wrote", file);
}
function writePngIco(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ width, buffer }, index) => {
    const dir = 6 + index * 16;
    header.writeUInt8(width >= 256 ? 0 : width, dir);
    header.writeUInt8(width >= 256 ? 0 : width, dir + 1);
    header.writeUInt16LE(1, dir + 4);
    header.writeUInt16LE(32, dir + 6);
    header.writeUInt32LE(buffer.length, dir + 8);
    header.writeUInt32LE(offset, dir + 12);
    offset += buffer.length;
  });
  const ico = Buffer.concat([header, ...entries.map(entry => entry.buffer)]);
  write("favicon.ico", ico);
  // Keep the automatically served App Router favicon in sync with public.
  writeFileSync(path.join(ROOT, "src", "app", "favicon.ico"), ico);
}
(async () => {
  const { BRAND_PATHS, BRAND_VIEW_BOX, BRAND_COLORS: colors } = await import("../src/lib/brand.mjs");
  const paths = BRAND_PATHS.map(({ d, accent }) => `<path d="${d}" fill="${accent ? colors.accent : colors.foreground}"/>`).join("");
  const glyph = (x, y, size) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${BRAND_VIEW_BOX}">${paths}</svg>`;
  const symbol = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="${BRAND_VIEW_BOX}">${paths}</svg>`;
  const icon = (maskable = false) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="${colors.background}"/>${glyph(maskable ? 82 : 51, maskable ? 82 : 51, maskable ? 348 : 410)}</svg>`;
  const square = (size, opaque = false, maskable = false) => {
    const image = sharp(Buffer.from(icon(maskable)), { density: 144 }).resize(size, size);
    if (opaque) image.flatten({ background: colors.background });
    return image.png().toBuffer();
  };
  write("logo.svg", symbol);
  write("logo.png", await sharp(Buffer.from(symbol), { density: 144 }).resize(512, 512).png().toBuffer());
  write("favicon.svg", icon());
  const entries = [];
  for (const size of [16, 32, 48, 96, 256]) {
    const buffer = await square(size);
    entries.push({ width: size, buffer });
    if (size === 32) write("favicon.png", buffer);
    if (size === 48 || size === 96) write(`favicon-${size}x${size}.png`, buffer);
  }
  writePngIco(entries);
  write("apple-touch-icon.png", await square(180, true));
  write("icon-192x192.png", await square(192));
  write("icon-512x512.png", await square(512));
  write("icon-maskable-512x512.png", await square(512, true, true));
  // The bundled OFL font makes regeneration independent of system fonts.
  const text = async (value, size, color, bold = false) => sharp({ text: {
    text: `<span foreground="${color}">${value}</span>`,
    font: `Unbounded ${bold ? "Bold " : ""}${size}`,
    fontfile: FONT, dpi: 72, rgba: true,
  } }).png().toBuffer();
  const wordmark = await text("newverse", 36, colors.foreground, true);
  const heading = await text("Твоя вселенная\nперсонажей", 48, colors.foreground, true);
  const headingMeta = await sharp(heading).metadata();
  if (headingMeta.width > 790) throw new Error("Social cover heading is too wide");
  const cover = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="${colors.background}"/>${glyph(60, 44, 48)}${glyph(880, 208, 260)}</svg>`);
  write("og-newverse.png", await sharp(cover).composite([
    { input: wordmark, left: 124, top: 51 },
    { input: await text("newvers.ai", 13, "#a9a4b8"), left: 1010, top: 62 },
    { input: heading, left: 60, top: 221 },
    { input: await text("Ролевые игры с ИИ", 20, colors.gold), left: 60, top: 386 },
    { input: await text("Каждый диалог — новая история", 13, "#a9a4b8"), left: 60, top: 566 },
  ]).png().toBuffer());
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
