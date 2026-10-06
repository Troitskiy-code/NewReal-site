import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { SUPPORT_REPLY_MIGRATION } from '@/lib/supportSchema';

type Database = Pick<Prisma.TransactionClient, '$queryRaw'>;
type Column = { name: string; type: string; nullable: boolean; defaultValue: string | null };
type Constraint = { kind: string; columns: string[]; foreignColumns: string[]; foreignTable: string | null; foreignSchema: string | null; deleteAction: string; updateAction: string };
type Index = { columns: string[]; unique: boolean; valid: boolean; partial: boolean; expression: boolean };
export type SupportMigrationStatus = {
  migration: string; ready: boolean; canApply: boolean;
  mode: 'prisma' | 'schema_only';
  state: 'ready' | 'missing' | 'untracked' | 'blocked';
  history: 'applied' | 'pending' | 'missing';
  issues: string[]; message: string;
};
const expected: Record<string, [string, boolean]> = {
  id: ['text', false], ticketId: ['text', false], clientKey: ['text', false],
  payloadHash: ['text', false], recipient: ['text', false], sender: ['text', false],
  message: ['text', false], status: ['text', false], attempts: ['integer', false],
  nextAttemptAt: ['timestamp without time zone', true], claimedAt: ['timestamp without time zone', true],
  claimToken: ['text', true], providerId: ['text', true], acceptedAt: ['timestamp without time zone', true],
  createdAt: ['timestamp without time zone', false],
};
const same = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

export async function inspectSupportMigration(db: Database = prisma): Promise<SupportMigrationStatus> {
  const [base] = await db.$queryRaw<Array<{ schema: string; table: boolean; parent: boolean; history: boolean; canCreate: boolean; canRecord: boolean }>>`
    SELECT current_schema() AS schema,
      to_regclass(format('%I.%I', current_schema(), 'SupportReply')) IS NOT NULL AS "table",
      to_regclass(format('%I.%I', current_schema(), 'SupportTicket')) IS NOT NULL AS parent,
      to_regclass(format('%I.%I', current_schema(), '_prisma_migrations')) IS NOT NULL AS history,
      has_schema_privilege(current_schema(), 'CREATE') AS "canCreate",
      CASE WHEN to_regclass(format('%I.%I', current_schema(), '_prisma_migrations')) IS NOT NULL
        THEN has_table_privilege(format('%I.%I', current_schema(), '_prisma_migrations'), 'INSERT') ELSE false END AS "canRecord"`;
  const history = base.history ? await db.$queryRaw<Array<{ name: string; finished: boolean; rolledBack: boolean }>>`
    SELECT migration_name AS name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack"
    FROM "_prisma_migrations" WHERE migration_name IN (${SUPPORT_REPLY_MIGRATION}, '20260801000000_baseline')
      OR (finished_at IS NULL AND rolled_back_at IS NULL)` : [];
  const recorded = history.some(row => row.name === SUPPORT_REPLY_MIGRATION && row.finished && !row.rolledBack);
  const unfinished = history.some(row => !row.finished && !row.rolledBack);
  const baselineRecorded = history.some(row => row.name === '20260801000000_baseline' && row.finished && !row.rolledBack);
  const issues: string[] = [];
  if (base.table) {
    const columns = await db.$queryRaw<Column[]>`
      SELECT column_name AS name, data_type AS type, is_nullable = 'YES' AS nullable, column_default AS "defaultValue"
      FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'SupportReply'`;
    for (const [name, [type, nullable]] of Object.entries(expected)) {
      const column = columns.find(row => row.name === name);
      if (!column || column.type !== type || column.nullable !== nullable) issues.push(`column:${name}`);
    }
    if (columns.length !== Object.keys(expected).length) issues.push('unexpected_columns');
    for (const name of ['createdAt', 'nextAttemptAt']) {
      if (!/^(CURRENT_TIMESTAMP|now\(\))$/i.test(columns.find(row => row.name === name)?.defaultValue || '')) issues.push(`default:${name}`);
    }
    if (columns.find(row => row.name === 'status')?.defaultValue !== "'pending'::text") issues.push('default:status');
    if (columns.find(row => row.name === 'attempts')?.defaultValue !== '0') issues.push('default:attempts');
    const constraints = await db.$queryRaw<Constraint[]>`
      SELECT c.contype::text AS kind, c.confdeltype::text AS "deleteAction", c.confupdtype::text AS "updateAction",
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, pos)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.pos) AS columns,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, pos)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.pos) AS "foreignColumns",
        f.relname::text AS "foreignTable", ns.nspname::text AS "foreignSchema"
      FROM pg_constraint c LEFT JOIN pg_class f ON f.oid = c.confrelid LEFT JOIN pg_namespace ns ON ns.oid = f.relnamespace
      WHERE c.conrelid = to_regclass(format('%I.%I', current_schema(), 'SupportReply'))`;
    if (!constraints.some(row => row.kind === 'p' && same(row.columns, ['id']))) issues.push('primary_key');
    if (!constraints.some(row => row.kind === 'f' && same(row.columns, ['ticketId']) && same(row.foreignColumns, ['id']) &&
      row.foreignTable === 'SupportTicket' && row.foreignSchema === base.schema && row.deleteAction === 'r' && row.updateAction === 'c')) issues.push('ticket_foreign_key');
    const indexes = await db.$queryRaw<Index[]>`
      SELECT i.indisunique AS "unique", i.indisvalid AS valid, i.indpred IS NOT NULL AS partial, i.indexprs IS NOT NULL AS expression,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(n, pos)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.pos) AS columns
      FROM pg_index i WHERE i.indrelid = to_regclass(format('%I.%I', current_schema(), 'SupportReply'))`;
    for (const names of [['clientKey'], ['ticketId', 'createdAt'], ['status', 'nextAttemptAt']]) {
      if (!indexes.some(row => row.valid && !row.partial && !row.expression && same(row.columns, names) && (names[0] !== 'clientKey' || row.unique))) issues.push(`index:${names.join(',')}`);
    }
  }
  const ready = base.table && issues.length === 0;
  const result: SupportMigrationStatus = { migration: SUPPORT_REPLY_MIGRATION, ready, canApply: false,
    mode: base.history ? 'prisma' : 'schema_only',
    state: ready ? (recorded || !base.history ? 'ready' : 'untracked') : base.table ? 'blocked' : 'missing',
    history: recorded ? 'applied' : base.history ? 'pending' : 'missing', issues, message: '' };
  if (!base.parent) result.message = 'Таблица обращений отсутствует. Сначала необходимо восстановить основную схему поддержки.';
  else if (issues.length) result.message = 'Таблица ответов имеет другую структуру. Автоматическое исправление отключено, чтобы сохранить данные.';
  else if (unfinished) result.message = 'В истории Prisma есть незавершённая миграция. Нужна проверка со стороны администратора базы.';
  else if (ready && recorded) result.message = 'Миграция применена. База готова к ответам пользователям.';
  else if (!base.table && recorded) result.message = 'Миграция записана как применённая, но таблица отсутствует. Необходимо проверить состояние базы.';
  else if (!base.history) {
    // A populated database may be maintained with db push rather than migrate.
    // Install this additive feature without creating a fictitious Prisma baseline.
    if (ready) result.message = 'Таблица ответов готова. Можно отвечать пользователям.';
    else if (!base.canCreate) result.message = 'Подключению приложения не хватает прав для создания таблицы ответов. Обратитесь в поддержку Relaxdev.';
    else {
      result.canApply = true;
      result.message = 'Таблицы ответов нет. Можно создать её кнопкой ниже. История остальных миграций не изменится.';
    }
  }
  else if (!baselineRecorded) result.message = 'Базовая миграция не отмечена как применённая. Сначала нужно проверить историю базы через поддержку Relaxdev.';
  else if (!base.canRecord || (!base.table && !base.canCreate)) result.message = 'Подключению приложения не хватает прав для применения миграции. Обратитесь в поддержку Relaxdev.';
  else {
    result.canApply = true;
    result.message = ready ? 'Таблица ответов готова. Можно записать миграцию в историю Prisma.' : 'Миграция не применена. Можно создать таблицу ответов кнопкой ниже.';
  }
  if (!base.parent || issues.length || unfinished || (!base.table && recorded) ||
    (!result.canApply && !(ready && recorded) && !ready)) result.state = 'blocked';
  return result;
}

