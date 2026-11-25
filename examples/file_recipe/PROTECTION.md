# Protected machine recipes

The Node experiments use a `.grfp` container for the circuit recipe and parity. The container keeps a frame catalog and protects groups with Reed–Solomon parity over GF(2¹⁶). The benchmark removes a whole data frame and verifies recovery against the original recipe bytes. The peer experiment reads a tape after one simulated memory tile loses its data frame.

The archive, codec, and parity modules came from the Automaton Worm file recipe implementation via Automaton Swarm. The simulator uses these modules for the experiment tapes. [Upstream MIT notice](../../docs/automaton-worm-LICENSE.txt) · [Machine Recipe experiments](../machine_recipe/README.md)
