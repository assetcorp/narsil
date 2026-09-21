import type { SerializedSurfaceForms } from '../../../types/internal'
import { createSurfaceRegistry, type SurfaceRegistryReader } from '../../surface-registry'
import { encodeStringBlob } from './string-blob'

export interface SurfaceTableData {
  blob: Uint8Array
  offsets: Uint32Array
  counts: Uint32Array
}

const decoder = new TextDecoder()

export function encodeSurfaceTable(forms: SerializedSurfaceForms): SurfaceTableData {
  const surfaceThenToken: string[] = []
  const entryCounts: number[] = []
  for (const surface of Object.keys(forms)) {
    const value = forms[surface]
    if (!Array.isArray(value)) continue
    surfaceThenToken.push(surface, value[1])
    entryCounts.push(value[0])
  }
  const { blob, offsets } = encodeStringBlob(surfaceThenToken)
  return { blob, offsets, counts: Uint32Array.from(entryCounts) }
}

export function decodeSurfaceTable(table: SurfaceTableData): SerializedSurfaceForms {
  const forms: SerializedSurfaceForms = Object.create(null)
  for (let i = 0; i < table.counts.length; i++) {
    const surface = decoder.decode(table.blob.subarray(table.offsets[2 * i], table.offsets[2 * i + 1]))
    const token = decoder.decode(table.blob.subarray(table.offsets[2 * i + 1], table.offsets[2 * i + 2]))
    forms[surface] = [table.counts[i], token]
  }
  return forms
}

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
