// Regrow FPGA profile: one tape/primary per CRC logic cluster, one physically
// interchangeable spare between adjacent primaries. Common clock, finite
// config RAM, registered links. Fault pins model fail-silent domains.

module tape_reader #(parameter LAST = 0) (
    input clk, rst, dead, marker, need, input [31:0] rom_data,
    output reg [6:0] addr, output read_marker, output [40:0] stream);
  reg armed;
  assign read_marker = armed && !dead;
  wire send_word = read_marker && need;
  assign stream = {send_word, addr == LAST, addr, rom_data};
  always @(posedge clk) begin
    if (rst || dead) begin armed <= 0; addr <= 0; end
    else begin
      if (marker) armed <= 1;
      if (send_word && addr != LAST) addr <= addr + 1'b1; else addr <= 0;
    end
  end
endmodule

// One RAM read / one LUT3 evaluation per clock. Selectors address constant 0,
// the local socket bits, or a prior result in the site's shift register.
// The last eight LUTs collect the output byte, most significant bit first.
module lut_site #(parameter INPUTS = 8, HISTORY = 8) (
    input clk, rst, dead, input [40:0] stream,
    input req, color, input [INPUTS-1:0] pins,
    output reg loaded, output done, output reg [7:0] value);
  // A word being written is never executed: loaded is asserted only after
  // the last write. No hardware read-during-write bypass is needed.
  (* no_rw_check *) reg [31:0] image [0:127];
  reg copying;
  reg [6:0] last, pc, issued;
  wire [6:0] wr = stream[38:32];
  wire write_word = !rst && !dead && !loaded && stream[40] && (copying || wr == 0);
  reg [31:0] op;
  always @(posedge clk) begin
    if (write_word) image[wr] <= stream[31:0];
    op <= image[pc]; issued <= pc;
  end
  always @(posedge clk) begin
    if (rst || dead) begin copying <= 0; loaded <= 0; end
    else if (write_word) begin
      copying <= !stream[39];
      if (stream[39]) begin last <= wr; loaded <= 1; end
    end
  end

  reg [INPUTS-1:0] args;
  reg [HISTORY-1:0] history;
  wire [HISTORY+INPUTS:0] bits = {history, args, 1'b0};
  wire [2:0] index = {bits[op[23:16]], bits[op[15:8]], bits[op[7:0]]};
  wire [7:0] lut = op[31:24];
  wire bit_out = lut[index];
  reg job_color, valid;
  localparam IDLE = 0, PRIME = 1, RUN = 2;
  reg [1:0] state;
  assign done = !dead && loaded && valid && req && job_color == color;
  always @(posedge clk) begin
    if (rst || dead || !loaded || !req) begin state <= IDLE; pc <= 0; valid <= 0; end
    else case (state)
      IDLE: if (!done) begin
        args <= pins; job_color <= color; valid <= 0; pc <= 0; state <= PRIME;
      end
      PRIME: begin pc <= 1; state <= RUN; end
      RUN: begin
        history <= {history[HISTORY-2:0], bit_out};
        if (color != job_color) begin state <= IDLE; pc <= 0; end
        else if (issued == last) begin
          value <= {history[6:0], bit_out}; valid <= 1; pc <= 0; state <= IDLE;
        end else pc <= pc + 1'b1;
      end
    endcase
  end
endmodule

module spare_bay #(parameter INPUTS = 8, HISTORY = 8) (
    input clk, rst, input [1:0] policy, input dead_a, dead_b, dead_s, tape_a_dead, tape_b_dead,
    input [40:0] tape_a, tape_b, input req_a, req_b, color_a, color_b,
    input [INPUTS-1:0] pins_a, pins_b,
    output need_a, need_b, done_a, done_b, output [7:0] value_a, value_b,
    output spare_a, spare_b);
  // 0 = on demand; 1/2 = permanently dedicate the spare to A/B at boot.
  // A wins a simultaneous request. A dead tape cannot issue a new claim.
  reg [1:0] owner;
  always @(posedge clk) begin
    if (rst || dead_s) owner <= 0;
    else if (owner == 0) begin
      if (!tape_a_dead && (policy == 1 || (policy == 0 && dead_a))) owner <= 1;
      else if (!tape_b_dead && (policy == 2 || (policy == 0 && dead_b))) owner <= 2;
    end
  end
  wire la, lb, ls, ok_a, ok_b, ok_s;
  wire [7:0] va, vb, vs;
  assign need_a = (!dead_a && !la) || (!dead_s && owner == 1 && !ls);
  assign need_b = (!dead_b && !lb) || (!dead_s && owner == 2 && !ls);
  lut_site #(INPUTS,HISTORY) a(clk,rst,dead_a,tape_a,req_a,color_a,pins_a,la,ok_a,va);
  lut_site #(INPUTS,HISTORY) b(clk,rst,dead_b,tape_b,req_b,color_b,pins_b,lb,ok_b,vb);
  lut_site #(INPUTS,HISTORY) spare(clk,rst,dead_s,
      owner == 1 ? tape_a : owner == 2 ? tape_b : 41'd0,
      owner == 1 ? req_a : owner == 2 && req_b,
      owner == 1 ? color_a : color_b, owner == 1 ? pins_a : pins_b,ls,ok_s,vs);
  assign spare_a = owner == 1 && ls && !dead_s;
  assign spare_b = owner == 2 && ls && !dead_s;
  assign done_a = ok_a || (spare_a && ok_s);
  assign done_b = ok_b || (spare_b && ok_s);
  assign value_a = ok_a ? va : vs;
  assign value_b = ok_b ? vb : vs;
endmodule

// The vulnerable inter-bay link has a one-register direct path and a longer
// two-register path. The healthy receiver selects a responding contact.
module bypass_link #(parameter WIDTH = 16) (
    input clk, rst, cut_direct, cut_detour, input [WIDTH-1:0] packet,
    output [WIDTH-1:0] received);
  reg [WIDTH-1:0] direct, relay, detour;
  always @(posedge clk) begin
    direct <= rst || cut_direct ? 0 : packet;
    relay <= rst || cut_detour ? 0 : packet;
    detour <= rst || cut_detour ? 0 : relay;
  end
  assign received = !cut_direct ? direct : !cut_detour ? detour : 0;
endmodule
