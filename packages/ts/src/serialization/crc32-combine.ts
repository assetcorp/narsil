const IEEE_POLYNOMIAL = 0xedb88320
const CRC_BITS = 32

const zeroByteOperators: Uint32Array[] = []

function timesVector(operator: Uint32Array, vector: number): number {
  let sum = 0
  let rest = vector >>> 0
  for (let row = 0; rest !== 0; row++, rest >>>= 1) {
    if (rest & 1) sum ^= operator[row]
  }
  return sum >>> 0
}

function squared(operator: Uint32Array): Uint32Array {
  const result = new Uint32Array(CRC_BITS)
  for (let row = 0; row < CRC_BITS; row++) result[row] = timesVector(operator, operator[row])
  return result
}

function firstOperator(): Uint32Array {
  let oneZeroBit: Uint32Array = new Uint32Array(CRC_BITS)
  oneZeroBit[0] = IEEE_POLYNOMIAL
  for (let row = 1; row < CRC_BITS; row++) oneZeroBit[row] = 1 << (row - 1)
  for (let doubling = 0; doubling < 3; doubling++) oneZeroBit = squared(oneZeroBit)
  return oneZeroBit
}

function operatorForZeroBytesPower(power: number): Uint32Array {
  if (zeroByteOperators.length === 0) zeroByteOperators.push(firstOperator())
  while (zeroByteOperators.length <= power) {
    zeroByteOperators.push(squared(zeroByteOperators[zeroByteOperators.length - 1]))
  }
  return zeroByteOperators[power]
}

export function crc32Combine(first: number, second: number, secondByteLength: number): number {
  let crc = first >>> 0
  let rest = secondByteLength
  for (let power = 0; rest > 0; power++) {
    if (rest % 2 === 1) crc = timesVector(operatorForZeroBytesPower(power), crc)
    rest = Math.floor(rest / 2)
  }
  return (crc ^ second) >>> 0
}
