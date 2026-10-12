// Load the real transport/consumer with accounting in memory. No Prisma client or DB connection.
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
export const diagnosticRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function createChatDiagnosticRuntime() {
  const rows = new Map(), cache = new Map();
  const prisma = {
    model: { findUnique: async () => null },
    aiCostEvent: {
      create: async ({ data }) => { rows.set(data.id, { ...data }); return data; },
      update: async ({ where, data }) => { Object.assign(rows.get(where.id), data); return rows.get(where.id); },
    },
  };
  const resolveSource = base => [base, `${base}.ts`, `${base}.tsx`, `${base}.js`].find(file => existsSync(file) && /\.(ts|tsx|js|json)$/.test(file));
  function load(file) {
    file = resolve(file);
    if (file === join(diagnosticRoot, 'src/lib/prisma.ts')) return { prisma };
    if (cache.has(file)) return cache.get(file);
    if (file.endsWith('.json')) {
      const value = JSON.parse(readFileSync(file, 'utf8')); cache.set(file, value); return value;
    }
    const loadedModule = { exports: {} }; cache.set(file, loadedModule.exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }, fileName: file,
    }).outputText;
    function dependency(name) {
      if (name === '@/lib/prisma') return { prisma };
      // Diagnostic requests are DeepInfra-only. Never fetch FX rates as a side effect.
      if (name === './currencyRates' || name === '@/lib/currencyRates') return { getAccountingUsdRub: async () => null };
      if (!name.startsWith('.') && !name.startsWith('@/')) return require(name);
      const target = resolveSource(name.startsWith('@/') ? join(diagnosticRoot, 'src', name.slice(2)) : resolve(dirname(file), name));
      if (!target) throw new Error('Diagnostic module unavailable');
      return load(target);
    }
    new Function('require', 'module', 'exports', code)(dependency, loadedModule, loadedModule.exports);
    cache.set(file, loadedModule.exports); return loadedModule.exports;
  }
  const logger = load(join(diagnosticRoot, 'src/lib/logger.ts'));
  logger.setDiagnosticSink(null);
  return { rows, load, logger,
    helpers: load(join(diagnosticRoot, 'src/lib/chatHelpers.ts')),
    consumer: load(join(diagnosticRoot, 'src/lib/chatStreamDiagnostics.ts')),
    telemetry: load(join(diagnosticRoot, 'src/lib/aiCostTelemetry.ts')),
    parser: load(join(diagnosticRoot, 'src/lib/chatCompletionStream.ts')),
    policy: load(join(diagnosticRoot, 'src/lib/testingChatModels.ts')),
    diagnostics: load(join(diagnosticRoot, 'src/lib/aiTransportDiagnostics.ts')),
  };
}
