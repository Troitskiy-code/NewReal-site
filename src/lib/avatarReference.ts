const MAX_REFERENCE_LENGTH = Math.ceil(5 * 1024 * 1024 * 4 / 3) + 128;
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i;

/** References come from uploaded files; the server must not fetch a supplied URL. */
export function isSafeAvatarReference(value: string): boolean {
  return value.length <= MAX_REFERENCE_LENGTH && RASTER_DATA_URL.test(value);
}
