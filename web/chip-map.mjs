import { unpackSite } from './chip-model.mjs?v=2';

const colors={primary:'#65caba',spare:'#ae99e8',tape:'#eab86a',reader:'#e99964',sha:'#e6aa62',staging:'#cd8969',syndrome:'#d69d68',parity:'#f1c27c',bank:'#b49ee6',pins:'#91bddc',crossing:'#7baad4',shared:'#506476',global:'#849aad'};
const family=g=>g.split(':')[0];

// Geometry always comes from the selected backend. The schematic has its own
// layout; the HX8K layer uses only nextpnr BELs and routed PIP coordinates.
export class ChipMap {
  constructor(canvas,pick) {
    this.canvas=canvas; this.ctx=canvas.getContext('2d'); this.pick=pick; this.zoom=1; this.dx=this.dy=0; this.hits=[];
    const point=e=>{const r=canvas.getBoundingClientRect(); return [e.clientX-r.left,e.clientY-r.top];};
    canvas.addEventListener('pointerdown',e=>{const [x,y]=point(e); this.drag={x,y,dx:this.dx,dy:this.dy,moved:false};canvas.setPointerCapture(e.pointerId);});
    canvas.addEventListener('pointermove',e=>{if(!this.drag)return;const [x,y]=point(e),a=this.drag;
      if(Math.hypot(x-a.x,y-a.y)>4)a.moved=true;
      if(a.moved){this.dx=a.dx+x-a.x;this.dy=a.dy+y-a.y;this.draw();}});
    canvas.addEventListener('pointerup',e=>{if(!this.drag)return;const moved=this.drag.moved;this.drag=null;if(!moved)this.hit(...point(e));});
    canvas.addEventListener('pointercancel',()=>{this.drag=null;});
    canvas.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();this.scale(e.deltaY<0?1.35:1/1.35,...point(e));},{passive:false});
    canvas.addEventListener('keydown',e=>{const dirs={ArrowLeft:[32,0],ArrowRight:[-32,0],ArrowUp:[0,32],ArrowDown:[0,-32]};
      if(dirs[e.key]){e.preventDefault();this.dx+=dirs[e.key][0];this.dy+=dirs[e.key][1];this.draw();}
      else if(['+','=','-','Home'].includes(e.key)){e.preventDefault();if(e.key==='Home')this.fit();else this.scale(e.key==='-'?.75:1.33);}});
    new ResizeObserver(()=>this.draw()).observe(canvas);
  }
  set(scene) { if(this.scene?.layer!==scene.layer){this.zoom=1;this.dx=this.dy=0;} this.scene=scene;this.draw(); }
  fit() { this.zoom=1;this.dx=this.dy=0;this.draw(); }
  scale(n,x=this.w/2,y=this.h/2) {
    const z=Math.max(1,Math.min(12,this.zoom*n)),r=z/this.zoom;
    this.dx=(this.dx+this.w/2-x)*r+x-this.w/2;this.dy=(this.dy+this.h/2-y)*r+y-this.h/2;this.zoom=z;this.draw();
  }
  focus(site) {
    if(this.zoom>1&&this.scene?.layer==='placed'){const f=this.scene.fabric;
      this.dx=(f.width/2-site.x-.5)*this.unit;this.dy=(site.y+.5-f.height/2)*this.unit;}
    this.draw();
  }
  world(w,h) {
    this.unit=Math.min((this.w-16)/w,(this.h-16)/h)*this.zoom;
    this.ox=(this.w-w*this.unit)/2+this.dx;this.oy=(this.h-h*this.unit)/2+this.dy;
    this.ctx.translate(this.ox,this.oy);this.ctx.scale(this.unit,this.unit);
  }
  hit(x,y) {
    x=(x-this.ox)/this.unit;y=(y-this.oy)/this.unit;
    for(const box of this.hits) if(x>=box.x&&y>=box.y&&x<=box.x+box.w&&y<=box.y+box.h){this.pick(box.item);return;}
  }
  draw() {
    const c=this.canvas,ctx=this.ctx=this.ctx??c.getContext('2d');const w=this.w=c.clientWidth,h=this.h=c.clientHeight;
    if(!w||!h)return;const dpr=Math.min(devicePixelRatio||1,2);
    if(c.width!==Math.round(w*dpr)||c.height!==Math.round(h*dpr)){c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#0b1520';ctx.fillRect(0,0,w,h);this.hits=[];
    const s=this.scene;if(!s?.fabric)return;
    if(s.layer==='placed') this.placed(s);
    else this.logic(s);
  }
  placed(s) {
    const {ctx}=this,f=s.fabric;this.world(f.width,f.height);
    if(this.cached!==f){this.cached=f;this.sites=f.sites.map(code=>({...unpackSite(code),code}));}
    const u=this.unit,focus=new Set([s.group]);
    if(s.role>=0){focus.add(`primary:${s.role}`);focus.add(`spare:${s.role>>1}`);focus.add(`tape:${s.role}`);}
    ctx.lineWidth=.7/u;ctx.strokeStyle='#263541';ctx.beginPath();
    for(let i=0;i<=f.width;i++){ctx.moveTo(i,0);ctx.lineTo(i,f.height);}
    for(let i=0;i<=f.height;i++){ctx.moveTo(0,i);ctx.lineTo(f.width,i);}ctx.stroke();
    for(let i=0;i<this.sites.length;i++){const site=this.sites[i],{x,y,bel,group,code}=site,g=f.groups[group],fam=family(g),idx=Number(g.split(':')[1]);
      const col=bel<8?bel%4:0,row=bel<8?bel>>2:bel===10?1:0;
      const xx=x+(bel<8?.07+col*.22:.1),yy=f.height-1-y+.08+row*.43,ww=bel<8?.19:.78,hh=bel===8?.83:.38;
      const lost=(fam==='primary'&&s.state.dead.has(idx))||(fam==='spare'&&s.state.dead.has(8+idx));
      const live=fam==='spare'&&(s.state.spare&(3<<(2*idx)));
      ctx.fillStyle=lost?'#d46469':live?'#c5ffe7':focus.has(g)?(colors[fam]??'#a5b6bf'):(bel===8?'#817260':'#354b5c');
      ctx.fillRect(xx,yy,ww,hh);
      if(s.levels&&s.probes[i]&&s.levels[s.probes[i]>>>3]){ctx.fillStyle='#e2fff3';ctx.fillRect(xx+ww*.25,yy+hh*.25,ww*.5,hh*.5);}
      if(code===s.site){ctx.strokeStyle='#fff';ctx.lineWidth=2/u;ctx.strokeRect(xx-.06,yy-.05,ww+.12,hh+.1);}
      this.hits.push({x:xx-.015,y:yy-.02,w:ww+.03,h:hh+.04,item:{group:g,code}});
    }
    if(s.routes) for(const g of focus){const segments=f.routes[g]??[];ctx.strokeStyle='rgba(132,233,211,.65)';ctx.lineWidth=1.5/u;ctx.beginPath();
      for(const n of segments){ctx.moveTo((n&63)+.5,f.height-.5-((n>>>6)&63));ctx.lineTo(((n>>>12)&63)+.5,f.height-.5-((n>>>18)&63));}ctx.stroke();}
  }
  logic(s) {
    const {ctx}=this,nodes=[],known=new Map();
    const bank={label:'PC / ACC',note:'register bank',group:'bank',depth:0,from:[]};
    nodes.push(bank);known.set('pc',bank);known.set('acc',bank);
    s.roles.forEach((r,i)=>{const from=[...new Set(r.inputs.map(n=>known.get(n)).filter(Boolean))];
      const n={label:r.name,note:`${r.gates.length} LUTs`,group:`primary:${i}`,from,depth:1+Math.max(0,...from.map(n=>n.depth))};nodes.push(n);known.set(r.name,n);});
    bank.from=nodes.slice(-2);
    const levels=[];for(const n of nodes)(levels[n.depth]??=[]).push(n);
    const W=levels.length*3.2,H=Math.max(3,...levels.filter(Boolean).map(l=>l.length*1.3+1));this.world(W,H);
    for(const level of levels) level?.forEach((n,i)=>{n.x=.22+n.depth*3.2;n.y=H*(i+.5)/level.length-.43;});
    for(const n of nodes)for(const parent of n.from){const selected=n.group===s.group||parent.group===s.group;
      ctx.strokeStyle=selected?'#a4ecd9':'#456676';ctx.lineWidth=(selected?2:1)/this.unit;ctx.beginPath();
      const x=parent.x+2.5,y=parent.y+.43;ctx.moveTo(x,y);
      if(n.depth<=parent.depth){ctx.bezierCurveTo(x+.6,H+.1,n.x-.6,H+.1,n.x,n.y+.43);}else ctx.bezierCurveTo(x+.5,y,n.x-.5,n.y+.43,n.x,n.y+.43);ctx.stroke();}
    for(const n of nodes){const sel=n.group===s.group||(s.role>=0&&n.group===`primary:${s.role}`);
      ctx.fillStyle=sel?'#214c49':'#172a37';ctx.fillRect(n.x,n.y,2.5,.86);ctx.strokeStyle=sel?'#84e9d3':'#4e6979';ctx.lineWidth=1/this.unit;ctx.strokeRect(n.x,n.y,2.5,.86);
      ctx.fillStyle='#eef9f8';ctx.font='600 .31px system-ui';ctx.fillText(n.label,n.x+.12,n.y+.37,2.26);ctx.fillStyle='#b4ccda';ctx.font='.23px system-ui';ctx.fillText(n.note,n.x+.12,n.y+.68,2.26);
      this.hits.push({x:n.x,y:n.y,w:2.5,h:.86,item:{group:n.group}});}
  }
}
