// Isolated browser review. All requests are intercepted; no real payment or analytics.
const fs=require('node:fs');
const ts=require('typescript');
const {chromium}=require('C:/Users/mrche/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const loaderSource=fs.readFileSync('src/components/YandexMetrika.tsx','utf8');
const primaryUrl=loaderSource.match(/const METRIKA_TAG_PRIMARY\s*=\s*"([^"]+)"/)?.[1]??'https://mc.yandex.ru/metrika/tag.js';
const fallbackUrl=loaderSource.match(/const METRIKA_TAG_FALLBACK\s*=\s*"([^"]+)"/)?.[1]??'https://mc.yandex.com/metrika/tag.js';
const loader=loaderSource.match(/__html:\s*`([\s\S]*?)`/)[1].replace('${METRIKA_COUNTER_ID}','112171267')
  .replaceAll('${METRIKA_TAG_PRIMARY}',primaryUrl).replaceAll('${METRIKA_TAG_FALLBACK}',fallbackUrl);
function compiled(file) {return ts.transpileModule(fs.readFileSync(file,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;}
const metrika=compiled('src/lib/metrika.ts'),tracker=compiled('src/lib/goalTracking.ts');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const results=[];
  try {
    for (const test of [
      {name:'primary fails, fallback is available, VC',fallback:true,type:'vc',path:'coins'},
      {name:'both fail, VC',fallback:false,type:'vc',path:'coins'},
      {name:'both fail, subscription',fallback:false,type:'subscription',path:'pricing'}
    ]) {
      const context=await browser.newContext();
      const page=await context.newPage(),failures=[],consoleErrors=[],requests=[];
      page.setDefaultTimeout(5000);
      page.on('request',r=>{if(r.url().includes('/metrika/tag.js'))requests.push(r.url());});
      page.on('requestfailed',r=>failures.push({url:r.url(),error:r.failure()?.errorText}));
      page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
      await page.route('**/*',async route=>{
        const url=route.request().url();
        if(url.startsWith('http://metrika-review.test/'))return route.fulfill({contentType:'text/html',body:
          '<html><head><script>window.__sent=[];</script></head><body>isolated review</body></html>'});
        if(url===fallbackUrl&&test.fallback)return route.fulfill({contentType:'application/javascript',body:
          'window.__tagLoaded=true;window.ym=function(){window.__sent.push(Array.from(arguments));};'});
        return route.abort('connectionclosed');
      });
      await page.goto(`http://metrika-review.test/${test.path}?payment=success&type=${test.type}&plan=dialog&InvId=99123`);
      await page.evaluate(loader);
      await page.waitForTimeout(1000);
      await page.addScriptTag({content:`(function(){const exports={};const process={env:{}};${metrika}\nwindow.__metrika=exports;})()`});
      const ready=await page.evaluate(()=>window.__metrika.waitForMetrika());
      await page.addScriptTag({content:`(function(){const exports={};const require=(name)=>{
        if(name==='react')return{useEffect:(callback)=>{window.__cleanup=callback();}};
        if(name==='next/navigation')return{useSearchParams:()=>new URLSearchParams(window.location.search)};
        if(name==='@/lib/metrika')return window.__metrika;
        throw new Error('unexpected import '+name);
      };window.fetch=async()=>({ok:true,json:async()=>({status:'confirmed'})});
      ${tracker}\nexports.usePaymentGoal();})()`});
      const storageKey=test.type==='vc'?'nv-metrika-goal:vc:99123':'nv-metrika-goal:subscription:dialog:99123';
      await page.waitForFunction(key=>sessionStorage.getItem(key)==='1',storageKey);
      const state=await page.evaluate(key=>({tagLoaded:Boolean(window.__tagLoaded),markedFired:sessionStorage.getItem(key),
        queryCleared:location.search==='',actualLibraryCalls:window.__sent.filter(c=>c[1]==='reachGoal').length,
        queuedCalls:window.ym.a?.length??0}),storageKey);
      const originalRequests=[...requests];
      let freshElementControl=null;
      if(test.fallback){
        await page.evaluate(url=>{const s=document.createElement('script');s.src=url;document.head.appendChild(s);},fallbackUrl);
        await page.waitForTimeout(1000);
        freshElementControl={loaded:await page.evaluate(()=>Boolean(window.__tagLoaded)),newRequestIssued:requests.length>originalRequests.length};
      }
      results.push({test:test.name,primaryUrl,fallbackUrl,ready,...state,requests:originalRequests,failures,consoleErrors,freshElementControl});
      await context.close();
    }
  } finally {await browser.close();}
  fs.writeFileSync('docs/metrika-purchase-review.json',JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);process.exitCode=1;});
