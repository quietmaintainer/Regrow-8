import { createHash } from 'node:crypto';
import { packProfile } from './packing.mjs';

export function fpgaProfile(recipe) {
  return { ...packProfile(recipe), recipeSha256: createHash('sha256').update(recipe.replaceAll('\r\n', '\n')).digest('hex') };
}

// Generate ROM contents and STATIC connectivity only. All configuration writes,
// spare claims, routing, instruction evaluation and capture happen in the DUT.
export function topVerilog({ pairs, logic, registerInputLanes, laneNames, recipeSha256 }, protectedTapes = false) {
  const W = 8 * laneNames.length, P = W + 2, v = [];
  v.push(`// Generated from CRC recipe SHA-256 ${recipeSha256}`,
    'module regrow_fpga(input clk, rst, input [1:0] policy, input hit, input [4:0] fault_addr,',
    ' output reg [7:0] pc, acc, output reg retire, output [7:0] spare_loaded' + (protectedTapes ?
      ', output [7:0] rebuilt, refused, output [8:0] hash_bad, output [2:0] cfg_role, output [40:0] cfg_stream);' : ');'),
    `reg [${protectedTapes ? 31 : 21}:0] dead; integer f; always @(posedge clk) for (f=0; f<${protectedTapes ? 32 : 22}; f=f+1)`,
    ' if (rst) dead[f] <= 0; else if (hit && fault_addr == f) dead[f] <= 1;',
    'reg color; wire marker_start = 1;',
    `wire [${W-1}:0] data0 = {${W-16}'d0, acc, pc}; wire valid0 = !rst, color0 = color;`);
  if (protectedTapes) v.push('wire [3:0] source; wire [6:0] pos; wire [31:0] parity_q;',
    'grfp_parity parity_rom(clk,pos,parity_q);');
  for (let i = 0; i < logic.length; i++) {
    const idx = i + 1, { lane } = logic[i], pair = pairs[i >> 1], ops = pair.images[i % 2], base = lane * 8;
    v.push(`// ${laneNames[lane]}`,
      `wire [6:0] addr${i}; wire need${i}, mark${i}, done${i}; wire [40:0] stream${i}; wire [31:0] rom${i};`);
    // Read-only tape in distributed LUT ROM; the writable copies live in block RAM.
    for (let b = 0; b < 32; b++) {
      const plane = ops.reduce((v, op, a) => v | (BigInt((op >>> b) & 1) << BigInt(a)), 0n);
      v.push(`localparam [127:0] plane${i}_${b} = 128'h${plane.toString(16)}; assign rom${i}[${b}] = plane${i}_${b}[addr${i}];`);
    }
    v.push(protectedTapes ? `assign addr${i}=pos; assign stream${i}=cfg_role==${i} ? cfg_stream : 41'd0;` :
      `tape_reader #(${ops.length-1}) tape${i}(clk,rst,dead[${12+i}],${i ? `mark${i-1}` : 'marker_start'},need${i},rom${i},addr${i},mark${i},stream${i});`,
      `wire [${pair.pins.length-1}:0] pins${i} = {${pair.pins.toReversed().map(b => `data${i}[${b}]`).join(',')}};`,
      `wire [7:0] result${i}; wire [${W-1}:0] out${i} = {${[base+8 < W && `data${i}[${W-1}:${base+8}]`, `result${i}`, base > 0 && `data${i}[${base-1}:0]`].filter(Boolean).join(',')}};`,
      `wire [${P-1}:0] packet${i} = {done${i},color${i},out${i}};`);
    if (i === 3) v.push(`wire [${P-1}:0] link${i}; bypass_link #(${P}) crossing(clk,rst,dead[20],dead[21],packet${i},link${i});`);
    else v.push(`reg [${P-1}:0] link${i}; always @(posedge clk) link${i} <= rst ? 0 : packet${i};`);
    v.push(`wire valid${idx} = link${i}[${W+1}], color${idx} = link${i}[${W}]; wire [${W-1}:0] data${idx} = link${i}[${W-1}:0];`);
  }
  if (protectedTapes) {
    // Inject at the ROM read port, upstream of verification. Bit-flip flags
    // are deliberately NOT ports of the decoder. A lost source returns no data.
    v.push('reg present; reg [31:0] raw; always @* case (source)');
    logic.forEach((_, i) => {
      const last = pairs[i>>1].images[i%2].length-1;
      v.push(` 4'd${i}: begin present=!dead[${12+i}]; raw=present ? rom${i} ^ {dead[${22+i}] && pos==7'd${last},31'd0} : 0; end`);
    });
    v.push(" 4'd8: begin present=!dead[30]; raw=present ? parity_q ^ {31'd0,dead[31] && pos==0} : 0; end",
      ' default: begin present=0; raw=0; end endcase',
      'grfp_reader reader(clk,rst,{need7,need6,need5,need4,need3,need2,need1,need0},',
      ' source,pos,present,raw,cfg_role,cfg_stream,rebuilt,refused,hash_bad);');
  }
  pairs.forEach((p, bay) => {
    const a = bay * 2, b = a + 1;
    // In the protected profile a bay can request the independent verification
    // port even if its local tape is dead. Only that port can supply a stream.
    const noReader = i => protectedTapes ? "1'b0" : `dead[${12+i}]`;
    v.push(`spare_bay #(${p.pins.length},${p.history}) bay${bay}(clk,rst,policy,dead[${a}],dead[${b}],dead[${8+bay}],${noReader(a)},${noReader(b)},`,
      `stream${a},stream${b},valid${a},valid${b},color${a},color${b},pins${a},pins${b},need${a},need${b},done${a},done${b},result${a},result${b},spare_loaded[${a}],spare_loaded[${b}]);`);
  });
  v.push('always @(posedge clk) begin retire <= 0;', ' if (rst) begin pc<=0; acc<=0; color<=0; end',
    ` else if (valid8 && color8 == color) begin pc<=data8[${8*registerInputLanes[0]}+:8]; acc<=data8[${8*registerInputLanes[1]}+:8]; color<=!color; retire<=1; end`,
    'end', 'endmodule', '');
  return v.join('\n');
}
