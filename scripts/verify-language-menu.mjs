// Exercises the real component, translations and stylesheet in an isolated browser.
// No Next build, application server, credentials, database or external requests.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const root = process.cwd();
const configuredManifest = JSON.parse(readFileSync(path.join(root, "public/locales/manifest.json"), "utf8"));
const enabledCount = Object.values(configuredManifest.locales).filter(locale => locale.enabled).length;
const runtime = path.join(root, ".runtime/language-menu");
mkdirSync(runtime, { recursive: true });
writeFileSync(path.join(runtime, "tsx-loader.cjs"), `module.exports = function(source) {
  return require('typescript').transpileModule(source, {compilerOptions:{module:99,target:9,jsx:4,esModuleInterop:true}}).outputText;
};`);
writeFileSync(path.join(runtime, "navigation.js"), `export const usePathname = () => window.location.pathname;`);
writeFileSync(path.join(runtime, "entry.js"), `
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import I18nProvider from '@/components/I18nProvider';
import manifest from '../../public/locales/manifest.json';
import { LOCALES, resolveLocale } from '@/lib/i18nConfig';
if (new URLSearchParams(location.search).has('ten')) {
  const extra = [['pt','Português','Portuguese'],['de','Deutsch','German'],['fr','Français','French'],['it','Italiano','Italian'],['tr','Türkçe','Turkish'],['ja','日本語','Japanese'],['ko','한국어','Korean']];
  LOCALES.splice(0, LOCALES.length, 'ru', 'en', 'es');
  for (const [code,label,languageName] of extra) {
    manifest.locales[code] = {label,languageName,intl:code,direction:'ltr',fallback:'en',enabled:true};
    if (!LOCALES.includes(code)) LOCALES.push(code);
  }
}
const locale = resolveLocale(location.pathname.split('/')[1]);
function Fixture() {
  return React.createElement(StrictMode,null,React.createElement(I18nProvider,{locale},
    React.createElement('header',{style:{height:80,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px',borderBottom:'1px solid #2a2638'}},
      React.createElement('span',{style:{fontSize:22,fontWeight:600}},'newverse'), React.createElement(LanguageSwitcher)),
    React.createElement('main',{style:{padding:24}},React.createElement('h1',null,'NewVerse'),React.createElement('p',null,'Language menu verification')),
    React.createElement('div',{id:'nested',style:{position:'absolute',bottom:20,left:16,width:220,overflow:'hidden',borderRadius:12}},React.createElement(LanguageSwitcher,{variant:'menu'}))));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`);
