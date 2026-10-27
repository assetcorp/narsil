import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readMetadataEnvelope, writeMetadataEnvelope } from '../../../serialization/envelope'

export async function stripRecordedRevision(directory: string, indexName: string): Promise<void> {
  const metaPath = join(directory, indexName, 'meta')
  const { metadata } = await readMetadataEnvelope(new Uint8Array(await readFile(metaPath)))
  const { analysisRevision: _recorded, ...writtenBeforeTheField } = metadata
  await writeFile(metaPath, await writeMetadataEnvelope(writtenBeforeTheField, { checksum: true }))
}
