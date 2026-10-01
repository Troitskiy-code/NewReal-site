export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${name} is not set. Configure it in the environment before starting the app; built-in fallbacks are not allowed.`
    );
  }
  return value.trim();
}
