import { createHash } from 'node:crypto';
import { encode16 } from '../file_recipe/rs16.mjs';

// Hardware profile of the GRFP global16 code: eight systematic coordinates,
// row zero of the Cauchy matrix, little-endian field symbols, zero extension.
// Protect the deployable microcode, including the final byte-collection LUTs.
export function tapeProtection(profile) {
  const shards = profile.pairs.flatMap(p => p.images.map(words => {
    const bytes = Buffer.alloc(4 * words.length);
    words.forEach((w, i) => bytes.writeUInt32LE(w, 4 * i));
    return bytes;
  }));
  const width = Math.max(...shards.map(b => b.length));
  function row(n, load) {
    let result;
    encode16(8, 1, n, load, (_, b) => { result = b; });
    return result;
  }
  const parity = row(width, i => shards[i]);
  // Encode unit vectors with the reference codec to get its exact weights.
  const coefficients = shards.map((_, i) => row(2, j => Buffer.from([Number(i === j), 0])).readUInt16LE());
  const all = [...shards, parity];
  return { parity, coefficients, lengths: all.map(b => b.length / 4),
    hashes: all.map(b => createHash('sha256').update(b).digest('hex')) };
}

// The hash engine embeds the independent reference digests in the read-only
// part of its schedule RAM. Parity has its own synchronous ROM read port.
export function protectionRoms({ parity, coefficients, lengths, hashes }) {
  const v = ['module grfp_catalog(input [3:0] id, output reg [6:0] last, output reg [15:0] coefficient);', 'always @* case (id)',
    ...lengths.map((n, i) => ` 4'd${i}: begin last=7'd${n-1}; coefficient=16'h${(coefficients[i] ?? 0).toString(16)}; end`),
    ' default: begin last=0; coefficient=0; end endcase'];
  v.push('endmodule', 'module grfp_hash(input clk,rst,start,input [3:0] id,input [6:0] last,output [6:0] addr,input [31:0] data,output done,ok);',
    `tape_sha256 #(2304'h${hashes.join('')}) check_image(clk,rst,start,id,last,addr,data,done,ok); endmodule`,
    'module grfp_parity(input clk, input [6:0] addr, output reg [31:0] q);',
    '(* rom_style="block" *) reg [31:0] mem [0:127]; initial begin');
  for (let i = 0; i < 128; i++) {
    const w = 4*i < parity.length ? parity.readUInt32LE(4*i) : 0;
    v.push(` mem[${i}]=32'h${w.toString(16).padStart(8,'0')};`);
  }
  v.push('end always @(posedge clk) q<=mem[addr]; endmodule');
  return v.join('\n');
}
