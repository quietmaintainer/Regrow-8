# Recover a lost FPGA tape with GRFP parity

The protected iCE40 profile can lose the adder tape **and then the running adder** and still execute `FE + 02 = 00` at PC `02`. The FPGA recovery port reconstructed the 54-word configuration, verified it, and programmed a spare. The next instruction committed 33,009 clocks after injection (2.75 ms at 12 MHz); the [unprotected on-demand control](recorded-hx8k.csv) stalled. The bank was never reset.

## Reproduce

Use the [same toolchain](README.md#reproduce) as the unprotected FPGA experiment. From the repository root:

```sh
npm run test:fpga:grfp
```

This creates a fresh `output/grfp-trial-*` directory, synthesizes and routes the CPU **and recovery logic**, and runs 26 fault trials on the mapped FPGA primitives. Compare the generated `panel.csv` with the [recorded HX8K results](recorded-grfp-hx8k.csv). `report.json` includes the recipe hash, all nine reference digests, placed resources, clock estimates and per-case measurements. For the faster RTL panel: `node examples/fpga_fabric/run.mjs --grfp --rtl-only`.

The mapped run also emits `viewer-bundle.json` for the [Chip Workbench](../../workbench.html). **Live mapped FPGA** runs the mapped primitives in a browser worker: choose your own fault timing and see the actual configuration writes, refusal or continued execution. **Verified FPGA replay** navigates the measured trial clocks. To rebuild an edited workbench recipe, pass `--recipe path/to/edited.txt` to the Node runner with `--grfp`. [Viewing and editing guide](../../docs/workbench.md)

## What is stored and verified

* **At provisioning:** the [encoder](protection.mjs) takes the eight actual worker images from the CRC recipe and serializes their 32-bit words little-endian. It calls GRFP's [global16 encoder](../file_recipe/rs16.mjs) with eight data coordinates and parity row zero. The 1,508 payload bytes need one 352-byte parity row (the longest tape). The eight tapes are LUT ROMs; parity has a separate ROM. Trusted metadata stores each length and SHA-256 digest, including the parity digest. This fixed hardware profile uses the GRFP erasure code on tape bytes; it does not parse `.grfp` container headers on the chip.
* **On every load:** a bay can request its image even with a dead local tape reader. The shared [recovery port](grfp_reader.v) services requests independently of the unprotected read-marker chain. It stages the requested image and hashes the RAM readback. Only an image matching its expected digest can be streamed to a primary or spare. A worker enables execution on the final word of that verified stream.
* **On an erasure or hash mismatch:** the port verifies the parity row and each of the seven surviving tapes. It removes their weighted contributions from parity, zero-extending shorter tapes. For erased tape `m`, the residual is `c[m] × tape[m]`; for this GRFP row `c[m] = inverse(8 XOR m)`. A bit-serial multiplier works on the two GF(2¹⁶) symbols in each configuration word. Multiplication by `8 XOR m` yields the missing words. The port hashes the rebuilt RAM image against the **original** tape digest before issuing a write. It never has to read the lost master to claim the spare.
* **Beyond budget:** a second unavailable or invalid contributor, or a rebuilt digest mismatch, latches a refusal for that request until reset. No part of the replacement image is issued. Existing verified workers can continue without their masters. The device repairs the working configuration; an inaccessible master ROM remains inaccessible, and a later load may require recovery again.

The [SHA-256 engine](tape_sha256.v) processes one block at a time. The schedule and chaining state share two block RAMs with read-only round constants and expected digest words. Staging, the syndrome buffer, and the parity ROM use two block RAMs each. The trusted verifier, metadata, bank and programming path are outside the injected faults. Protection covers tape data; it does not reconstruct lost live register state.

## Measured tradeoff

| HX8K-CT256, seed 1 | Unprotected | GRFP-protected |
|---|---:|---:|
| Placed logic cells (of 7,680) | 5,237 | 7,079 |
| Block RAMs (of 32) | 24 | 32 |
| First instruction on clean boot (clocks) | 468 | 23,672 |
| Clean instruction interval (clocks) | 402 | 402 |
| Next commit after loss of adder tape and adder | Stalled | 33,009 clocks |

The protected image met the 12 MHz placement constraint; nextpnr estimated 66.90 MHz. It used 8 global buffers and 104 I/O pins including test instrumentation. These are place-and-route estimates and zero-delay primitive simulations, with faults at the modeled tape/worker domains.

The [testbench](grfp_trials.sv) compares every configuration write (address, all 32 data bits, and last-word flag) with a bench-only copy of the recipe. After the first commit, faults start 170 clocks later. Each of the eight tape losses and eight silent last-word bit flips was followed by loss of its primary: **all 16 trials preserved the next seven PC/ACC commits**. A missing or corrupt adder tape at boot also recovered. When recovery lacked a valid second source (two bad tapes, or a bad tape plus lost/corrupt parity), no spare image was published and no further commit occurred in the observation window. Parity loss alone did not prevent loading an intact tape.
