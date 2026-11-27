const MAX_LIVE_EVENTS=4096;

// Owns one worker per power-up. Leaving the build or editing its recipe
// terminates the session; an old worker cannot update a different design.
export class ChipLiveSession {
  constructor(refresh){this.refresh=refresh;this.close();}
  close(){
    this.worker?.terminate();this.worker=null;this.serial=0;this.ready=this.running=false;this.levels=null;
    this.log=[];this.logStart=0;this.note='';
    this.state={clock:0,pc:0,acc:0,commits:0,dead:new Set(),loaded:0,rebuilt:0,refused:0,digest:0,spare:0,write:null};
  }
  open(bundle,policy){
    this.close();this.note='Powering up mapped cells…';
    let w;
    try { w=this.worker=new Worker(new URL('./live-fpga-worker.mjs',import.meta.url),{type:'module'}); }
    catch(error){this.note=`Could not start live FPGA worker: ${error.message}`;return;}
    const fail=msg=>{if(w!==this.worker)return;this.close();this.note=msg;this.refresh();};
    w.onerror=e=>fail(e.message||'Could not run FPGA worker');
    w.onmessage=({data:m})=>{
      if(w!==this.worker)return;if(m.error){fail(m.error);return;}
      this.state={...m.state,dead:new Set(m.state.dead)};this.levels=m.levels;
      this.log.push(...m.events);
      const excess=this.log.length-MAX_LIVE_EVENTS;
      if(excess>0){
        this.log.splice(0,excess);
        this.logStart+=excess;
      }
      if(m.serial===this.serial){this.ready=true;this.running=m.running;this.note=m.note;}
      this.refresh();
    };
    w.postMessage({type:'init',serial:0,image:bundle.live,build:bundle.build,siteCount:bundle.fabric.sites.length,policy});
  }
  send(message){if(!this.worker||!this.ready)return;this.running=true;this.note='';this.worker.postMessage({...message,serial:++this.serial});this.refresh();}
  run(until,count=100000){if(!this.running)this.send({type:'run',until,count});}
  fault(domain){if(!this.state.dead.has(domain))this.send({type:'fault',domain});}
}
