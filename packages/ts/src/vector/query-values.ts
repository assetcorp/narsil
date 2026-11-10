import { ErrorCodes, NarsilError } from '../errors'

function isFloat32Representable(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(Math.fround(value))
}

export function requireUsableQueryVector(value: unknown): void {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Vector query 'value' must be an array of numbers`, {
      received: typeof value,
    })
  }
  for (let index = 0; index < value.length; index++) {
    if (isFloat32Representable(value[index])) continue
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `Vector query 'value' element at index ${index} is not a number that a 32-bit float holds as a finite value`,
      { index, value: value[index] },
    )
  }
}
