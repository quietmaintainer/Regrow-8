// Compact, diffable view of the measured panel. Empty latency = no capture
// before the watchdog. The full JSON also retains boot, claim and mask data.
export function panelCsv({ policies }) {
  const names = ['regrow','fixed-A','fixed-B'];
  const rows = [['fault', ...names.flatMap(n => [`${n} commits`, `${n} next clocks`])]];
  for (const [i, { fault }] of policies.regrow.entries()) {
    rows.push([fault, ...names.flatMap(n => {
      const t = policies[n][i];
      if (t.fault !== fault) throw Error('unmatched fault panel');
      return [t.matchingCommits, t.nextCommitAfterInjection];
    })]);
  }
  return rows.map(row => row.join(',')).join('\n') + '\n';
}
