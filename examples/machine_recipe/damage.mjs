// Nested masks at increasing rates; percentages refer to all programmable
// sites, before the layout is inspected. No conditioning on successful routes.
export function mask(board,shape,percent,seed) {
  if (!Number.isFinite(percent) || percent<0 || percent>100) throw Error('damage must be 0..100 percent');
  const sites=Array.from({length:board.n},(_,p)=>p).filter(p=>!board.fixed[p]);
  let rng=seed>>>0;
  const random=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng/2**32;};
  if (shape==='scatter') {
    for (let i=0;i<sites.length;i++) {
      const j=i+Math.floor(random()*(sites.length-i)); [sites[i],sites[j]]=[sites[j],sites[i]];
    }
  } else if (shape==='crater') {
    const center=()=>board.side*(.45+.1*random()), x=center(),y=center();
    const dist=p=>(p%board.side-x)**2+(Math.floor(p/board.side)-y)**2;
    sites.sort((a,b)=>dist(a)-dist(b)||a-b);
  } else throw Error('unknown mask shape');
  return sites.slice(0,Math.round(percent*sites.length/100));
}
