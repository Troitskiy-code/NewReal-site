const fs=require('fs');
const path=require('path');
const {chromium}=require('C:/Users/mrche/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU'});
 const page=await context.newPage();
 const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'catalog.json')));
 const character=catalog.data.find(x=>x.name==='Эмили Чен')||catalog.data[1];
 const observations={character:{id:character.id,name:character.name},turns:[],pages:[],errors:[]};
 page.on('pageerror',e=>observations.errors.push(e.message));
 await page.goto('https://newvers.ai/ru/character/'+character.slug,{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(2000);
 observations.pages.push({name:'character',url:page.url(),text:await page.locator('body').innerText()});
 await page.screenshot({path:path.join(__dirname,'character.png'),fullPage:true});
 await page.goto('https://newvers.ai/ru/chat/'+character.id,{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(2500);
 observations.pages.push({name:'chat-before',text:await page.locator('body').innerText()});
 await page.screenshot({path:path.join(__dirname,'chat-before.png'),fullPage:true});
 const prompts=[
  'Привет, Эмили! Меня зовут Лев. Я держу красный блокнот, а наша встреча назначена в кафе «Полярис». Ответь коротко, в образе, не описывай мои действия за меня.',
  'Как меня зовут, какого цвета мой блокнот и в каком кафе мы встречаемся? Ответь одной фразой.',
  'В кафе гаснет свет. Покажи реакцию Эмили в двух предложениях, оставь мне выбор следующего действия.'
 ];
 for(const prompt of prompts){
   await page.locator('textarea').fill(prompt);
   const start=Date.now();
   const responsePromise=page.waitForResponse(r=>r.url().endsWith('/api/chat/'+character.id)&&r.request().method()==='POST',{timeout:90000});
   await page.getByRole('button',{name:'Отправить',exact:true}).click();
   const res=await responsePromise;
   const headersMs=Date.now()-start;
   const stream=await res.text();
   await page.waitForTimeout(650);
   const turn={prompt,status:res.status(),headersMs,completeMs:Date.now()-start,stream,text:await page.locator('body').innerText()};
   observations.turns.push(turn);
   console.log(JSON.stringify({prompt,status:turn.status,headersMs,completeMs:turn.completeMs,stream:stream.slice(-2200)}));
   fs.writeFileSync(path.join(__dirname,'scenario-observations.json'),JSON.stringify(observations,null,2));
 }
 await page.screenshot({path:path.join(__dirname,'chat-after-3.png'),fullPage:true});
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForTimeout(2000);
 observations.pages.push({name:'chat-after-refresh',text:await page.locator('body').innerText()});
 await page.screenshot({path:path.join(__dirname,'chat-after-refresh.png'),fullPage:true});
 await page.goto('https://newvers.ai/en/chat/'+character.id,{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(1500);
 observations.pages.push({name:'english-chat',text:await page.locator('body').innerText(),placeholder:await page.locator('textarea').getAttribute('placeholder')});
 await page.screenshot({path:path.join(__dirname,'english-chat.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.goto('https://newvers.ai/ru/chat/'+character.id,{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(2000);
 observations.pages.push({name:'mobile-chat',text:await page.locator('body').innerText(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
 await page.screenshot({path:path.join(__dirname,'mobile-chat.png'),fullPage:true});
 await page.goto('https://newvers.ai/ru?sort=top',{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(1800);
 await page.screenshot({path:path.join(__dirname,'mobile-catalog-viewport.png')});
 const sortResults=await Promise.all(['top','for-you'].map(async sort=>{const r=await context.request.get('https://newvers.ai/api/characters?limit=12&page=1&sort='+sort);const d=await r.json();return{sort,ids:d.data.map(x=>x.id)}}));
 observations.sorts=sortResults;
 await page.setViewportSize({width:1440,height:1000});
 await page.goto('https://newvers.ai/ru/register?callbackUrl=%2Fru%2Fchat%2F'+character.id,{waitUntil:'domcontentloaded'});
 await page.waitForTimeout(1200);
 observations.pages.push({name:'register-input-labels',inputs:await page.locator('input').evaluateAll(els=>els.map(e=>({type:e.type,placeholder:e.placeholder,ariaLabel:e.getAttribute('aria-label'),labelCount:e.labels?.length||0}))) });
 for(const url of ['https://kindroid.ai/v2/docs/subscriptions/','https://kindroid.ai/v2/docs/llm-guides/','https://nomi.ai/faq/']){
  try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000});await page.waitForTimeout(6000);const text=await page.locator('body').innerText();const data={name:'competitor',url,title:await page.title(),textCharacters:text.length,unlimitedLite:/Unlimited messages on Lite/.test(text),unlimitedFlagship:/Unlimited access to flagship language models/.test(text),webMonthlyUSD:url.includes('/subscriptions/')&&text.includes('$13.99')?13.99:null};observations.pages.push(data);console.log(JSON.stringify(data));}catch(e){observations.errors.push(url+' '+e.message)}
 }
 fs.writeFileSync(path.join(__dirname,'scenario-observations.json'),JSON.stringify(observations,null,2));
 await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
