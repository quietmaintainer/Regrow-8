export function gradeProtection(logs, profile, meta) {
  const names = profile.logic.map(({ lane }) => profile.laneNames[lane]);
  const labels = ['clean', ...names.map(n=>`lost tape then primary: ${n}`), ...names.map(n=>`bit flip then primary: ${n}`),
    'lost adder tape at boot','corrupt adder tape at boot','two missing tapes','missing tape and corrupt survivor',
    'missing tape and missing parity','missing tape and corrupt parity','missing parity with good adder tape',
    'two corrupt tapes','two lost tapes with healthy workers'];
  const baseWords = meta.lengths.slice(0,8).reduce((a,b)=>a+b,0), rows = [];
  for (const line of logs.join('\n').split(/\r?\n/).filter(s=>s.startsWith('GRFP '))) {
    const [id,boot,commits,latency,load,rebuilt,refused,bad,spares,words] = line.split(' ').slice(1).map(Number);
    const single=id>=1 && id<=16, slot=(id-1)%8, bit=1<<slot;
    const reject=[19,20,21,22,24].includes(id);
    const expectRebuilt=single ? bit : [17,18].includes(id) ? 4 : 0;
    const expectBad=id>=9 && id<=16 ? bit : ({18:4,20:8,22:256,24:12}[id] ?? 0);
    if (!labels[id] || rows[id] || commits!==(reject?0:7) || rebuilt!==expectRebuilt || refused!==(reject?4:0)
      || bad!==expectBad || spares!==(single ? bit : id===23 ? 4 : 0)
      || words!==baseWords+(single ? meta.lengths[slot] : id===23 ? meta.lengths[2] : 0)
      || ((single || id===23) && load<=0)) throw Error(`unexpected protected trial: ${line}`);
    rows[id]={ fault:labels[id], firstCommit:boot, matchingCommits:commits, nextCommitAfterInjection:latency<0?null:latency,
      spareLoadedAfterInjection:load<0?null:load, rebuiltMask:rebuilt, refusedMask:refused, badDigestMask:bad,
      loadedSpareMask:spares, checkedWordsPublished:words };
  }
  if (rows.filter(Boolean).length!==labels.length) throw Error('incomplete GRFP trial panel');
  return rows;
}

export function protectionCsv(rows) {
  return [Object.keys(rows[0]).join(','), ...rows.map(r=>Object.values(r).join(','))].join('\n')+'\n';
}
