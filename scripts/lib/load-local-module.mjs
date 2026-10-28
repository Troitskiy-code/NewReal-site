// Isolated TypeScript loader for pure application helpers. It never reads .env or starts the app.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
const require = createRequire(import.meta.url);
export function moduleLoader(overrides = {}) {
  const cache = new Map();
  const root = process.cwd();
  function load(filename) {
    const resolved = path.resolve(root, filename);
    const relative = path.relative(root, resolved).replaceAll("\\", "/");
    if (Object.hasOwn(overrides, relative)) return overrides[relative];
    if (cache.has(resolved)) return cache.get(resolved).exports;
    if (resolved.endsWith(".json")) return JSON.parse(readFileSync(resolved, "utf8"));
    const mod = { exports: {} }; cache.set(resolved, mod);
    const output = ts.transpileModule(readFileSync(resolved, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function("require", "module", "exports", output)((specifier) => {
      if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return require(specifier);
      const base = specifier.startsWith("@/") ? path.join(root, "src", specifier.slice(2)) : path.resolve(path.dirname(resolved), specifier);
      const target = [base, base + ".ts", base + ".tsx", base + ".js"].find(file => existsSync(file));
      if (!target) throw new Error(`Unresolved local module: ${specifier} from ${relative}`);
      return load(target);
    }, mod, mod.exports);
    return mod.exports;
  }
  return load;
}
