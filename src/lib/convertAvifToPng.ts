export function isAvifFile(file: File): boolean {
  return file.type === "image/avif" || /\.avif$/i.test(file.name);
}

function isAvifSource(value: string): boolean {
  return (
    value.startsWith("data:image/avif") ||
    /\.avif(\?|#|$)/i.test(value) ||
    /image\/avif/i.test(value)
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Не удалось прочитать изображение"));
    reader.readAsDataURL(file);
  });
}

async function rasterizeToPngDataUrl(src: string): Promise<string> {
  const img = new Image();
  if (!src.startsWith("data:") && !src.startsWith("blob:")) {
    img.crossOrigin = "anonymous";
  }
  img.src = src;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Не удалось создать PNG");
  }
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

async function pngDataUrlToFile(dataUrl: string, originalName: string): Promise<File> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const name = originalName.replace(/\.[^.]+$/, ".png") || "reference.png";
  return new File([blob], name, { type: "image/png" });
}

export async function convertAvifToPng(file: File): Promise<File> {
  if (!isAvifFile(file)) return file;
  const dataUrl = await readFileAsDataUrl(file);
  const pngDataUrl = await rasterizeToPngDataUrl(dataUrl);
  return pngDataUrlToFile(pngDataUrl, file.name);
}

export async function ensureReferenceImageFile(file: File): Promise<File> {
  return isAvifFile(file) ? convertAvifToPng(file) : file;
}

export async function ensureReferenceImageDataUrl(source: string): Promise<string> {
  if (!isAvifSource(source)) return source;
  return rasterizeToPngDataUrl(source);
}
