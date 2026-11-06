const FLOAT = new Float64Array(1)
const SIGNED = new Int32Array(FLOAT.buffer)
const UNSIGNED = new Uint32Array(FLOAT.buffer)
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
const HIGH = LITTLE_ENDIAN ? 1 : 0
const LOW = LITTLE_ENDIAN ? 0 : 1
const EXPONENT_BIAS = 1023
const EXPONENT_SHIFT = 20

export const MAGNITUDE_MASK = 0x7fffffff
export const INFINITE_HIGH_WORD = 0x7ff00000
export const SMALLEST_NORMAL_HIGH_WORD = 0x00100000

export function highWord(value: number): number {
  FLOAT[0] = value
  return SIGNED[HIGH]
}

export function lowWord(value: number): number {
  FLOAT[0] = value
  return UNSIGNED[LOW]
}

export function fromWords(high: number, low: number): number {
  SIGNED[HIGH] = high
  UNSIGNED[LOW] = low
  return FLOAT[0]
}

export function withHighWord(value: number, high: number): number {
  FLOAT[0] = value
  SIGNED[HIGH] = high
  return FLOAT[0]
}

export function withLowWord(value: number, low: number): number {
  FLOAT[0] = value
  UNSIGNED[LOW] = low
  return FLOAT[0]
}

export function scaleByPowerOfTwo(value: number, exponent: number): number {
  return value * fromWords((exponent + EXPONENT_BIAS) << EXPONENT_SHIFT, 0)
}
