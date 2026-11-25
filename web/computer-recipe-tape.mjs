import { Fabric, image, TRACKS } from '../examples/machine_recipe/fabric.mjs';

const ROW = 0, END = -1;
const tapeWindow = 24;

function encodeRows(board, { config, distance }) {
  const old = board.config, symbols = [];
  for (let row = 0; row < board.side; row++) {
    let skipped = 0;
    for (let column = 0; column < board.side; column++) {
      const site = row * board.side + column;
      const socket = 3 * site, wire = TRACKS * site;
      const changed = distance[site] >= 0 && (config.kind[site] !== old.kind[site] || config.tag[site] !== old.tag[site]
        || config.socket.subarray(socket, socket + 3).some((value, i) => value !== old.socket[socket + i])
        || config.wire.subarray(wire, wire + TRACKS).some((value, i) => value !== old.wire[wire + i]));
      if (!changed) {
        skipped++;
        continue;
      }
      if (skipped) symbols.push(skipped);
      skipped = 0;
      symbols.push({ kind: config.kind[site], tag: config.tag[site],
        socket: config.socket.slice(socket, socket + 3), wire: config.wire.slice(wire, wire + TRACKS) });
    }
    if (skipped) symbols.push(skipped);
    symbols.push(ROW);
  }
  symbols.push(END);
  return symbols;
}

export class RecipeRowTape {
  constructor(board, plan) {
    this.symbols = encodeRows(board, plan);
    // Build on an unclocked copy. A second cut can discard an unfinished
    // reconfiguration without feeding mixed old and new routes to the planner.
    this.board = new Fabric(board.side, [...board.inputs.keys()], [...board.outputs.keys()], { padWidth: board.padWidth });
    for (const [field, values] of Object.entries(board.config)) this.board.config[field].set(values);
    this.board.dead.set(board.dead);
    this.board.q.set(board.q);
    this.decoded = image(board.n);
    this.cursor = this.rows = 0;
    this.written = [];
    this.writes = { fieldWrites: 0, sitesWritten: 0 };
  }

  advance() {
    if (this.symbols[this.cursor] === END) {
      this.cursor++;
      return true;
    }
    const { board, decoded } = this;
    let site = this.rows * board.side;
    const sites = [];
    for (let word = this.symbols[this.cursor++]; word !== ROW; word = this.symbols[this.cursor++]) {
      if (typeof word === 'number') {
        site += word;
        continue;
      }
      decoded.kind[site] = word.kind;
      decoded.tag[site] = word.tag;
      decoded.socket.set(word.socket, 3 * site);
      decoded.wire.set(word.wire, TRACKS * site);
      sites.push(site++);
    }
    const { fieldWrites, sitesWritten } = board.install(decoded, sites);
    this.writes.fieldWrites += fieldWrites;
    this.writes.sitesWritten += sitesWritten;
    this.written = sites;
    this.rows++;
    return false;
  }

  view() {
    const upcoming = this.symbols.slice(this.cursor, this.cursor + tapeWindow).map(word =>
      word === ROW ? 'row' : word === END ? 'end' : typeof word === 'number' ? 'skip' : 'write');
    return { rows: this.rows, total: this.board.side, upcoming };
  }
}
