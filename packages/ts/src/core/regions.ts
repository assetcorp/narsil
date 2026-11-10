export function regionsOverlap(left: ArrayBufferView, right: ArrayBufferView): boolean {
  return (
    left.buffer === right.buffer &&
    left.byteLength > 0 &&
    right.byteLength > 0 &&
    left.byteOffset < right.byteOffset + right.byteLength &&
    right.byteOffset < left.byteOffset + left.byteLength
  )
}
