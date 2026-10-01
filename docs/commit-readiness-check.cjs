// Read-only Git/file inventory. Never prints credential values or changes the index.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const ts=require('typescript');
function git(args) {return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function config(key) {try{return git(['config','--get',key]);}catch{return '';}}
const secrets=[];
const auth=git(['show','HEAD:src/lib/auth.ts']);
const syntax=ts.createSourceFile('auth.ts',auth,ts.ScriptTarget.Latest,true);
function walk(node) {
  if(ts.isStringLiteral(node)&&/^[a-f0-9]{32,}$/i.test(node.text))secrets.push(node.text);
  ts.forEachChild(node,walk);
}
walk(syntax);
const prisma=git(['show','HEAD:src/lib/prisma.js']);
for(const match of prisma.matchAll(/postgres(?:ql)?:\/\/[^:\s/'"`]+:([^@\s'"`]+)@/g)) {
  try{secrets.push(decodeURIComponent(match[1]));}catch{secrets.push(match[1]);}
}
const paths=[...new Set(git(['ls-files','-c','-o','--exclude-standard']).split('\n'))];
const findings=[],large=[],textTypes=/\.(?:ts|tsx|js|jsx|cjs|mjs|json|md|txt|log|sql|yml|yaml|toml|csv|html)$|(?:^|\/)\.env\.example$/;
let bytes=0;
for(const file of paths) {
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())continue;
  const size=fs.statSync(file).size;bytes+=size;
  if(size>50*1024*1024)large.push({file,bytes:size});
  if(!textTypes.test(file))continue;
  const content=fs.readFileSync(file,'utf8');
  const matched=secrets.some(value=>value.length>=12&&content.includes(value));
  if(matched)findings.push({file,kind:'original exposed credential present'});
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))findings.push({file,kind:'private key block'});
  if(/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b/.test(content))findings.push({file,kind:'credential-shaped literal'});
}
let remote=null;
try {
  const raw=git(['remote','get-url','origin']);
  if(raw.includes('://')) {const url=new URL(raw);remote={host:url.hostname,repository:url.pathname};}
  else {const m=raw.match(/(?:[^@]+@)?([^:]+):(.+)/);if(m)remote={host:m[1],repository:m[2]};}
}catch{}
let upstream=null;try{upstream=git(['rev-parse','--abbrev-ref','@{upstream}']);}catch{}
let pushDryRun;
try {
  execFileSync('git',['push','--dry-run','origin','HEAD:refs/heads/codex/p0-p1-wip'],{
    encoding:'utf8',timeout:20000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']
  });pushDryRun={passed:true,note:'Only HEAD dry-run to a proposed WIP branch; no commit or push performed'};
}catch(error){pushDryRun={passed:false,exitCode:error.status??null,note:'Remote dry-run failed; raw output withheld to avoid exposing credentials'};}
const result={branch:git(['branch','--show-current']),upstream,remote,identityConfigured:Boolean(config('user.name')&&config('user.email')),
  commitSigning:config('commit.gpgsign')||'unset',customHooksPathConfigured:Boolean(config('core.hooksPath')),
  fileCount:paths.length,totalBytes:bytes,knownCredentialPatterns:secrets.length,secretFindings:findings,largeFiles:large,pushDryRun};
fs.writeFileSync(path.join('docs','commit-readiness-check.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
