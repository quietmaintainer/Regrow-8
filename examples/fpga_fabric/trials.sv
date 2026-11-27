`timescale 1ns/1ps
module trials;
  reg clk=0, rst=0, hit=0; reg [4:0] fault_addr=0; reg [1:0] policy=0;
  wire [7:0] pc, acc, spare_loaded; wire retire;
  regrow_fpga dut(.clk(clk),.rst(rst),.hit(hit),.fault_addr(fault_addr),.policy(policy),
      .pc(pc),.acc(acc),.retire(retire),.spare_loaded(spare_loaded));
  integer cycles, policy_arg, only_case, j, match_slot, claim_latency, cut_at;
  task step;
    reg [15:0] before_q;
    begin
      before_q = {pc,acc}; #5; clk=1; #5; clk=0; #1; cycles=cycles+1;
      if (!rst && ((^({pc,acc,retire}) === 1'bx) || (!retire && before_q !== {pc,acc})))
        $fatal(1,"unknown or uncommitted register value at clock %0d",cycles);
      if (match_slot >= 0 && claim_latency < 0 && spare_loaded[match_slot]) claim_latency=cycles-cut_at;
    end
  endtask
  task inject(input integer domain);
    begin hit=domain>=0; fault_addr=domain; step(); hit=0; end
  endtask
  // Independent shipped-ROM oracle, used only by the testbench. First
  // capture before injection is LDI FE. Check every following commit.
  function [15:0] expected(input integer i);
    case(i)
      0: expected=16'h0200; 1: expected=16'h8000; 2: expected=16'h81a5;
      3: expected=16'h82a5; 4: expected=16'h8300; 5: expected=16'h0000;
      6: expected=16'h01fe;
    endcase
  endfunction
  task trial(input integer id);
    integer first, second, boot, prefix, latency, since, stop, t;
    begin
      cycles=0; match_slot=-1; claim_latency=-1; rst=1; hit=0; step(); step(); rst=0;
      if (spare_loaded !== 0) $fatal(1,"reset must leave sites unconfigured");
      if (id == 18) inject(14); // Destroy the unread sum tape at boot.
      since=cycles; step(); while (!retire && cycles-since<1200) step();
      boot=cycles-2; prefix=0; latency=-1;
      if (id == 18) begin
        if (retire || {pc,acc} !== 0) $fatal(1,"retired without the CRC tape");
      end else begin
        if (!retire || {pc,acc} !== 16'h01fe) $fatal(1,"bad first commit: %h/%h after %0d clocks",pc,acc,boot);
        for(t=0;t<170;t=t+1) begin step(); if (retire) $fatal(1,"injection window missed"); end
        first=-1; second=-1;
        if (id>=1 && id<=8) begin first=id-1; match_slot=first; end
        case(id)
          9: begin first=2; second=5; end       // One primary in each of two different bays
          10: begin first=2; second=3; end      // Both primaries in one bay
          11: begin first=14; second=2; end     // Kill the tape BEFORE the primary
          12: begin first=9; second=2; end      // Kill the spare BEFORE the primary
          13: first=14;                        // Running copy survives loss of tape
          14: first=20;                        // Direct link: use the longer path
          15: begin first=20; second=21; end    // Sever both paths
          16: first=9; 17: first=21;
        endcase
        cut_at=cycles;
        if (match_slot>=0 && spare_loaded[match_slot]) claim_latency=0;
        inject(first); if (retire) $fatal(1,"unexpected commit during injection");
        inject(second); if (retire) $fatal(1,"unexpected commit during injection");
        stop=0;
        while(prefix<7 && !stop) begin
          since=cycles; step(); while (!retire && cycles-since<1200) step();
          if (!retire) stop=1;
          else begin
            if ({pc,acc} !== expected(prefix)) $fatal(1,"policy %0d case %0d commit %0d: %h%h != %h",policy,id,prefix,pc,acc,expected(prefix));
            if (!prefix) latency=cycles-cut_at;
            prefix=prefix+1;
          end
        end
      end
      $display("TRIAL %0d %0d %0d %0d %0d %0d %0d %0d",policy,id,boot,prefix,latency,claim_latency,spare_loaded,cycles);
    end
  endtask
  initial begin
    if (!$value$plusargs("POLICY=%d",policy_arg)) policy_arg=0;
    policy=policy_arg;
    if ($value$plusargs("CASE=%d",only_case)) trial(only_case);
    else for (j=0;j<19;j=j+1) trial(j);
    $finish;
  end
endmodule
