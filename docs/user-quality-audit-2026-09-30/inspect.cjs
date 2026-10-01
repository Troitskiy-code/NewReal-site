const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/mrche/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = __dirname;
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU'});
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400 && r.url().includes('newvers.ai')) errors.push(`${r.status()} ${r.url()}`)});
  const pages=[];
  for(const route of ['/ru','/ru/pricing','/ru/coins','/ru/support','/ru/register','/en','/en/pricing','/ru/create','/ru/chats']) {
    const started=Date.now();
    try {
      const res=await page.goto('https://newvers.ai'+route,{waitUntil:'domcontentloaded',timeout:45000});
      await page.waitForTimeout(3500);
      const name=route.slice(1).replaceAll('/','-');
      await page.screenshot({path:path.join(out,`${name}.png`),fullPage:true});
      const data=await page.evaluate(()=>({title:document.title,lang:document.documentElement.lang,text:document.body.innerText,links:[...document.querySelectorAll('a')].map(a=>({text:a.innerText,href:a.getAttribute('href')})),images:[...document.images].map(i=>({alt:i.alt,loaded:i.complete&&i.naturalWidth>0})),overflow:document.documentElement.scrollWidth>innerWidth}));
      pages.push({route,url:page.url(),status:res.status(),observedAfterMs:Date.now()-started,...data});
      console.log(JSON.stringify({route,url:page.url(),status:res.status(),text:data.text.slice(0,950),images:data.images.filter(i=>!i.loaded).length,overflow:data.overflow}));
    }catch(e){pages.push({route,error:e.message}); console.log(route,e.message)}
  }
  const listing=await context.request.get('https://newvers.ai/api/characters?limit=12&page=1&sort=top');
  const catalog=await listing.json();
  fs.writeFileSync(path.join(out,'catalog.json'),JSON.stringify(catalog,null,2));
  const models=await context.request.get('https://newvers.ai/api/models');
  fs.writeFileSync(path.join(out,'models.json'),JSON.stringify(await models.json(),null,2));
  await page.setViewportSize({width:390,height:844});
  for(const route of ['/ru','/ru/pricing','/ru/register']){
    await page.goto('https://newvers.ai'+route,{waitUntil:'domcontentloaded'});
    await page.waitForTimeout(2500);
    await page.screenshot({path:path.join(out,route.slice(1).replaceAll('/','-')+'-mobile.png'),fullPage:true});
    pages.push({route,mobile:true,...await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,text:document.body.innerText}))});
  }
  fs.writeFileSync(path.join(out,'browser-observations.json'),JSON.stringify({date:'2026-09-30',pages,errors},null,2));
  console.log('Browser audit saved. Errors: '+JSON.stringify(errors));
  await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