export class SupportMigrationBlocked extends Error {
  constructor(public readonly status: SupportMigrationStatus) { super(status.message); }
}
export class SupportMigrationBusy extends Error {}

export async function applySupportMigration() {
  return prisma.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(20261006, 120000) AS acquired`;
    if (!lock.acquired) throw new SupportMigrationBusy('Проверка или применение миграции уже выполняется. Повторите позже.');
    await tx.$queryRaw`SELECT set_config('lock_timeout', '3000', true)`;
    await tx.$queryRaw`SELECT set_config('statement_timeout', '5000', true)`;
    const before = await inspectSupportMigration(tx);
    if (before.ready && before.state === 'ready' && (before.history === 'applied' || before.history === 'missing')) return { ...before, appliedNow: false };
    if (!before.canApply) throw new SupportMigrationBlocked(before);
    // Fixed file only: no user-provided SQL, paths, migration names or process invocation.
    const source = await readFile(join(process.cwd(), 'prisma/migrations/20261006120000_support_replies/migration.sql'), 'utf8');
    const statements = source.replace(/^--[^\n]*(?:\n|$)/gm, '').split(';').map(sql => sql.trim()).filter(Boolean);
    if (statements.length !== 4 || !statements[0].startsWith('CREATE TABLE "SupportReply" (') ||
      !statements[1].startsWith('CREATE UNIQUE INDEX "SupportReply_clientKey_key" ON "SupportReply"') ||
      !statements[2].startsWith('CREATE INDEX "SupportReply_ticketId_createdAt_idx" ON "SupportReply"') ||
      !statements[3].startsWith('CREATE INDEX "SupportReply_status_nextAttemptAt_idx" ON "SupportReply"')) throw new Error('Unexpected support migration file');
    if (!before.ready) for (const sql of statements) await tx.$executeRawUnsafe(sql);
    const after = await inspectSupportMigration(tx);
    if (!after.ready) throw new SupportMigrationBlocked(after);
    if (before.mode === 'prisma') {
      await tx.$executeRaw`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
        VALUES (${randomUUID()}, ${createHash('sha256').update(source).digest('hex')}, ${SUPPORT_REPLY_MIGRATION}, now(), now(), 1)`;
    }
    return { ...await inspectSupportMigration(tx), appliedNow: true };
  }, { maxWait: 5000, timeout: 15000 });
}
