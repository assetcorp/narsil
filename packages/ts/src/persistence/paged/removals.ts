import { loadFailed } from './format'
import { requireNativePage } from './native-file'
import type { PagedFile, SectionReader } from './section-file'

const VALUE_BYTES = 4

export function createRemovalReader(
  file: PagedFile,
  removalOffsets: SectionReader,
  removals: SectionReader,
  tokenCount: number,
): (ordinal: number) => Uint32Array {
  const fault = new BigUint64Array(3)
  return ordinal => {
    const bounds = removalOffsets.bytesAt(ordinal * VALUE_BYTES, VALUE_BYTES * 2)
    const boundsView = new DataView(bounds.buffer, bounds.byteOffset, bounds.byteLength)
    const from = boundsView.getUint32(0, true)
    const to = boundsView.getUint32(VALUE_BYTES, true)
    if (
      to < from ||
      to * VALUE_BYTES > removals.length ||
      from % 2 !== 0 ||
      to % 2 !== 0 ||
      (ordinal === 0 && from !== 0) ||
      ((ordinal + 2) * VALUE_BYTES === removalOffsets.length && to * VALUE_BYTES !== removals.length)
    ) {
      loadFailed(`The removal entry of document ${ordinal} of "${file.path}" leaves its list`, { ordinal })
    }
    const values = new Uint32Array(to - from)
    const offsetSection = removalOffsets.native
    const valueSection = removals.native
    if (offsetSection !== null && valueSection !== null && file.native !== null) {
      const status = file.native.core.readPagedRemovals(
        offsetSection,
        valueSection,
        file.cache.pageCache(),
        ordinal,
        tokenCount,
        values,
        fault,
      )
      if (status < 0)
        requireNativePage(
          status,
          file.path,
          fault[1] === offsetSection.offset ? 'removalOffsets' : 'removals',
          fault[2],
        )
    } else {
      const entry = removals.bytesAt(from * VALUE_BYTES, values.byteLength)
      const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
      let previous = -1
      for (let at = 0; at < values.length; at += 2) {
        const token = view.getUint32(at * VALUE_BYTES, true)
        if (token >= tokenCount || token <= previous) {
          loadFailed(`The removal entry of document ${ordinal} of "${file.path}" holds invalid token ${token}`, {
            ordinal,
          })
        }
        previous = token
        values[at] = token
        values[at + 1] = view.getUint32((at + 1) * VALUE_BYTES, true)
      }
    }
    return values
  }
}
