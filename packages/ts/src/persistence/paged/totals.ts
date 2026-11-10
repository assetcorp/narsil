import { loadFailed } from './format'
import { requireNativePage } from './native-file'
import type { PagedFile, SectionReader } from './section-file'

const VALUE_BYTES = Float64Array.BYTES_PER_ELEMENT

export function readPagedTotals(
  file: PagedFile,
  totals: SectionReader,
  first: number,
  output: Float64Array,
  fault: BigUint64Array,
): void {
  const section = totals.native
  if (section !== null && file.native !== null) {
    const status = file.native.core.readPagedTotals(
      section,
      file.cache.pageCache(),
      first,
      output.length,
      output,
      fault,
    )
    requireNativePage(status, file.path, 'tokenTotals', fault[2])
    return
  }
  const bytes = totals.bytesAt(first * VALUE_BYTES, output.byteLength)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 0; at < output.length; at++) {
    const value = view.getFloat64(at * VALUE_BYTES, true)
    if (!Number.isFinite(value) || value < 0) loadFailed(`The term total at ${first + at} of "${file.path}" is invalid`)
  }
  for (let at = 0; at < output.length; at++) output[at] = view.getFloat64(at * VALUE_BYTES, true)
}
