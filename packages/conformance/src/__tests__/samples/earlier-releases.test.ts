import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentDifference, type Json } from '../../forms/json'
import { SAMPLES_ROOT } from '../../samples/catalog'
import { readEarlierReleases, recoveredDocuments } from '../../samples/earlier'

const releases = await readEarlierReleases()

const RELEASE_TIME_EXPECTATIONS = [
  ['earlier-releases/0.3.0/wal-expected.json', 'earlier-releases/0.3.0/expected/checkpoint-products.json'],
  ['earlier-releases/0.3.0/wal-notes-expected.json', 'earlier-releases/0.3.0/expected/checkpoint-notes.json'],
  [
    'earlier-releases/0.3.0/snapshot-tier-expected.json',
    'earlier-releases/0.3.0/expected/snapshot-bundle-products.json',
  ],
  [
    'earlier-releases/0.3.0/snapshot-tier-expected.json',
    'earlier-releases/0.3.0/expected/index-snapshot-products.json',
  ],
] as const

async function jsonAt(path: string): Promise<Json> {
  return JSON.parse(await readFile(join(SAMPLES_ROOT, path), 'utf8'))
}

function withSinglePrecision(value: Json, key: string): Json {
  if (Array.isArray(value)) {
    return key === 'embedding' ? value.map(item => (typeof item === 'number' ? Math.fround(item) : item)) : value
  }
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, withSinglePrecision(item, field)]))
}

describe('files from earlier releases', () => {
  it.each(
    releases.map(release => [`${release.release} ${release.layout} ${release.path}`, release] as const),
  )('%s opens with every document it held', async (_name, release) => {
    const recovered = await recoveredDocuments(release)
    for (const [indexName, path] of Object.entries(release.indexes)) {
      const documents = recovered.get(indexName)
      expect(documents).toBeDefined()
      expect(contentDifference(await jsonAt(path), documents ?? null, '', { signedZero: false })).toBeNull()
    }
  })

  it.each(
    RELEASE_TIME_EXPECTATIONS,
  )('%s, written when the release came out, agrees with %s', async (releaseTime, expected) => {
    const recorded = withSinglePrecision(await jsonAt(releaseTime), '')
    expect(contentDifference(recorded, await jsonAt(expected), '', { signedZero: false })).toBeNull()
  })
})
