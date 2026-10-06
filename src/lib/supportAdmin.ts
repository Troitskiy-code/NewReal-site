import { timingSafeEqual } from "node:crypto";

export function supportAdminAuthorized(request: Request): boolean {
  const secret = process.env['ADMIN_SECRET'];
  const supplied = request.headers.get('authorization');
  if (!secret || !supplied) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
