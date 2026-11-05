import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SAMPLES_ROOT } from '../samples/catalog'
import { type CaseBuild, damagedCheckpoint } from './build'
import { baseFile, gzippedEnvelope } from './bytes'

const VECTOR_RULE = 'envelope.md#vector-file-payload'
const BACKUP_RULE = 'distribution/backups.md#backup-manifest'
const VECTOR_FILE = 'segments/vec-embedding-1l4nfg2-f0000000000000000'
const BACKUP_MANIFEST = 'files/backup-manifest/products.nrsl'

async function compressedVectorFile(name: string, indexName: string): Promise<CaseBuild> {
  const bytes = await gzippedEnvelope(await baseFile(indexName, VECTOR_FILE), name)
  return damagedCheckpoint(name, VECTOR_RULE, 'PERSISTENCE_LOAD_FAILED', indexName, { [VECTOR_FILE]: bytes })
}

export async function compressionCases(): Promise<CaseBuild[]> {
  const backup = new Uint8Array(await readFile(join(SAMPLES_ROOT, BACKUP_MANIFEST)))
  return [
    await compressedVectorFile('vector-file-compressed', 'products'),
    await compressedVectorFile('vector-file-compressed-on-disk', 'notes'),
    {
      open: 'backup',
      name: 'backup-manifest-compressed',
      rule: BACKUP_RULE,
      bytes: await gzippedEnvelope(backup, 'backup-manifest-compressed'),
      code: 'BACKUP_DAMAGED',
    },
  ]
}