await new Promise((resolve, reject) => {
  const compiler = webpack({ mode:"development", devtool:false, cache:false,
    entry:path.join(runtime,"entry.js"), output:{path:runtime,filename:"menu.js",hashFunction:"sha256"},
    resolve:{extensions:[".tsx",".ts",".js",".json"],alias:{"@":path.join(root,"src"),"next/navigation$":path.join(runtime,"navigation.js")}},
    module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(runtime,"tsx-loader.cjs")}]},
  });
  compiler.run((error, stats) => compiler.close(() => {
    if(error) reject(error); else if(stats.hasErrors()) reject(new Error(stats.toString({all:false,errors:true}))); else resolve();
  }));
});
const cssPath=path.join(root,"src/app/globals.css");
const css=(await postcss([tailwind({base:root})]).process(readFileSync(cssPath,"utf8"),{from:cssPath})).css;
const script=readFileSync(path.join(runtime,"menu.js"),"utf8").replaceAll("</script", "<\\/script");
const html=`<!doctype html><html style="--font-onest:'Segoe UI';--font-unbounded:'Segoe UI'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`;
let browser;
const errors=[];
try {
  browser=await chromium.launch({channel:"msedge",headless:true});
  const context=await browser.newContext({viewport:{width:1200,height:800},locale:"es-ES"});
  await context.route("**/*",route=>new URL(route.request().url()).origin==="https://language.test"
    ? route.fulfill({status:200,contentType:"text/html",body:html}) : route.abort());
  const page=await context.newPage();
  page.on("pageerror",error=>errors.push(error.message));
  await context.addCookies([{name:"NEXT_LOCALE",value:"ru",url:"https://language.test"}]);
  await page.goto("https://language.test/ru/genres?sort=top#section");
  const trigger=page.locator('header button[aria-haspopup="dialog"]');
  await trigger.click();
  const dialog=page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(await dialog.locator("li").count(),enabledCount,"only enabled languages appear");
  assert.equal(await dialog.getByRole("button",{name:"Русский Russian",exact:true}).getAttribute("aria-pressed"),"true");
  assert.equal(await page.getByRole("searchbox").evaluate(el=>el===document.activeElement),true);
  await page.getByRole("searchbox").fill("испан");
  assert.equal(await dialog.locator("li").count(),1,"localized name search");
  await page.getByRole("searchbox").fill("espanol");
  assert.equal(await dialog.locator("li").count(),1,"search ignores diacritics");
  await page.getByRole("searchbox").fill("missing-language");
  assert.equal(await dialog.getByRole("status").innerText(),"Язык не найден");
  await page.keyboard.press("Escape");
  await dialog.waitFor({state:"detached"});
  assert.equal(await trigger.evaluate(el=>el===document.activeElement),true,"Escape restores focus");
  await trigger.click();
  await page.mouse.click(8,8);
  await dialog.waitFor({state:"detached"});
  await trigger.click();
  await dialog.getByRole("button",{name:"Español испанский",exact:true}).click();
  await page.waitForURL("https://language.test/es/genres?sort=top#section");
  assert.equal((await context.cookies()).find(c=>c.name==="NEXT_LOCALE").value,"es","manual preference persists");
  await context.addCookies([{name:"NEXT_LOCALE_AUTO",value:"1",url:"https://language.test"}]);
  await trigger.click();
  assert.equal(await dialog.getByRole("button",{name:/Automático/}).getAttribute("aria-pressed"),"true");
  await dialog.getByRole("button",{name:"Español Spanish",exact:true}).click();
  assert.equal((await context.cookies()).find(c=>c.name==="NEXT_LOCALE").value,"es");
  assert.equal((await context.cookies()).find(c=>c.name==="NEXT_LOCALE_AUTO").value,"0","choosing the current language switches out of automatic mode");
  await trigger.click();
  await dialog.getByRole("button",{name:/Automático/}).click();
  assert.equal((await context.cookies()).find(c=>c.name==="NEXT_LOCALE_AUTO").value,"1");
  await page.goto("https://language.test/ru/genres");
  await trigger.click();
  await dialog.getByRole("button",{name:/Автоматически/}).click();
  await page.waitForURL("https://language.test/es/genres");
  assert.equal((await context.cookies()).find(c=>c.name==="NEXT_LOCALE_AUTO").value,"1");
  assert.equal((await context.cookies()).find(c=>c.name==="NEXT_LOCALE").value,"es");
  // Ten languages exist only in this browser fixture, never in the project's manifest.
  await page.goto("https://language.test/ru/genres?ten");
  await trigger.click();
  assert.equal(await dialog.locator("li").count(),10);
  const rows=await dialog.locator("li").evaluateAll(items=>items.map(el=>({left:el.getBoundingClientRect().left,top:el.getBoundingClientRect().top})));
  assert.ok(rows.every(row=>row.left===rows[0].left),"desktop languages use one column");
  assert.ok(rows.every((row,i)=>i===0||row.top>rows[i-1].top));
  const desktop=await dialog.boundingBox();
  assert.ok(desktop.x>=0 && desktop.y>=80 && desktop.x+desktop.width<=1200 && desktop.y+desktop.height<=800);
  await page.screenshot({path:path.join(runtime,"desktop.png")});
  await page.keyboard.press("Escape");
  await page.locator('#nested button').click();
  const footerMenu=await dialog.boundingBox();
  assert.ok(footerMenu.y>=0 && footerMenu.y+footerMenu.height<780,"footer menu opens upward without clipping");
  await page.keyboard.press("Escape");
  for(const viewport of [{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
    await page.setViewportSize(viewport);
    await page.locator('#nested button').click();
    const bounds=await dialog.boundingBox();
    assert.ok(bounds.x>=-1 && bounds.y>=0 && bounds.x+bounds.width<=viewport.width+1 && bounds.y+bounds.height<=viewport.height+1,"menu stays inside the viewport");
    if(viewport.width<768) {
      assert.ok(Math.abs(bounds.y+bounds.height-viewport.height)<=1,"mobile menu is a bottom sheet");
      assert.equal(await page.getByRole("searchbox").evaluate(el=>el===document.activeElement),false,"no automatic mobile keyboard");
    }
    assert.equal(await dialog.getByRole("button",{name:/Автоматически/}).isVisible(),true);
    await dialog.locator("li").last().scrollIntoViewIfNeeded();
    assert.equal(await dialog.locator("li").last().isVisible(),true);
    if(viewport.width===390) await page.screenshot({path:path.join(runtime,"mobile.png")});
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true,"focus stays in dialog");
    await page.keyboard.press("Escape");
  }
  assert.equal(await page.evaluate(()=>document.body.style.overflow),"","closing restores page scrolling");
  assert.deepEqual(errors,[]);
  console.log("PASS language menu: enabled languages, ten-language layout, search, manual/automatic cookies, URL/query/hash, keyboard, focus, outside click, clipped ancestors and mobile/landscape viewports");
} finally { await browser?.close(); }
