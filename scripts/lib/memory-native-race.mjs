// Real PostgreSQL row-lock regression; the vector value is a text domain because this
// check tests concurrent writes, not vector distances. Never receives a production URL.
import { Client } from 'pg';
import { join } from 'node:path';
import { createModuleLoader } from './memory-test-harness.mjs';

export async function verifyEmbeddingWriteRace({ databaseUrl, root, sourceRef, operation = 'insert' }) {
  if (!['insert', 'delete'].includes(operation)) throw new Error('Unknown native memory race operation');
  const schema = `memory_embedding_${operation}_race`;
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/nv_memory_test') {
    throw new Error('Native memory race requires the isolated harness database');
  }
  const gate = new Client({ connectionString: databaseUrl });
  const writer = new Client({ connectionString: databaseUrl });
  const editor = new Client({ connectionString: databaseUrl });
  const errors = [];
  let insertion;
  let gateLocked = false;
  try {
    await Promise.all([gate.connect(), writer.connect(), editor.connect()]);
    await gate.query(`
      CREATE SCHEMA ${schema};
      CREATE DOMAIN ${schema}.vector AS text;
      CREATE TABLE ${schema}."Message" (id text PRIMARY KEY, content text NOT NULL);
      CREATE TABLE ${schema}."MessageEmbedding"
        (id text PRIMARY KEY, "messageId" text UNIQUE, embedding ${schema}.vector, "createdAt" timestamptz);
      INSERT INTO ${schema}."Message" VALUES ('race-message', 'old content');
      ${operation === 'delete' ? `INSERT INTO ${schema}."MessageEmbedding" VALUES ('existing-vector', 'race-message', '[0.25,0.75]', NOW());` : ''}
      CREATE FUNCTION ${schema}.pause_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(81713);
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END;
      $$;
      CREATE TRIGGER pause_write BEFORE ${operation.toUpperCase()} ON ${schema}."MessageEmbedding"
        FOR EACH ROW EXECUTE FUNCTION ${schema}.pause_write();
    `);
    await Promise.all([writer, editor].map((client) => client.query(`SET search_path = ${schema}, public`)));
    await writer.query("SET statement_timeout = '10s'");
    await editor.query("SET lock_timeout = '300ms'");
    const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await gate.query('SELECT pg_advisory_lock(81713)');
    gateLocked = true;
    const adapter = {
      async $executeRaw(strings, ...values) {
        let sql = '';
        strings.forEach((part, index) => { sql += part + (index < values.length ? `$${index + 1}` : ''); });
        try { insertion = writer.query(sql, values); return (await insertion).rowCount; }
        catch (error) { errors.push(error.code); throw error; }
      },
    };
    const { load } = createModuleLoader({ prismaFor: () => adapter, sourceRef });
    const embeddings = load(join(root, 'src/lib/messageEmbeddings.ts'));
    if (operation === 'insert') {
      void embeddings.saveMessageEmbedding('race-message', new Float32Array([0.25, 0.75]), 'old content');
    } else {
      if (typeof embeddings.scheduleMessageEmbeddingRefresh !== 'function') return { pass: false, unsupported: true };
      embeddings.scheduleMessageEmbeddingRefresh('race-message', 'old content', 'synthetic_memory_key', false);
    }
    // Freeze inside the actual write, after SELECT has read the source content.
    const deadline = Date.now() + 5000;
    let paused = false;
    while (Date.now() < deadline) {
      const state = await gate.query('SELECT wait_event FROM pg_stat_activity WHERE pid = $1', [pid]);
      if (state.rows[0]?.wait_event === 'advisory') { paused = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!paused) throw new Error(`Embedding ${operation} did not reach the concurrency gate: ${errors.join(',')}`);
    let rewriteBlocked = false;
    try { await editor.query('UPDATE "Message" SET content = $1 WHERE id = $2', ['new content', 'race-message']); }
    catch (error) {
      if (error.code !== '55P03') throw error;
      rewriteBlocked = true;
    }
    if (!rewriteBlocked && operation === 'insert') await editor.query('DELETE FROM "MessageEmbedding" WHERE "messageId" = $1', ['race-message']);
    await gate.query('SELECT pg_advisory_unlock(81713)');
    gateLocked = false;
    await insertion;
    if (rewriteBlocked) {
      await editor.query('UPDATE "Message" SET content = $1 WHERE id = $2', ['new content', 'race-message']);
      await editor.query('DELETE FROM "MessageEmbedding" WHERE "messageId" = $1', ['race-message']);
    }
    const staleVectors = Number((await editor.query('SELECT COUNT(*) AS n FROM "MessageEmbedding"')).rows[0].n);
    return { pass: rewriteBlocked && staleVectors === 0 && errors.length === 0, rewriteBlocked, staleVectors, errors };
  } finally {
    if (gateLocked) await gate.query('SELECT pg_advisory_unlock(81713)').catch(() => {});
    if (insertion) await insertion.catch(() => {});
    await Promise.all([gate, writer, editor].map((client) => client.end().catch(() => {})));
  }
}
