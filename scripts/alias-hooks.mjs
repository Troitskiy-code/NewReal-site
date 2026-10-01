import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function withExtensions(base) {
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.js")].find(
    (file) => existsSync(file)
  );
}

function candidate(specifier) {
  const rel = specifier.slice(2);
  return withExtensions(join(root, "src", rel));
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const file = candidate(specifier);
    if (file) return nextResolve(pathToFileURL(file).href, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
    const parent = fileURLToPath(context.parentURL);
    const file = withExtensions(join(dirname(parent), specifier));
    if (file) return nextResolve(pathToFileURL(file).href, context);
  }
  return nextResolve(specifier, context);
}
