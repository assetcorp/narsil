import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createPlacesEmbedding } from '../src/worker/local-embedding.ts'
import {
  PLACES_EMBEDDING_DIMENSIONS,
  PLACES_VECTOR_FILE,
  VECTOR_FILE_HEADER_BYTES,
} from '../src/worker/local-models.ts'

const EMBED_BATCH_SIZE = 64

interface Place {
  id: string
  summary: string
}

const placesDirectory = path.resolve(import.meta.dirname, '../../../../../data/processed/places')

async function main(): Promise<void> {
  const places = JSON.parse(await readFile(path.join(placesDirectory, 'places.json'), 'utf-8')) as Place[]
  const embedding = createPlacesEmbedding()

  const output = Buffer.alloc(VECTOR_FILE_HEADER_BYTES + places.length * PLACES_EMBEDDING_DIMENSIONS * 4)
  output.writeUInt32LE(places.length, 0)
  output.writeUInt32LE(PLACES_EMBEDDING_DIMENSIONS, 4)

  let offset = VECTOR_FILE_HEADER_BYTES
  for (let start = 0; start < places.length; start += EMBED_BATCH_SIZE) {
    const batch = places.slice(start, start + EMBED_BATCH_SIZE)
    const vectors = await embedding.embedBatch(
      batch.map(place => place.summary),
      'document',
    )
    for (const vector of vectors) {
      for (const value of vector) {
        output.writeFloatLE(value, offset)
        offset += 4
      }
    }
  }

  await embedding.shutdown()
  await writeFile(path.join(placesDirectory, PLACES_VECTOR_FILE), output)
  console.log(`Wrote ${places.length} vectors of ${PLACES_EMBEDDING_DIMENSIONS} numbers to ${PLACES_VECTOR_FILE}`)
}

await main()
