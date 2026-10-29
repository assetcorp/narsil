import type { NarsilError } from '../errors'
import type { Narsil } from '../types/engine'

export type WriteBlockLookup = (indexName: string) => Promise<NarsilError | null>

const writeBlockLookups = new WeakMap<object, WriteBlockLookup>()

export function bindWriteBlockLookup(owner: object, lookup: WriteBlockLookup): void {
  writeBlockLookups.set(owner, lookup)
}

export function writeBlockLookupOf(owner: object): WriteBlockLookup | undefined {
  return writeBlockLookups.get(owner)
}

export function bindEngineWriteBlock(engine: Narsil, owner: object): void {
  const lookup = writeBlockLookups.get(owner)
  if (lookup !== undefined) writeBlockLookups.set(engine, lookup)
}
