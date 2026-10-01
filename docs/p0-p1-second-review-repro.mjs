// Independent review. Uses a new private local PostgreSQL instance; never loads .env.
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const dir = mkdtempSync(join(tmpdir(), 'nv-independent-p0p1-'));
const pg = new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:'synthetic_review_only',port,persistent:false});
let db;
function runScript(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types','--import','./scripts/alias-register.mjs',file], {
      cwd: process.cwd(), env: {...process.env}, stdio:'inherit'
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Test script exit ${code}`)));
  });
}
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_p0p1_test');
  process.env.DATABASE_URL = `postgresql://postgres:synthetic_review_only@127.0.0.1:${port}/nv_p0p1_test`;
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
  // Existing test rejects TEST_DATABASE_URL == DATABASE_URL; omit parent live variable for the child.
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  await runScript('scripts/integration-p0-p1.ts');
  process.env.DATABASE_URL = saved;
  const {prisma} = await import('../src/lib/prisma.js'); db = prisma;
  const {claimGuestGeneration,failGuestGeneration} = await import('../src/lib/guestRequestStore.ts');
  const user = await db.user.create({data:{email:`review-${randomUUID()}@example.test`}});
  const character = await db.character.create({data:{name:'Review',description:'test',isPublic:true,userId:user.id}});
  const sessionId = `review-${randomUUID()}`;
  const requestId = `retry-${randomUUID()}`;
  const input = {sessionId,requestId,characterId:character.id,message:'retry test',quotaLimit:5};
  const first = await claimGuestGeneration(input);
  if (first.kind !== 'run') throw new Error('Initial claim failed');
  await failGuestGeneration({sessionId,requestId,attempt:first.attempt});
  const before = await db.anonymousSession.findUnique({where:{sessionId}});
  // Force both transactions to read the same failed attempt before either reserves quota.
  const originalTransaction = db.$transaction.bind(db);
  let reads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  db.$transaction = async (callback, options) => {
    if (typeof callback !== 'function') return originalTransaction(callback, options);
    return originalTransaction(tx => callback(new Proxy(tx, {get(target, prop) {
      if (prop === 'anonymousChatRequest') return new Proxy(target[prop], {get(model, method) {
        if (method === 'findUnique') return async args => {
          const result = await model.findUnique(args);
          if (args.where.sessionId_requestId?.requestId === requestId && result?.status === 'failed') {
            reads++; if (reads === 2) release(); await gate;
          }
          return result;
        };
        const value = model[method]; return typeof value === 'function' ? value.bind(model) : value;
      }});
      const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
    }})), options);
  };
  const retries = await Promise.all([claimGuestGeneration(input),claimGuestGeneration(input)]);
  db.$transaction = originalTransaction;
  const after = await db.anonymousSession.findUnique({where:{sessionId}});
  console.log('INDEPENDENT_RACE_RESULT',JSON.stringify({before:before.messagesCount,after:after.messagesCount,kinds:retries.map(r=>r.kind),expectedQuota:1}));
  if (after.messagesCount !== 1) console.log('REPRODUCED: losing parallel retry consumes quota without running generation');
  // Force an old failure handler to read attempt 1, then let attempt 2 claim ownership.
  const staleSession = `stale-${randomUUID()}`, staleRequest = `stale-${randomUUID()}`;
  const staleInput = {sessionId:staleSession,requestId:staleRequest,characterId:character.id,message:'stale test',quotaLimit:5};
  const oldAttempt = await claimGuestGeneration(staleInput);
  let observed, resume;
  const observedGate = new Promise(resolve => {observed=resolve;});
  const resumeGate = new Promise(resolve => {resume=resolve;});
  db.$transaction = async (callback, options) => originalTransaction(tx => callback(new Proxy(tx,{get(target,prop) {
    if (prop === 'anonymousChatRequest') return new Proxy(target[prop],{get(model,method) {
      if (method === 'findUnique') return async args => {
        const result = await model.findUnique(args);
        if (args.where.sessionId_requestId?.requestId === staleRequest && result?.attempt === 1) {
          observed(); await resumeGate;
        }
        return result;
      };
      const value=model[method];return typeof value==='function'?value.bind(model):value;
    }});
    const value=target[prop];return typeof value==='function'?value.bind(target):value;
  }})),options);
  const oldFailure = failGuestGeneration({sessionId:staleSession,requestId:staleRequest,attempt:oldAttempt.attempt});
  await observedGate;
  db.$transaction = originalTransaction;
  const newer = await claimGuestGeneration({...staleInput,now:new Date(Date.now()+120000)});
  resume(); await oldFailure;
  const staleAfter = await db.anonymousSession.findUnique({where:{sessionId:staleSession}});
  const newerRow = await db.anonymousChatRequest.findUnique({where:{sessionId_requestId:{sessionId:staleSession,requestId:staleRequest}}});
  console.log('INDEPENDENT_STALE_REFUND',JSON.stringify({newKind:newer.kind,attempt:newerRow.attempt,status:newerRow.status,quota:staleAfter.messagesCount,refunded:newerRow.refundedAt!==null,expectedQuota:1}));
  if (staleAfter.messagesCount===0) console.log('REPRODUCED: stale failure refunds quota reserved for newer active attempt');
  const {redactSensitive}=await import('../src/lib/redactSensitive.ts');
  const logCases=[
    ['bearer',new Error('Authorization: Bearer SYNTHETIC_AUTH_VALUE')],
    ['quoted',new Error('password="SYNTHETIC_PASSWORD_VALUE"')],
    ['dsnPlusToken',new Error('postgresql://synthetic:synthetic@localhost/test token=SYNTHETIC_TOKEN_VALUE')]
  ];
  for (const [label,value] of logCases) console.log('INDEPENDENT_REDACTION',label,JSON.stringify(redactSensitive(value)).includes('SYNTHETIC_')?'LEAK':'masked');
  const circular=[];circular.push(circular);
  try {redactSensitive(circular);console.log('INDEPENDENT_ARRAY_CYCLE handled');}
  catch(error) {console.log('INDEPENDENT_ARRAY_CYCLE',error.name);}
} finally {
  if (db) await db.$disconnect();
  await pg.stop();
}
