# The Regrow CPU on a simulated iCE40 FPGA

This experiment runs the [CRC-generated 8-bit CPU](../../recipes/hx8k-cpu8.txt) **and its repair fabric** on a mapped iCE40 HX8K netlist. After a permanent primary-site fault, an on-demand spare preserved the next seven PC/ACC commits in **8/8** single-primary trials. A spare preassigned to either member of each pair covered **4/8**, but switched over faster when it covered the fault. [Recorded per-fault measurements](recorded-hx8k.csv)

For faults in the tape itself, the [GRFP recovery profile](GRFP.md) adds independently checked parity and an on-chip loader. It passed the previously blocked adder-tape-plus-primary case. The measurements below are the unprotected baseline.

## Reproduce

From the repo root, with Node 22+, Yosys, nextpnr-ice40, and Icarus Verilog (`iverilog` and `vvp`) on PATH:

```sh
npm run test:fpga
```

Each invocation prints a fresh directory under `output/fpga-trial-*`. To choose a specific **new** directory, use `npm run test:fpga -- my-trial`. Explicit paths are never reused, even after a partial run.

The runner emits the recipe ROMs and wiring, synthesizes the entire DUT with `synth_ice40`, places and routes for **HX8K-CT256**, then runs 57 trials of the mapped netlist with Yosys's `ice40/cells_sim.v`. `report.json` contains the recipe hash, cell counts, placement results, clock counts, loaded spare masks and matching commits. `panel.csv` can be compared with the recorded CSV. The generated Verilog, mapped netlist, routed `.asc`, tool logs and individual simulation logs are retained beside them. An incorrect commit, unknown architectural output, or unexpected recovery/stall fails the run.

The executable paths can be overridden with `YOSYS`, `NEXTPNR_ICE40`, `IVERILOG`, and `VVP`. Set `ICE40_CELLS` to the full path to `ice40/cells_sim.v` if Yosys's library is outside `/usr/share/yosys` or `/usr/local/share/yosys`. These five settings may also be saved in the git-ignored `output/fpga-tools.env` as `NAME=absolute-path` lines; shell settings take precedence. The recorded run used Yosys 0.71, nextpnr 0.11.1 (YoWASP builds) and Icarus 13.0. For a faster RTL-only check with Icarus, use `node examples/fpga_fabric/run.mjs --rtl-only`. The ordinary `npm test` checks the tape encoding without external HDL tools.

With Circuit Recipe Compiler installed, `crc recipes/hx8k_cpu8.py -o recipes/hx8k-cpu8.txt` regenerates the default recipe. [PyRTL CPU source](../../recipes/hx8k_cpu8.py)

## What runs inside the FPGA

- The [generator](profile.mjs) takes all eight packed CRC logic cones: opcode ROM, operand ROM, sum, XOR bits, PC increment, branch decision, and the two D-input cones. It translates each LUT to a 32-bit configuration word: truth table plus three local bit selectors. Eight final buffer LUTs collect the byte result. ROM, fetch, arithmetic and branch results all come from those instructions.
- The [fabric](fabric.v) has four bays. Each bay has two recipe tapes, two primary workers and a neighboring spare with the same pinout and instruction capacity. At reset, all worker images are invalid. A read marker advances along the tapes. Each tape writes a worker's config RAM one word per clock; the worker can execute only after receiving the whole image. Losing a tape does not erase a completed copy.
- A worker latches local input bits and evaluates one LUT per clock from its RAM. Registered connections carry the result bytes forward with a valid bit and transaction color. Only a complete return for the current color captures both eight-bit CPU registers. One inter-bay crossing has a direct register and a two-register detour. A full cut breaks that feedback loop.
- **Regrow:** the third worker starts unconfigured. Its adjacent controllers can claim it for either missing primary and stream that primary's tape into it. **Fixed-A / fixed-B:** the same third worker is configured at boot for the first / second primary respectively and computes alongside it. `policy` is a pin set before reset: all three policies use **the same placed design**, RAM, links and clock. This isolates the value of assignment flexibility; it is not an area comparison against separately optimized fixed-only RTL.

The FPGA uses local bay choices and a dedicated link detour so the complete CPU and configuration logic fit on one part. The architectural register bank stays in place. The testbench injects fail-silent domain faults by address. The device assigns the spare, supplies its image, chooses the link and captures the registers.

## What the trials showed

Each trial starts from reset with the same program. The CPU first loads `FE`. Injection starts 170 clocks after that commit, during the next instruction. The checker requires the following `(PC,ACC)` sequence in hex: `02/00, 80/00, 81/A5, 82/A5, 83/00, 00/00, 01/FE`. A blocked trial is observed for 1,200 clocks without a commit. A separate boot fault removes the unread adder tape. [Testbench](trials.sv)

| Fault | On-demand Regrow | Fixed-A hot spare | Fixed-B hot spare |
|---|---|---|---|
| Each of 8 primaries, separately | 8/8 continue | 4/8 continue | 4/8 continue |
| `sum` and `take` (different bays) | Continues | Stalls | Stalls |
| Both primaries in the adder bay | Stalls | Stalls | Stalls |
| Adder tape, then adder primary | Stalls | Continues | Stalls |
| Direct inter-bay link | Detours | Detours | Detours |
| Both inter-bay paths | Stalls | Stalls | Stalls |

Clean boot took **468 clocks** to the first commit. In steady operation an instruction took **402 clocks**; at the chosen fault instant, 232 clocks remained on the clean control. With the adder disabled, Regrow installed its 54-word image in **56 clocks from injection** and committed after **314** (82 extra). The already-running fixed-A spare committed after **232**. On-demand load times over all eight single-primary faults ranged from 17 to 90 clocks. A direct link cut added one clock per instruction.

At seed 1, nextpnr used **5,237 / 7,680 logic cells**, **24 / 32 block RAMs**, 7 / 8 global buffers and 35 I/Os. Its estimated clock limit was 70.28 MHz against a 12 MHz constraint, with automatic I/O placement. Functional results are from zero-delay simulation of the FPGA primitives; timing is a place-and-route estimate. These are faults of modeled overlay sites, tapes and links, not random underlying transistor faults. The measurements assume the bank, clock and local fault indication are healthy.
