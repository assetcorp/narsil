import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resealed } from '../../../ts/src/__tests__/e2e/portability/archive-oracle.ts'

const [directory, indexName, listedDocCount] = process.argv.slice(2)
const manifestPath = join(directory, indexName, 'manifest')
let segments = 0
const sealed = resealed(new Uint8Array(await readFile(manifestPath)), manifest => {
  for (const partition of manifest.partitions) {
    for (const segment of partition.segments) {
      segment.docCount = Number(listedDocCount)
      segments++
    }
  }
  return manifest
})
if (segments === 0) throw new Error('the manifest lists no segment to rewrite')
await writeFile(manifestPath, sealed)
