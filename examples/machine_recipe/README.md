# A machine that can move its gates

An 8-bit ALU and a clocked accumulator CPU grow from connectivity recipes on a 64 × 64 logic fabric. In one CPU trial, **610 programmable sites were permanently stuck at zero**. The constructor moved 26 gates, kept 90 intact driver-to-input paths and routed 236 others. At the original pins and clock rate the repaired CPU passed **2,097,152 / 2,097,152** instruction transitions. The worst path grew from 263 to 286 ticks; the sampling deadline stayed at 512.

## Reproduce

From the repository root, Node 22, no packages or viewer build:

```sh
node examples/machine_recipe/chip.mjs check cpu recipes/cpu.txt --stuck 15 --shape scatter --seed 20261125
node --test examples/machine_recipe/test_machine.mjs
node examples/machine_recipe/benchmark.mjs --out machine-recipe-trial
```

The benchmark needs a **new** output directory. It reads the recorded JSON recipes and writes both recipes, their `.grfp` archives, and a per-trial `report.json`. It finishes the panel and exits nonzero if any repair fails, including an unreachable pin. The recorded three-seed run has four such failures. Use `--seed N --count N` to run a different consecutive seed panel. [Recorded measurements](results/report.json) · [ALU archive](results/alu.grfp) · [CPU archive](results/cpu.grfp)

## What grows, and how it is clocked

