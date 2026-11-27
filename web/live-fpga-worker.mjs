import { LiveFpga,validateLiveImage } from './live-fpga.mjs';

// Only circuit data and external control inputs enter this worker. Slices
// allow pause/fault messages during a long boot or parity reconstruction.
let chip,job,timer,serial=0,lastUpdate=0;
function cancel(){clearTimeout(timer);job=null;}
function publish(note='') {
  const levels=chip.v.slice();lastUpdate=performance.now();
  postMessage({serial,running:Boolean(job),note,state:chip.snapshot(),events:chip.takeEvents(),levels},[levels.buffer]);
}
function pump(){
  if(!job)return;
  const deadline=performance.now()+12;
  do {
    for(let i=0;i<32;i++){
      const before=chip.events.length;chip.tick();
      const done=(job.until==='event'&&chip.events.length>before)||(job.until==='commit'&&chip.commits!==job.start);
      const refused=job.until==='commit'&&chip.refused!==0;
      if(done||refused||chip.clock>=job.end){
        const note=done||job.until==='clocks'?'':refused?'Configuration refused.':'No matching event within 100,000 clocks.';
        cancel();publish(note);return;
      }
    }
  } while(performance.now()<deadline);
  if(performance.now()-lastUpdate>=75)publish();
  timer=setTimeout(pump,0);
}
self.onmessage=({data:m})=>{
  try {
    serial=m.serial;cancel();
    if(m.type==='init'){validateLiveImage(m.image,m.build,m.siteCount);chip=new LiveFpga(m.image,m.policy);publish('Reset released.');}
    else if(m.type==='pause')publish('Paused.');
    else if(m.type==='fault'){chip.tick(m.domain);publish('Fault applied on the rising edge.');}
    else if(m.type==='run'){
      if(!['clocks','event','commit','play'].includes(m.until)||!Number.isInteger(m.count)||m.count<1||m.count>100000)throw Error('Invalid clock request');
      job={until:m.until,end:m.until==='play'?Infinity:chip.clock+m.count,start:chip.commits};pump();
    } else throw Error('Unknown FPGA control');
  }catch(error){cancel();postMessage({serial,error:error.message});}
};
