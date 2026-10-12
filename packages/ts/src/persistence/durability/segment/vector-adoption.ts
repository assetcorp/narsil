import type { VectorIndex } from '../../../vector/vector-index'
import type { CheckpointStore } from './store'
import type { VectorCheckpointLayout, VectorFieldWritten } from './vector-write'

export function recordWrittenVectors(
  vectorIndexes: Map<string, VectorIndex>,
  written: readonly VectorFieldWritten[],
): void {
  for (const field of written) {
    vectorIndexes.get(field.fieldPath)?.recordCheckpoint(field.plan, field.files)
  }
}

export async function adoptVectorLayouts(
  store: CheckpointStore,
  vectorIndexes: Map<string, VectorIndex>,
  layouts: readonly VectorCheckpointLayout[],
): Promise<void> {
  const pathOf = store.pathOf
  if (pathOf === undefined) return
  for (const layout of layouts) {
    const vecIndex = vectorIndexes.get(layout.fieldPath)
    if (vecIndex === undefined || vecIndex.storage !== 'disk') continue
    const path = await pathOf.call(store, layout.key)
    await vecIndex.adoptDiskLayout({ path, docIds: layout.docIds, vectorsOffset: layout.vectorsOffset })
  }
}

export async function garbageThatNoFieldStillReads(
  store: CheckpointStore,
  vectorIndexes: Map<string, VectorIndex>,
  keys: readonly string[],
): Promise<string[]> {
  const pathOf = store.pathOf
  if (pathOf === undefined) return [...keys]
  const read = new Set<string>()
  for (const vectorIndex of vectorIndexes.values()) {
    for (const path of vectorIndex.vectorFilesInUse()) read.add(path)
  }
  if (read.size === 0) return [...keys]
  const unread: string[] = []
  for (const key of keys) {
    if (!read.has(await pathOf.call(store, key))) unread.push(key)
  }
  return unread
}
