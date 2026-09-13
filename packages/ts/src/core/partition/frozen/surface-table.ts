import type { SerializedSurfaceForms } from '../../../types/internal'
import { createSurfaceRegistry, type SurfaceRegistryReader } from '../../surface-registry'

/**
 * This holds the surface forms of one frozen segment packed into three flat
 * arrays, so that a worker attaches them over shared memory and decodes them
 * only on its first suggestion query. Entry `i` spans `offsets[2i]` to
 * `offsets[2i + 1]` of the blob for its surface and `offsets[2i + 1]` to
 * `offsets[2i + 2]` for its index token, both UTF-8, and `counts[i]` holds
 * its occurrence count.
 *
 * @internal
 */
export interface SurfaceTableData {
  blob: Uint8Array
  offsets: Uint32Array
  counts: Uint32Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Packs surface forms into the flat table form.
 *
 * @param forms The surface forms, each holding a count and an index token.
 * @returns The table.
 *
 * @internal
 */
export function encodeSurfaceTable(forms: SerializedSurfaceForms): SurfaceTableData {
  const entries: Array<[Uint8Array, Uint8Array, number]> = []
  let blobLength = 0
  for (const surface of Object.keys(forms)) {
    const value = forms[surface]
    if (!Array.isArray(value)) continue
    const surfaceBytes = encoder.encode(surface)
    const tokenBytes = encoder.encode(value[1])
    entries.push([surfaceBytes, tokenBytes, value[0]])
    blobLength += surfaceBytes.length + tokenBytes.length
  }
  const blob = new Uint8Array(blobLength)
  const offsets = new Uint32Array(entries.length * 2 + 1)
  const counts = new Uint32Array(entries.length)
  let cursor = 0
  for (let i = 0; i < entries.length; i++) {
    const [surfaceBytes, tokenBytes, count] = entries[i]
    blob.set(surfaceBytes, cursor)
    cursor += surfaceBytes.length
    offsets[2 * i + 1] = cursor
    blob.set(tokenBytes, cursor)
    cursor += tokenBytes.length
    offsets[2 * i + 2] = cursor
    counts[i] = count
  }
  return { blob, offsets, counts }
}

/**
 * Reads surface forms back out of a table.
 *
 * @param table The table to read.
 * @returns The surface forms.
 *
 * @internal
 */
export function decodeSurfaceTable(table: SurfaceTableData): SerializedSurfaceForms {
  const forms: SerializedSurfaceForms = Object.create(null)
  for (let i = 0; i < table.counts.length; i++) {
    const surface = decoder.decode(table.blob.subarray(table.offsets[2 * i], table.offsets[2 * i + 1]))
    const token = decoder.decode(table.blob.subarray(table.offsets[2 * i + 1], table.offsets[2 * i + 2]))
    forms[surface] = [table.counts[i], token]
  }
  return forms
}

/**
 * Builds a surface reader that loads its forms on the first read, so a
 * thread that never answers a suggestion query never decodes them.
 *
 * @param load Produces the forms, or null where the segment holds none.
 * @returns The reader.
 *
 * @internal
 */
export function createLazySurfaceReader(load: () => SerializedSurfaceForms | null): SurfaceRegistryReader {
  let registry: SurfaceRegistryReader | null = null

  function loaded(): SurfaceRegistryReader {
    if (registry === null) {
      const built = createSurfaceRegistry()
      const forms = load()
      if (forms !== null) built.deserialize(forms)
      registry = built
    }
    return registry
  }

  return {
    candidatesForPrefix: prefix => loaded().candidatesForPrefix(prefix),
    stemChangedTotalFor: token => loaded().stemChangedTotalFor(token),
    size: () => loaded().size(),
    serialize: () => loaded().serialize(),
  }
}
