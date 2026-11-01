import { decodeEveryStoredDocument } from '../../core/partition/frozen/document-source'
import { parseVectorDimension } from '../../core/partition/utils'
import { ErrorCodes, NarsilError } from '../../errors'
import type { SegmentManifest } from '../durability/segment/manifest'
import { readSegmentFile } from '../durability/segment/segment-file'
import type { CheckpointStore } from '../durability/segment/store'
import { readGraphParts, readVectorFile } from '../durability/segment/vector-load'

function requireDimension(key: string, found: number, expected: number | null): void {
  if (expected === found) return
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_LOAD_FAILED,
    `The vector file "${key}" holds vectors of ${found} dimensions where the schema gives ${String(expected)}`,
    { key, found, expected },
  )
}

function requireSchemaOfManifest(key: string, schema: Record<string, string>, manifest: SegmentManifest): void {
  for (const [field, type] of Object.entries(schema)) {
    const listed = manifest.schema[field]
    if (listed === undefined || listed === type) continue
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `The segment "${key}" gives field "${field}" the type "${type}", while the manifest gives it "${listed}"`,
      { key, field },
    )
  }
}

export async function validateStagedCheckpoint(store: CheckpointStore, manifest: SegmentManifest): Promise<void> {
  for (const partition of manifest.partitions) {
    for (const ref of partition.segments) {
      const { directory } = store
      if (directory !== undefined) {
        const { checkPagedSegmentFully, isPagedSegmentFile } = await import('../paged/module')
        if (await isPagedSegmentFile(directory, ref.key)) {
          requireSchemaOfManifest(ref.key, await checkPagedSegmentFully(directory, ref), manifest)
          continue
        }
      }
      const contents = await readSegmentFile(store, ref)
      requireSchemaOfManifest(ref.key, contents.schema, manifest)
      decodeEveryStoredDocument(contents.arrays.documentTable)
    }
  }
  for (const field of manifest.vectors) {
    const fieldType = manifest.schema[field.fieldPath]
    const dimension = fieldType === undefined ? null : parseVectorDimension(fieldType)
    for (const file of field.files) {
      const { payload } = await readVectorFile(store, file, field.fieldPath)
      requireDimension(file.key, payload.dimension, dimension)
    }
    await readGraphParts(store, field)
  }
}
