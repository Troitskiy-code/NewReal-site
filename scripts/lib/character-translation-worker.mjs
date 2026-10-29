/** Polls the private authenticated worker; PostgreSQL owns leases, progress and daily spend. */
export function startCharacterTranslationWorker({port=process.env.PORT||'3000',secret=process.env.CRON_SECRET,onEvent=()=>{},fetchImpl=fetch,intervalMs=10000}={}) {
  if(!secret||!/^\d{1,5}$/.test(String(port)))return {stop(){}};
  let stopped=false,timer,controller,lastFailure;
  async function tick(){
    if(stopped)return;
    controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),1150000);timeout.unref?.();
    try{
      const response=await fetchImpl(`http://127.0.0.1:${port}/api/cron/translate-characters`,{method:'POST',headers:{Authorization:`Bearer ${secret}`},redirect:'error',signal:controller.signal});
      if(!response.ok&&lastFailure!==response.status)onEvent({event:'translation_worker_unavailable',status:response.status});
      lastFailure=response.ok?null:response.status;await response.body?.cancel();
    }catch{if(!stopped&&lastFailure!=='network')onEvent({event:'translation_worker_waiting_for_app'});lastFailure='network';}
    finally{clearTimeout(timeout);if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref?.();}}
  }
  timer=setTimeout(tick,intervalMs);timer.unref?.();
  return {stop(){stopped=true;clearTimeout(timer);controller?.abort();}};
}
