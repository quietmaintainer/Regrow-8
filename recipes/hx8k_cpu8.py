"""Input to Circuit Recipe Compiler: 8-bit PC, accumulator and addressable ROM."""

import pyrtl
from pyrtl.rtllib.adders import ripple_add


LDI, ADDI, XORI, BZ = range(4)
PROGRAM = {
    0x00: (LDI, 0xFE), 0x01: (ADDI, 0x02), 0x02: (BZ, 0x80),
    0x80: (XORI, 0xA5), 0x81: (BZ, 0x00), 0x82: (ADDI, 0x5B), 0x83: (BZ, 0x00),
}

rst = pyrtl.Input(1, 'rst')
pc = pyrtl.Register(8, 'pc_q')
acc = pyrtl.Register(8, 'acc_q')

# CRC lowers this combinational ROM to gates in the HX8K recipe.
word = pyrtl.Const(XORI << 8, bitwidth=10)  # Unlisted addresses: XORI 00
for address, (op, k) in PROGRAM.items():
    word = pyrtl.select(pc == address, pyrtl.Const(op << 8 | k, bitwidth=10), word)
opcode, operand = word[8:10], word[:8]
total = ripple_add(acc, operand)[:8]
bits = acc ^ operand
seq = ripple_add(pc, pyrtl.Const(1, bitwidth=8))[:8]
take = (opcode == BZ) & (acc == 0)
acc.next <<= pyrtl.select(rst, 0, pyrtl.mux(opcode, operand, total, bits, acc))
pc.next <<= pyrtl.select(rst, 0, pyrtl.select(take, operand, seq))

# CRC output buses double as packaging boundaries for configurable logic
# clusters. They expose real signals; they don't specify any tile locations.
for name, wire in [('pc', pc), ('acc', acc), ('opcode', opcode), ('operand', operand),
                   ('sum', total), ('bits', bits), ('seq', seq), ('take', take)]:
    port = pyrtl.Output(len(wire), name)
    port <<= wire


if __name__ == '__main__':
    import argparse
    from pathlib import Path

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verilog', type=Path, help='export the logical CPU core for synthesis')
    dest = parser.parse_args().verilog
    if dest:
        with dest.open('w', encoding='utf-8', newline='\n') as stream:
            pyrtl.output_to_verilog(stream, add_reset=False, module_name='hx8k_cpu8')
