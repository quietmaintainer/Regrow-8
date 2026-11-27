// One-erasure global16 recovery port. ROM, staging RAM and syndrome RAM are
// distinct. No configuration word is published until the staging RAM itself
// has passed the trusted digest for the requested tape.
module grfp_reader(input clk, rst, input [7:0] need,
    output reg [3:0] source, output reg [6:0] pos, input present, input [31:0] raw,
    output reg [2:0] target, output [40:0] stream,
    output reg [7:0] rebuilt, refused, output reg [8:0] hash_bad);
  localparam IDLE=0, SETUP=1, FETCH=2, COPY=3, HASH=4, CHECK=5, BAD=6,
      PAR_RD=7, PAR_STORE=8, NEXT=9, MUL_RD=10, MUL_INIT=11, MUL=12, STORE=13, SEND_RD=14, SEND=15;
  localparam DIRECT=0, PARITY=1, SURVIVOR=2, SOLVE=3;
  reg [3:0] state;
  reg [1:0] part;
  reg [6:0] target_last;
  wire [6:0] last, sha_addr; wire [15:0] coefficient;
  grfp_catalog catalog(source,last,coefficient);

  (* ram_style="block", no_rw_check *) reg [31:0] stage [0:127], syndrome [0:127];
  reg [31:0] staged, residual, product, addend;
  reg [15:0] factor;
  wire hashing = state==HASH || state==CHECK;
  always @(posedge clk) begin
    staged <= stage[hashing ? sha_addr : pos]; residual <= syndrome[pos];
    if ((state==COPY && present) || (state==STORE && part==SOLVE))
      stage[pos] <= state==COPY ? raw : product;
    if (state==PAR_STORE || (state==STORE && part==SURVIVOR))
      syndrome[pos] <= state==PAR_STORE ? staged : product;
  end
  wire checked, digest_ok;
  grfp_hash sha(clk,rst,state==HASH,source,last,sha_addr,staged,checked,digest_ok);
  assign stream = {state==SEND,pos==target_last,pos,staged};

  function [15:0] xtime(input [15:0] a);
    xtime = {a[14:0],1'b0} ^ (a[15] ? 16'h100b : 16'h0); // x^16+x^12+x^3+x+1
  endfunction
  wire [7:0] pending = need & ~refused;
  reg [2:0] pick; integer i;
  always @* begin pick=0; for (i=7;i>=0;i=i-1) if (pending[i]) pick=i; end

  always @(posedge clk) begin
    if (rst) begin state<=IDLE; source<=0; target<=0; pos<=0; rebuilt<=0; refused<=0; hash_bad<=0; end
    else case (state)
      IDLE: if (|pending) begin target<=pick; source<={1'b0,pick}; part<=DIRECT; state<=SETUP; end
      SETUP: begin
        if (part==DIRECT) target_last<=last;
        pos<=0; state<=present ? FETCH : BAD;
      end
      FETCH: state<=COPY; // Allow one clock for a synchronous source ROM.
      COPY: if (!present) state<=BAD;
        else if (pos==last) state<=HASH;
        else begin pos<=pos+1'b1; state<=FETCH; end
      HASH: state<=CHECK;
      CHECK: if (checked) begin
        pos<=0;
        if (!digest_ok) begin hash_bad[source]<=1; state<=BAD; end
        else case (part)
          DIRECT: state<=SEND_RD;
          PARITY: state<=PAR_RD;
          SURVIVOR: state<=MUL_RD;
          SOLVE: begin rebuilt[target]<=1; state<=SEND_RD; end
        endcase
      end
      BAD: if (part==DIRECT) begin source<=8; part<=PARITY; state<=SETUP; end
        else begin refused[target]<=1; state<=IDLE; end
      // P = sum_i c_i * D_i. Seed the residual with the verified parity.
      PAR_RD: state<=PAR_STORE;
      PAR_STORE: if (pos==target_last) begin source<=0; part<=SURVIVOR; state<=NEXT; end
        else begin pos<=pos+1'b1; state<=PAR_RD; end
      NEXT: if (source==8) begin source<={1'b0,target}; part<=SOLVE; pos<=0; state<=MUL_RD; end
        else if (source=={1'b0,target}) source<=source+1'b1;
        else state<=SETUP;
      MUL_RD: state<=MUL_INIT;
      MUL_INIT: begin
        // Fold each verified survivor into P; finally divide by c_target.
        // For parity row zero c_i = inverse(8 XOR i).
        product<=part==SOLVE ? 0 : residual; addend<=part==SOLVE ? residual : staged;
        factor<=part==SOLVE ? {12'd0,1'b1,target} : coefficient; state<=MUL;
      end
      MUL: begin
        if (factor[0]) product<=product^addend;
        addend<={xtime(addend[31:16]),xtime(addend[15:0])}; factor<=factor>>1;
        if (factor<=1) state<=STORE;
      end
      STORE: if (pos==target_last || pos==last) begin
        if (part==SOLVE) state<=HASH; // Re-read and authenticate the reconstructed bytes.
        else begin source<=source+1'b1; state<=NEXT; end
      end else begin pos<=pos+1'b1; state<=MUL_RD; end
      SEND_RD: state<=SEND;
      SEND: if (pos==target_last) state<=IDLE; else begin pos<=pos+1'b1; state<=SEND_RD; end
      default: state<=IDLE;
    endcase
  end
endmodule
