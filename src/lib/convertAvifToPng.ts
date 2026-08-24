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

function canvasToPngBlob(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return Promise.reject(new Error("Не удалось создать PNG"));
  }
  ctx.drawImage(source, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Не удалось создать PNG"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

async function rasterizeWithImageElement(src: string): Promise<Blob> {
  const img = new Image();
  if (!src.startsWith("data:") && !src.startsWith("blob:")) {
    img.crossOrigin = "anonymous";
  }
  img.src = src;
  await img.decode();
  return canvasToPngBlob(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
}

export async function convertAvifToPng(file: File): Promise<File> {
  if (!isAvifFile(file)) return file;

  let blob: Blob;
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        blob = await canvasToPngBlob(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    } catch {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Не удалось прочитать изображение"));
        reader.readAsDataURL(file);
      });
      blob = await rasterizeWithImageElement(dataUrl);
    }
  } else {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Не удалось прочитать изображение"));
      reader.readAsDataURL(file);
    });
    blob = await rasterizeWithImageElement(dataUrl);
  }

  const name = file.name.replace(/\.[^.]+$/, ".png");
  return new File([blob], name || "reference.png", { type: "image/png" });
}

export async function ensureReferenceImageFile(file: File): Promise<File> {
  return isAvifFile(file) ? convertAvifToPng(file) : file;
}

export async function ensureReferenceImageDataUrl(source: string): Promise<string> {
  if (!isAvifSource(source)) return source;
  const blob = await rasterizeWithImageElement(source);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Не удалось прочитать изображение"));
    reader.readAsDataURL(blob);
  });
}
