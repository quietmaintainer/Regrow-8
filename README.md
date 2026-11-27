# Regrow-8

Regrow-8 simulates digital circuits that grow from recipes and reroute around damaged cells on a 64 × 64 logic fabric.

## Browser demo

[Open the GitHub Pages demo](https://quietmaintainer.github.io/Regrow-8/)

[Open Chip Workbench](https://quietmaintainer.github.io/Regrow-8/workbench.html) to clock the protected iCE40 HX8K live, inject faults, inspect placed signals, or replay verified repair trials. The bundled build runs in the browser. [Workbench guide](docs/workbench.md)

- **8-bit CPU** with an accumulator, program counter, ROM, and external RAM. Build it on the grid, watch its active wires, and apply the repeatable 15% permanent fault mask.
- **4-bit enabled counter** that grows from its edge tape one row per step. Toggle its enable input to hold the count, or damage the fabric and watch a new tape repair it.
- **Cell inspector** for gate functions, logic groups, wire tracks, and active pin contacts. Use the erase and permanent damage tools on individual cells or brush areas.

Serve the project directory with any static HTTP server. For a local run with Python, use `python -m http.server 8000 --bind 127.0.0.1` and open the [Regrow-8 viewer](http://127.0.0.1:8000/) or [Chip Workbench](http://127.0.0.1:8000/workbench.html). The site uses relative URLs for GitHub Pages project paths.

## Write a recipe

The browser reads `recipes/cpu.txt` and `recipes/counter.txt` directly. Each recipe names the gates and their input signals. The growth engine places the gates and routes the wires.

```text
# inverter.txt
inputs a
group inverter
  gate inverse NOT a
output y inverse
```

`inputs` and `output` set the pin order along the left and right edges. Put each `gate` in a `group`. Gates can reference inputs or gates anywhere in the recipe, including a later gate. A `#` starts a comment.

Use `NOT` or `DFF` with one input, `AND`, `OR`, or `XOR` with two, and `MUX` with a selector followed by the inputs for 0 and 1. A `DFF` captures its input on the rising edge.

To design a circuit in Python, write it in PyRTL and compile it to a Regrow-8 `.txt` recipe. [Circuit Recipe Compiler (CRC) guide](https://github.com/quietmaintainer/CRC#write-your-own-circuit)

Run `node examples/machine_recipe/chip.mjs check circuit inverter.txt` to check that the recipe grows and meets the fabric's timing bound. Use `check cpu` or `check alu` for the corresponding instruction tests. [CPU](recipes/cpu.txt) · [Counter](recipes/counter.txt) · [ALU](recipes/alu.txt)

Use GRFP to pack a recipe file into a parity-protected archive for storage and recovery. [GRFP Archive Format](https://github.com/quietmaintainer/grfp)

## Experiments

The [FPGA experiment](examples/fpga_fabric/README.md) maps the CRC CPU and its repair fabric to an iCE40 HX8K. On-demand Regrow preserved execution in 8/8 single-primary fault trials on the mapped design versus 4/8 for each fixed hot-spare assignment. [Recorded results](examples/fpga_fabric/recorded-hx8k.csv)

The [GRFP-protected FPGA profile](examples/fpga_fabric/GRFP.md) recovers from loss of a recipe tape followed by its worker. The chip reconstructs the tape from one parity row, verifies the words with SHA-256, and loads a spare. Run `npm run test:fpga:grfp` to rebuild and run the 26-case panel, or `npm run test:fpga:live` to check the bundled live simulator against the recorded mapped pin events. [Protected trial results](examples/fpga_fabric/recorded-grfp-hx8k.csv)

With Node 22 or later, run `npm test` to check the fabric, viewer simulation, and repair experiments. The experiment guide covers the ISA, the matched wiring tests, live triplicated CPU registers, and two mutually repairing cores with parity-protected `.grfp` recipes. [Experiment guide](examples/machine_recipe/README.md) · [Recorded results](examples/machine_recipe/results/autonomy.json)

The original viewer shows the single-copy CPU and enabled counter. A host planner chooses gates and routes. The triplicated CPU and peer controllers run in the Node experiments.

## Credits

Regrow-8 comes from Automaton Swarm's Computer Recipe mode. The archive-protection support includes code from Automaton Worm and carries its original MIT notice. [Upstream notice](docs/automaton-worm-LICENSE.txt)