- **ALU:** two 8-bit operands; `op=0,1,2,3` selects add, subtract, XOR, AND. Eight full-adder slices ripple the carry. Outputs are the byte, zero, and carry (no borrow for subtraction; clear for logic).
- **CPU:** 8-bit accumulator, 2-bit PC, four-word external instruction ROM and four external byte addresses for stores. Opcodes `0..7` are `LDI`, `ADDI`, `SUBI`, `XORI`, `STA`, `BZ`, `JMP`, `NOP`, each with an 8-bit operand. `BZ` tests the accumulator; jumps and stores use the low two address bits. The accumulator and PC wrap. Synchronous reset clears both and inhibits writes. The test ROM uses arithmetic, takes both branch outcomes and writes RAM through the physical store pins.
- **Recipe** files list named gates and their inputs. The runtime reads plain text and assigns physical coordinates during growth. The archived JSON format stores repeated gate groups as templates. The recorded CPU archive uses five distinct bodies for 18 instances. [Text format](../../README.md#write-a-recipe) · [Recipe reader](logic.mjs)
- **Fabric:** a tile has at most one gate or D flip-flop and 12 independently switched wire tracks. Each track selects the local driver or one track on a cardinal neighbor. Wires can cross and branch, but there is no connection between distant sites without a chain of programmed switches. Blank or severed inputs read zero. Fixed input/output pads, the seed dock and the dedicated ideal clock pad are outside the damage population.
- **Growth and repair:** one dock probes its neighbors and expands a configuration wave only through responding tiles. A host planner reads the reached sites, matches surviving gates by tag and primitive, and traces each socket to its actual driver. It retains intact paths, places missing gates near their template's preferred position, and searches for free tracks back to the driver or a surviving branch. The wave installs only differing fields, after checking connectivity and timing. Repair receives the recipe and physical readback; it needs no old layout, damage coordinates or test vectors. This is a centrally planned virtual FPGA with a configuration channel, not an autonomous self-reproducing CA. [Constructor](grow.mjs)
- **Timing:** gates and track cells each cost one tick. On a fixed 1,024-tick cycle the CPU presents its new PC by the half-cycle; the external ROM then supplies the instruction, and the store pins and D inputs must settle before the rising edge. Every build must have a worst combinational path **under 512 ticks**. Exactness means identical values at the specified samples, not identical intermediate glitches. The [executor](fabric.mjs) traces the actual switches and evaluates the settled gate DAG, sampling all DFFs together. It never reads netlist signals or placement tags. A literal one-hop simulation independently checks the propagation bound through a detour.

## Four checks

**1. Grow from a blank fabric.** Only pads and the dock exist initially. The clean ALU used 82 logic sites and passed all `4 × 256 × 256 = 262,144` vectors, including both flags. The CPU used 144 logic sites and passed all `8 opcodes × 256 operands × 256 accumulator states × 4 PCs = 2,097,152` transitions. The verifier sets up CPU states by executing `LDI` and `JMP`, never by patching registers. It also runs a 16-edge program addressed by the physical PC. The integer oracles live only in the [verifier](verify.mjs); 32 packed bits test 32 independent inputs to the same physical circuit.

**2–3. Erase or brick the substrate.** Each trial damages a fresh copy of the commissioned layout. A crater is one filled disk trimmed to the exact site count. Scatter samples without replacement. Masks include unused sites and are nested across rates, with three consecutive seeds (`20261125`–`20261127`). A permanent fault clears the logic, state and *every* track on that tile and disables subsequent writes. A transient erasure clears the same fields but allows reprogramming. Each pass below ran the entire corresponding vector suite again.

| Damage | ALU crater | ALU scatter | CPU crater | CPU scatter |
|---|---:|---:|---:|---:|
| Erased 25%, 50%, 75% (combined) | 9/9 | 9/9 | 9/9 | 9/9 |
| Permanent 5% | 3/3 | 3/3 | 3/3 | 3/3 |
| Permanent 10% | 3/3 | 3/3 | 3/3 | 3/3 |
| Permanent 15% | 3/3 | 3/3 | 3/3 | 2/3 |
| Permanent 20% | 3/3 | 3/3 | 3/3 | 0/3 |

A 25% ALU crater in the first seed erased nine gates. Four of nine modules retained all their gates and incoming paths; 159 of 196 paths were kept. A targeted intervention also kills the gate driving `y0`, observes an actual wrong answer, verifies every unaffected path survives relocation and checks that a second repair writes **zero** fields.

The four CPU failures disconnected a fixed pad from the dock's healthy component (`i0`, `addr1` or `i4`). They are failed repairs, not skipped vectors counted as successes. A percentage alone cannot guarantee recovery: a few dead cells can cut off a fixed pin. Routing is finite-capacity and greedy; it does not prove feasibility for arbitrary layouts. Repair pauses the clock. Healthy DFFs retain Q; an erased DFF loses Q. Functional recovery is from reset, not recovery of unknown live state.

**4. Protect the recipe itself.** The [benchmark](benchmark.mjs) uses the existing [global GF(2¹⁶) `.grfp` encoder and decoder](../file_recipe/PROTECTION.md). It deletes the whole recipe data frame, gives the decoder only the shortened archive and verifies both recovered recipe and regenerated archive byte-for-byte. **All benchmark builds consume the recovered recipe.** At a nominal 5% parity each small archive gets one whole parity frame; this is a frame-erasure budget, not a byte-overhead claim.

Use the standalone Rust CLI to inspect or recover the recorded ALU and CPU archives. [GRFP recovery guide](https://github.com/quietmaintainer/grfp#build-and-use)

| Bytes on disk or in the specified encoding | ALU | CPU |
|---|---:|---:|
| Dense programmed grid (18 bytes/site, including tags and switches) | 73,728 | 73,728 |
| Flat numeric gate list with I/O names | 1,164 | 1,910 |
| Hierarchical recipe | 671 | 1,206 |
| Raw DEFLATE: grid / flat list / recipe | 1,642 / 427 / 275 | 2,685 / 638 / 430 |
| Complete `.grfp` | 2,052 | 2,209 |
| Data frame physically deleted and recovered via parity | 375 | 530 |

The dense grid includes empty capacity; the flat and DEFLATE controls are fairer compression comparisons. Sizes exclude the shared constructor, executor and external ROM/RAM. Protection costs more bytes than the flat netlist at this scale.

## Live repair experiments

```sh
node examples/machine_recipe/autonomy.mjs --out machine-recipe-autonomy.json
```

Choose a new output filename, or omit `--out` to print the report to stdout. These experiments use the same gate and switch fabric as the Computer Recipe viewer. [Recorded results](results/autonomy.json)

### Redundant boundary contacts

Each logical pin has a primary contact and three faultable backups spread along its edge. The growth planner binds the pin to one reachable contact at a time. The external terminal keeps the same logical name. Both layouts receive identical damage masks and every successful layout runs all 2,097,152 CPU transitions.

| CPU damage panel | One contact | Four contacts |
|---|---:|---:|
| Original panel, all masks | 38/42 | 42/42 |
| Original panel, 15% permanent | 5/6 | 6/6 |
| Original panel, 20% permanent | 3/6 | 6/6 |
| Held-out scatter, 15% and 20% permanent | 9/12 | 9/12 |

The held-out panel used seeds `20261128`–`20261133`. Both layouts hit the same three track-routing failures at 20%. A continuous cut along the inside of the input edge disconnected every `i0` contact and still prevented repair.

### Live register repair

The CPU uses three spatially separated D flip-flops for each of its eight accumulator bits and two PC bits. Their majority votes feed the rest of the circuit, including the zero test used by branches. The minimum distance between replicas of one bit was five cardinal hops across the tested layouts.

Each of the 30 physical latches was permanently bricked while holding a one at edge 6 of a running program. Two trials per latch committed repair at edge 9 or 10. The CPU continued through three or four edges with one replica missing, and the programming port seeded the relocated latch from the majority value at commit. In 27 of the 60 runs that value was zero. All runs matched the independent oracle for PC, accumulator, stores and external RAM through 32 program edges without a reset after the fault. The clean circuit and one healed circuit also passed all 2,097,152 instruction transitions. The longest repaired path took 270 of the available 512 ticks. The single-copy control diverged at the first sample after the same kind of cut. [Live CPU experiment](live.mjs)

### Bidirectional peer repair

Two clocked one-bit XOR accumulators and their supervisory circuits share a 64 × 64 fabric. Each side has a `.grfp` bank containing the circuit recipe and repair routes. One memory tile per bank was bricked before the run, removing a complete data frame. When a replica disappeared, the surviving peer requested the tape, advanced its route address until the configuration port reported an applicable entry, and issued the write. The port programmed the relocated latch and wires, using the live majority bit. On the next edge the peer verified the replacement's connections and value.

Both accumulators matched their expected values at every edge of three 36-edge trials. There were six verified repairs across both directions and both fault orders. When the first spare was also bricked, the supervisor rejected route 0 and used route 1. Erasing the peer's tape-read gate prevented repair while the majority continued masking the missing latch. [Peer experiment](peer-repair.mjs)

The full CPU uses the host growth planner during live repair. The peer experiment prepares route alternatives at provisioning time and uses a simulated configuration port for tile readback, `.grfp` decoding, guarded writes and latch initialization. Its on-fabric supervisors handle detection, route selection, command sequencing and verification. Run the triplicated CPU and peer variants with the Node command above.

### CPU wiring layout

The viewer and `chip.mjs check cpu` use paired ALU and accumulator rows for the shipped CPU recipe. The decoder and program counter sit below the data path near the opcode and address pins. The router keeps intact paths during repair. It routes short pending links first and tries less occupied tracks before allowing a route through busier tiles. The clean layout uses 2,137 track slots (3,536 in the prior layout), with a longest signal path of 156 ticks (263 previously). The signal timing deadline stays at 512 ticks.

Both layouts had four contacts per pin and received the same masks. Every repaired layout passed all 2,097,152 instruction transitions.

| Damage panel | Prior wiring | Revised wiring |
|---|---:|---:|
| Original 42 masks | 42/42 | 42/42 |
| Previous 12 scatter masks at 15% and 20% | 9/12 | 12/12 |
| Development scatter at 20%, seeds `20261134`–`20261169` | 27/36 | 35/36 |
| Fresh scatter at 20%, seeds `20261170`–`20261193` | 16/24 | 24/24 |

In the one remaining failure, seed `20261166` disconnected all four `i0` contacts. The longest path in a successful repair was 264 ticks. [Per-mask results](results/autonomy.json)
