`timescale 1ns/1ps
module trials;
  reg clk=0, rst=0, hit=0; reg [4:0] fault_addr=0;
  wire [7:0] pc,acc,spares,rebuilt,refused; wire retire; wire [8:0] hash_bad;
  wire [2:0] role; wire [40:0] stream;
  reg [1:0] policy;
  regrow_fpga dut(.clk(clk),.rst(rst),.policy(policy),.hit(hit),.fault_addr(fault_addr),
    .pc(pc),.acc(acc),.retire(retire),.spare_loaded(spares),.rebuilt(rebuilt),.refused(refused),
    .hash_bad(hash_bad),.cfg_role(role),.cfg_stream(stream));
  // Bench only. Check EVERY word and last flag on the actual worker write
  // bus, including never-exercised LUT entries, not only the instruction trace.
  reg [32:0] gold [0:1023];
  reg [15:0] commits [0:7];
  integer view_case, trace_on, injection_delay, policy_arg;
  reg [7:0] old_rebuilt,old_refused,old_spares; reg [8:0] old_bad;
  integer cycles, count, spare_delay, cut, watch, next_addr, last_role, words_sent, guard_role;
  reg [15:0] want;
  task step;
    reg [15:0] old;
    begin
      #4; old={pc,acc};
      old_rebuilt=rebuilt; old_refused=refused; old_spares=spares; old_bad=hash_bad;
      if (!rst) begin
        if ((^stream[40])===1'bx) $fatal(1,"unknown write enable");
        if (stream[40]) begin
          if ((^{role,stream})===1'bx || stream[38:32]!==next_addr[6:0] || (next_addr && role!=last_role)
              || {stream[39],stream[31:0]}!==gold[{role,stream[38:32]}]) $fatal(1,"bad physical configuration write");
          if (role==guard_role && !rebuilt[role]) $fatal(1,"published an unverified or refused recovery");
          words_sent=words_sent+1; last_role=role; next_addr=stream[39] ? 0 : next_addr+1;
          if (trace_on) $display("VIEW %0d %0d write %0d %0d %08h",view_case,cycles-1,role,stream[38:32],stream[31:0]);
        end
      end
      #1; clk=1; #5; clk=0; #1; cycles=cycles+1;
      if (!rst && ((^{pc,acc,retire,rebuilt,refused,hash_bad,spares})===1'bx || (!retire && old!=={pc,acc})))
        $fatal(1,"unknown or uncommitted state at clock %0d",cycles);
      if (watch>=0 && spare_delay<0 && spares[watch]) spare_delay=cycles-cut;
      if (trace_on && !rst) begin
        if (hit) $display("VIEW %0d %0d fault %0d",view_case,cycles-2,fault_addr);
        if (rebuilt!=old_rebuilt) $display("VIEW %0d %0d rebuilt %0d",view_case,cycles-2,rebuilt^old_rebuilt);
        if (refused!=old_refused) $display("VIEW %0d %0d refused %0d",view_case,cycles-2,refused^old_refused);
        if (hash_bad!=old_bad) $display("VIEW %0d %0d digest %0d",view_case,cycles-2,hash_bad^old_bad);
        if (spares!=old_spares) $display("VIEW %0d %0d spare %0d",view_case,cycles-2,spares^old_spares);
        if (retire) $display("VIEW %0d %0d commit %0d %0d",view_case,cycles-2,pc,acc);
      end
    end
  endtask
  task inject(input integer id); begin hit=id>=0; fault_addr=id; step(); hit=0; end endtask
  task trial(input integer id);
    integer boot, since, first_delay, slot, t, bad1, bad2, worker, stop;
    begin
      view_case=id; cycles=0; words_sent=0; next_addr=0; last_role=-1; guard_role=-1; watch=-1; spare_delay=-1;
      rst=1; hit=0; step(); step(); rst=0;
      if (id==17 || id==18) begin guard_role=2; inject(id==17 ? 14 : 24); end
      step(); while (!retire && cycles<70000) step();
      if (!retire || {pc,acc}!==commits[0]) $fatal(1,"case %0d boot failed; rebuilt=%h refused=%h hash_bad=%h",id,rebuilt,refused,hash_bad);
      boot=cycles-2; guard_role=-1;
      for (t=0;t<injection_delay;t=t+1) begin step(); if (retire) $fatal(1,"injection window missed"); end
      bad1=-1; bad2=-1; worker=-1;
      if (id>=1 && id<=16) begin
        slot=(id-1)%8; worker=slot; bad1=(id<=8 ? 12 : 22)+slot; guard_role=slot;
      end
      if (id>=19 && id<=24) begin worker=2; guard_role=2; end
      case(id)
        19: begin bad1=14; bad2=15; end // two absent data shards
        20: begin bad1=14; bad2=25; end // absent target and a silently bad survivor
        21: begin bad1=14; bad2=30; end // absent parity
        22: begin bad1=14; bad2=31; end // silently corrupt parity
        23: begin bad1=30; guard_role=-1; end // intact tape, no parity needed
        24: begin bad1=24; bad2=25; end // two corrupt data shards
        25: begin bad1=14; bad2=15; end // existing workers still operate
      endcase
      cut=cycles; if (trace_on) $display("VIEW %0d %0d window",id,cycles-2);
      watch=worker; inject(bad1); inject(bad2); inject(worker);
      stop=0; count=0; first_delay=-1;
      while (count<7 && !stop) begin
        since=cycles; step();
        while (!retire && !refused && cycles-since<50000) step();
        if (!retire) begin
          if (!refused) $fatal(1,"watchdog without a decision");
          for(t=0;t<1200;t=t+1) begin step(); if (retire) $fatal(1,"commit after refusal"); end
          stop=1;
        end else begin
          want=commits[count+1]; if ({pc,acc}!==want) $fatal(1,"case %0d commit %0d: %h%h vs %h",id,count,pc,acc,want);
          if (!count) first_delay=cycles-cut; count=count+1;
        end
      end
      if (next_addr!=0) $fatal(1,"partial publication");
      if (trace_on) $display("VIEW %0d %0d end",id,cycles-2);
      $display("GRFP %0d %0d %0d %0d %0d %0d %0d %0d %0d %0d",id,boot,count,first_delay,spare_delay,rebuilt,refused,hash_bad,spares,words_sent);
    end
  endtask
  integer group_no,j,one;
  initial begin
    if (!$value$plusargs("DELAY=%d",injection_delay)) injection_delay=170;
    if (!$value$plusargs("POLICY=%d",policy_arg)) policy_arg=0;
    policy=policy_arg;
    $readmemh("bench-images.hex",gold);
    $readmemh("bench-commits.hex",commits); trace_on=$test$plusargs("VIEW");
    if ($value$plusargs("CASE=%d",one)) trial(one);
    else begin
      if (!$value$plusargs("GROUP=%d",group_no)) group_no=0;
      for(j=group_no;j<26;j=j+4) trial(j);
    end
    $finish;
  end
endmodule
