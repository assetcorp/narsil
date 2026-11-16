import { ErrorCodes, NarsilError } from '#platform/storage-host'
import type { DurableDirectory } from './durable-filesystem'

export async function writeIndexMetadataFile(
  directory: DurableDirectory,
  indexName: string,
  bytes: Uint8Array | readonly Uint8Array[],
): Promise<void> {
  try {
    await directory.atomicWrite(`${indexName}/meta`, bytes)
  } catch (error) {
    if (error instanceof NarsilError) throw error
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The engine cannot write the metadata of index "${indexName}" to the durability directory "${directory.root}"`,
      { indexName, directory: directory.root, cause: error instanceof Error ? error.message : String(error) },
    )
  }
}
