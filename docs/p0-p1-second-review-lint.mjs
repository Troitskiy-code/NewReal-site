import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {relative} from 'node:path';
import {ESLint} from 'eslint';
const eslint=new ESLint();
const report=await eslint.lintFiles(['.']);
const results=[];
for (const result of report.filter(r=>r.errorCount>0)) {
  const file=relative(process.cwd(),result.filePath).replaceAll('\\','/');
  let baseline=null;
  try {
    const source=execFileSync('git',['show',`HEAD:${file}`],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
    baseline=(await eslint.lintText(source,{filePath:result.filePath}))[0]?.errorCount??0;
  } catch {}
  results.push({file,current:result.errorCount,baseline,rules:result.messages.filter(m=>m.severity===2).map(m=>({line:m.line,rule:m.ruleId}))});
}
const summary={currentErrors:report.reduce((n,r)=>n+r.errorCount,0),warnings:report.reduce((n,r)=>n+r.warningCount,0),files:results};
writeFileSync('docs/p0-p1-second-review-lint-summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
