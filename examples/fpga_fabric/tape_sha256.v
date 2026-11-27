// SHA-256 of 1..128 little-endian configuration words, read back from the
// staging RAM. One shared schedule RAM, one compression round at a time.
module tape_sha256 #(parameter [2303:0] HASHES=0) (input clk, rst, start, input [3:0] id,
    input [6:0] last, output [6:0] addr, input [31:0] data, output reg done, match);
  localparam [255:0] IV = 256'h6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19;
  localparam [2047:0] K = {
    256'h428a2f9871374491b5c0fbcfe9b5dba53956c25b59f111f1923f82a4ab1c5ed5,
    256'hd807aa9812835b01243185be550c7dc372be5d7480deb1fe9bdc06a7c19bf174,
    256'he49b69c1efbe47860fc19dc6240ca1cc2de92c6f4a7484aa5cb0a9dc76f988da,
    256'h983e5152a831c66db00327c8bf597fc7c6e00bf3d5a7914706ca635114292967,
    256'h27b70a852e1b21384d2c6dfc53380d13650a7354766a0abb81c2c92e92722c85,
    256'ha2bfe8a1a81a664bc24b8b70c76c51a3d192e819d6990624f40e3585106aa070,
    256'h19a4c1161e376c082748774c34b0bcb5391c0cb34ed8aa4a5b9cca4f682e6ff3,
    256'h748f82ee78a5636f84c878148cc7020890befffaa4506cebbef9a3f7c67178f2};
  function [31:0] ror(input [31:0] x, input integer n);
    ror = (x >> n) | (x << (32-n));
  endfunction
  localparam IDLE=0, READ=1, LOAD=2, X0=3, X1=4, X2=5, X3=6, X4=7,
      R0=8, RK=9, R1=10, R2=11, R3=12, R4=13, ROUND=14, ADD_RD=15, ADD=16, COMPARE=17,
      INIT_RD=18, INIT_LOAD=19;
  reg [4:0] state;
  reg [3:0] block_no;
  reg [5:0] t;
  reg [2:0] count;
  wire [7:0] words = {1'b0,last}+8'd1;
  wire final_block = block_no == ((words+8'd2)>>4);
  wire [7:0] offset = {block_no,t[3:0]};
  assign addr = offset[6:0];
  wire [31:0] message = offset < words ? {data[7:0],data[15:8],data[23:16],data[31:24]} :
      offset == words ? 32'h80000000 : final_block && t==15 ? {19'd0,words,5'd0} : 32'd0;

  // One 256 x 32 memory: schedule 0..63, chaining state 64..71, IV
  // 72..79, expected digest words 80..151 and round constants 192..255.
  // The write addresses below cannot reach any of the constants.
  (* ram_style="block", no_rw_check *) reg [31:0] store [0:255];
  integer j;
  initial begin
    for (j=0;j<256;j=j+1) store[j]=0;
    for (j=0;j<8;j=j+1) store[72+j]=IV[255-32*j-:32];
    for (j=0;j<72;j=j+1) store[80+j]=HASHES[2303-32*j-:32];
    for (j=0;j<64;j=j+1) store[192+j]=K[2047-32*j-:32];
  end
  reg [31:0] w, partial;
  reg [7:0] ra;
  wire [2:0] digest_index=~count; // h..a correspond to H7..H0.
  always @* case (state)
    INIT_RD,ADD_RD: ra={4'b0100,block_no==0,digest_index};
    ADD: ra=8'd80+{id,digest_index};
    X0: ra=t-16; X1: ra=t-15; X2: ra=t-7; X3: ra=t-2;
    R0: ra={2'b11,t}; default: ra={2'd0,t};
  endcase
  wire [31:0] s0=ror(w,7)^ror(w,18)^(w>>3), s1=ror(w,17)^ror(w,19)^(w>>10);
  reg [255:0] work;
  wire [31:0] a,b,c,d,e,f,g,h;
  assign {a,b,c,d,e,f,g,h}=work;
  wire [31:0] big0=ror(a,2)^ror(a,13)^ror(a,22), big1=ror(e,6)^ror(e,11)^ror(e,25);
  wire [31:0] choose=g^(e&(f^g)), majority=(a&b)|(c&(a|b));
  reg [31:0] u,v;
  wire [31:0] sum_word=w+h;
  always @(posedge clk) begin
    w <= store[ra];
    if (state==LOAD || state==X4 || state==ADD)
      store[state==ADD ? {5'b01000,digest_index} : {2'd0,t}] <= state==ADD ? sum_word : state==LOAD ? message : partial+s1;
  end
  always @(posedge clk) begin
    done<=0;
    if (rst) begin state<=IDLE; match<=0; end
    else case (state)
      IDLE: if (start) begin block_no<=0; t<=0; count<=0; match<=1; state<=INIT_RD; end
      INIT_RD: state<=INIT_LOAD;
      INIT_LOAD: begin work<={w,work[255:32]}; count<=count+1'b1; state<=count==7 ? READ : INIT_RD; end
      READ: state<=LOAD;
      LOAD: begin t<=t+1'b1; state<=t==15 ? X0 : READ; end
      X0: state<=X1;
      X1: begin partial<=w; state<=X2; end
      X2: begin partial<=partial+s0; state<=X3; end
      X3: begin partial<=partial+w; state<=X4; end
      X4: begin t<=t+1'b1; state<=t==63 ? R0 : X0; end
      R0: state<=RK;
      RK: begin u<=h+w; state<=R1; end
      R1,R2,R3: begin u<=u+(state==R1 ? w : state==R2 ? big1 : choose); state<=state+1'b1; end
      R4: begin v<=big0+majority; state<=ROUND; end
      ROUND: begin
        work<={u+v,a,b,c,d+u,e,f,g}; t<=t+1'b1; count<=0; state<=t==63 ? ADD_RD : R0;
      end
      ADD_RD: state<=ADD;
      ADD: begin u<=sum_word; work<={h,work[255:32]}; state<=COMPARE; end
      COMPARE: begin
        count<=count+1'b1;
        if (final_block && u!=w) match<=0;
        if (count==7) begin
          if (final_block) begin done<=1; state<=IDLE; end
          else begin block_no<=block_no+1'b1; state<=INIT_RD; end
        end else state<=ADD_RD;
      end
      default: state<=IDLE;
    endcase
  end
endmodule
