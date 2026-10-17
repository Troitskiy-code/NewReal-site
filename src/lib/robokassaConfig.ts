/** Keep checkout and payment analytics on the same interpretation of the flag. */
export function isRobokassaTestMode(): boolean {
  return ["1", "true"].includes((process.env["ROBOKASSA_TEST_MODE"] ?? "").trim().toLowerCase());
}
