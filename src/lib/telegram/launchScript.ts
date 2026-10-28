// Inline <head> script of the Telegram context (rendered only there, before any other script).
// Telegram passes launch data in the URL fragment (#tgWebAppData=...). The script
//  1) keeps it for the Telegram SDK in sessionStorage under the SDK's own key, which the SDK reads
//     when the fragment is gone, and in window.__nvTgLaunch for the entry page,
//  2) replaces the address with /tg?utm_source=telegram_miniapp&utm_medium=miniapp[&utm_campaign=..]
//     before Metrika, attribution or any request can see the fragment (SEC-04 pattern),
//  3) campaign = first plain segment of start_param ("<campaign>__c_<slug>"), or ?tgsrc= from the bot.
// Keep the start_param grammar in sync with parseTelegramStartParam (verify:telegram compares them).
import { LOCALES } from "../i18nConfig";
export const TELEGRAM_LAUNCH_SCRIPT = `(function(){try{
var l=window.location,hp=new URLSearchParams(l.hash?l.hash.slice(1):""),qp=new URLSearchParams(l.search);
var data=hp.get("tgWebAppData")||qp.get("tgWebAppData");
if(!data)return;
var init={};
hp.forEach(function(v,k){if(k.indexOf("tgWebApp")===0)init[k]=v;});
qp.forEach(function(v,k){if(k.indexOf("tgWebApp")===0&&!(k in init))init[k]=v;});
init.tgWebAppData=data;
window.__nvTgLaunch={initData:data};
try{sessionStorage.setItem("__telegram__initParams",JSON.stringify(init));}catch(e){}
var start="";try{start=new URLSearchParams(data).get("start_param")||"";}catch(e){}
if(!start)start=init.tgWebAppStartParam||"";
var label="";
if(start.length<=512&&/^[A-Za-z0-9_-]+$/.test(start)){start.split("__").some(function(p){
if(p.indexOf("c_")!==0&&p.indexOf("link_")!==0&&p.indexOf("ref_")!==0&&p.indexOf("login_")!==0&&p.indexOf("merge_confirm_")!==0&&/^[A-Za-z0-9_-]{1,64}$/.test(p)){label=p;return true;}return false;});}
var src=qp.get("tgsrc")||"";
if(!label&&/^[A-Za-z0-9_-]{1,64}$/.test(src))label=src;
var keep=new URLSearchParams();
qp.forEach(function(v,k){if(k.indexOf("tgWebApp")!==0&&k!=="tgsrc"&&k.indexOf("utm_")!==0)keep.append(k,v);});
keep.set("utm_source","telegram_miniapp");keep.set("utm_medium","miniapp");if(label)keep.set("utm_campaign",label);
var entry=new RegExp("^/(?:(?:"+${JSON.stringify(LOCALES)}.join("|")+")/)?tg(?:/|$)").test(l.pathname);
var next=(entry?l.pathname:"/tg")+"?"+keep.toString();
history.replaceState(history.state,"",entry?next:l.pathname);
if(!entry)l.replace(next);
}catch(e){}})();`;
