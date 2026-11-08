import type { NativeStoredValues } from '../../vector/native/types/stored-values'

function compareText(values: NativeStoredValues, left: number, right: number): number {
  const leftLength = values.textLength[left]
  const rightLength = values.textLength[right]
  const length = Math.min(leftLength, rightLength)
  const leftStart = values.textStart[left]
  const rightStart = values.textStart[right]
  const region = values.kinds[left] === 5 ? values.bytes : values.units
  for (let at = 0; at < length; at++) {
    const order = region[leftStart + at] - region[rightStart + at]
    if (order !== 0) return order
  }
  return leftLength - rightLength
}

export function compareStoredElements(values: NativeStoredValues, left: number, right: number): number {
  const kind = values.kinds[left]
  if (kind !== values.kinds[right]) return kind - values.kinds[right]
  if (kind === 4 || kind === 5) return compareText(values, left, right)
  if (kind !== 3) return 0
  const first = values.numbers[left]
  const second = values.numbers[right]
  if (first === second) return 0
  if (Number.isNaN(first)) return Number.isNaN(second) ? 0 : 1
  return Number.isNaN(second) || first < second ? -1 : 1
}

function effectiveShape(values: NativeStoredValues, ordinal: number): number {
  const shape = values.shapes[ordinal]
  return shape === 1 && values.kinds[values.starts[ordinal]] === 0 ? 0 : shape
}

export function compareStoredValues(values: NativeStoredValues, left: number, right: number): number {
  const shape = effectiveShape(values, left)
  const otherShape = effectiveShape(values, right)
  if (shape !== otherShape) return shape - otherShape
  if (shape === 0) return 0
  const first = values.starts[left]
  const second = values.starts[right]
  const firstLength = values.starts[left + 1] - first
  const secondLength = values.starts[right + 1] - second
  const length = Math.min(firstLength, secondLength)
  for (let at = 0; at < length; at++) {
    const order = compareStoredElements(values, first + at, second + at)
    if (order !== 0) return order
  }
  return firstLength - secondLength
}
