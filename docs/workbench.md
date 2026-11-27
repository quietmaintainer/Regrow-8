# Chip Workbench

In the Regrow viewer, choose **iCE40 HX8K FPGA** from **Design**. For a local run, serve the repository with `python -m http.server 8000 --bind 127.0.0.1` and open [the workbench](http://127.0.0.1:8000/workbench.html). Localhost or HTTPS supplies the browser's SHA-256 API. The shipped 560 KB example includes the live mapped circuit, recipe, placement and 26 verified trials. No synthesis tools, simulator server or board connection are needed to run it.

## Clock the chip live

**Live mapped FPGA** starts paused at clock zero after reset. Click **Next instruction**: the actual loader, SHA engine, configuration RAMs, CPU and interconnect execute until PC reads `01` and ACC reads `FE`. To make a new experiment, select **Lose sum tape**, click **Inject & pause**, then **Disable sum primary** and inject again. Click **Next instruction** to clock the recovery reader and spare. The next result is PC `02`, ACC `00`. The elapsed clocks depend on *when you injected*; no recorded scenario is selected.

* **Play/Pause**, **+1 clock**, **Run clocks**, **Next event** and **Next instruction** control a Web Worker. Injection emits one `fault_addr`/`hit` pulse at a rising edge and pauses; faults persist until reset. The 32 DUT fault addresses cover workers, spares, tapes, links and parity, including silent tape-bit errors. Entering live FPGA mode or changing its spare policy powers up a fresh simulation. Next-event/instruction waits are interruptible and bounded at 100,000 clocks. A refusal is displayed, even when no instruction retires.
* **Signal levels** lights placed sites whose retained probe is high at the sampled clock. Select a BEL to see the probe (e.g. LC output or BRAM `RDATA[0]`) and its actual bit. 7,146 of the 7,223 sites in the example have an identifiable mapped signal; unidentifiable sites have no live dot. Brightness is a logic level, not heat or damage.
* **Timeline** shows live configuration writes, faults, verification results, spare changes, and instruction commits. Select an event to inspect its component at the current FPGA clock. Use **Follow latest** to resume scrolling as new events arrive. The timeline starts fresh when you reset the chip.
* The [stepper](../web/live-fpga.mjs) evaluates the Yosys netlist of iCE40 LUT4s, carries, rising-edge flip-flops and synchronous block RAMs. All sequential elements sample the same pre-edge state; combinational paths then settle. It is a two-state, zero-delay functional simulation. Initial don't-care RAM bits are concretized to zero; loaded sites still require the complete checked image. Placement supplies coordinates; wall time depends on the browser and is not the FPGA clock frequency. The worker receives no ROM program oracle or recorded scenarios.
* Run `npm run test:fpga:live` to re-drive the shipped chip with only the 26 measured fault schedules and compare the resulting pin events, including every configuration word, against Icarus. The recorded panel covers 1,334,358 clocks. The unit suite also checks a separate hot-spare-B schedule that isn't in the panel.

## Follow the lost adder

For the measured example, choose **Verified FPGA replay** (or open [`workbench.html?mode=replay`](http://127.0.0.1:8000/workbench.html?mode=replay)). The initial replay selection is **sum**, trial **lost tape then primary: sum**, at the injection window. The CPU has loaded `FE` at PC `01`. The inspector links 46 source gates to the adder's 54-word image. Select **Tape 2** to inspect its truth tables and bit selectors; select a worker or one of its placed sites to see its FPGA location. In **Logic connections**, the edges are dependencies between logical roles. The **HX8K placement** layer uses actual nextpnr locations.

| Jump or step | Observed FPGA clock (reset released = 0) |
|---|---:|
| Injection window | 23,842 |
| Adder tape disabled / primary disabled | 23,843 / 23,845 |
| Reconstruction verified | 56,485 |
| Spare loaded | 56,593 |
| First commit after fault: PC `02`, ACC `00` | 56,851 |

The last transition is **33,009 clocks after the injection window**. Use the slider or **+1 clock** to inspect a clock; **Next event**, **Next instruction**, and Play jump over uneventful intervals. The timeline marks events related to the selection with `▸`; check **Selected component** to filter them. It shows first/last writes by default. Enable **Include each word** and select a write to inspect its actual address and data. Select **two missing tapes** to see a refusal with no replacement writes. Fault actions in replay select recorded trials, with their original fault timing.

The map contains all 7,223 occupied BELs (placed hardware sites): 7,079 logic cells, 32 RAMs, 104 I/Os and 8 global buffers. Drag to pan, Ctrl+wheel or use the buttons to zoom; arrow keys pan and Home fits. Previous/Next site lets you inspect individual coordinates without precise mouse targeting. Highlighting links a role to its primary and shared spare. The **physical sites stay fixed** through repair; the configuration and active worker change. Module attribution uses retained instance names: synthesized/shared logic is labeled accordingly, and a tape may have no separately named BEL. Output routes show retained worker output-bit segments between tiles, not every wire on the die.

## Prepare a recipe for an HX8K rebuild

Open **Recipe editor** to edit the CRC text, or choose a gate in the inspector and select **Edit selected gate** to locate it. **Import recipe** opens a local `.txt` file. The editor checks syntax, signal connections, combinational cycles, and compatibility with the HX8K packing profile.

An edit detaches the loaded run. Use **Export recipe** to save the draft for the FPGA build, or **Restore build recipe** to resume simulation of the loaded run. Both execution modes require a matching mapped build.

## Rebuild and open a new verified run

Use the [FPGA toolchain](../examples/fpga_fabric/README.md#reproduce). From the repository root, with the exported file in the current directory:

```sh
node examples/fpga_fabric/run.mjs --grfp --recipe workbench-recipe.txt
```

The current hardware profile requires 16 register bits, eight compatible packed logic cones, bounded tape images and forward byte-lane dependencies. The recipe also has to pass placement, timing and the actual protected fault panel; the bench's commit oracle is computed independently from the source gates. The command prints the fresh `output/grfp-trial-*` run directory. Choose **Import run** and open its `viewer-bundle.json`. A matching draft can now replay the newly measured run. **Compare with previous imported build** lists changed tape images and changes in physical site occupancy or component label. A different draft is preserved; **Restore build recipe** opens the recipe that produced the imported result.

`npm run test:fpga:grfp` does the same for the shipped CPU. The mapped run records SHA-256 digests for the recipe, synthesis outputs, placement, routing, report, and testbench logs in `build-manifest.json` as it produces them. Keep this manifest with the run directory. The exporter checks these files against the manifest and re-runs all recorded fault schedules on the live image. It issues the portable bundle after every observed pin event matches, including configuration bytes, commits, and recovery transitions. To export a completed mapped run under a new filename:

```sh
node examples/fpga_fabric/export-viewer.mjs output/YOUR_RUN new-chip.json
```

The `regrow-chip/1` bundle carries SHA-256 identities for the normalized recipe, both mapped netlist formats, placed JSON, routed configuration, and bundle contents. The `regrow-hx8k-live/1` image comes from the checked mapped JSON. Its probes use retained net names to link synthesis and placement. Import checks the bundle's digests, resource capacities, live-image bounds and driver order, and recorded trace. These checks establish file consistency. Trust in an imported bundle's provenance depends on its publisher.

**Import run** accepts earlier bundles, including replay-only bundles. To export a raw run directory created before build manifests were introduced, rebuild it from its recipe. Placed replay exports require a mapped run.
