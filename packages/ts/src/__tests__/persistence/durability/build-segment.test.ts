import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { getLanguage } from '../../../languages/registry'
import { buildSegmentFromEntries } from '../../../persistence/durability/segment/build-segment'
import type { IndexConfig } from '../../../types/schema'

const CONFIG: IndexConfig = {
  schema: { title: 'string', year: 'number', embedding: 'vector[4]' },
  language: 'english',
}

function indexEntry(seqNo: number, document: Record<string, unknown>): ReplicationLogEntry {
  return buildEntry({
    seqNo,
    primaryTerm: 1,
    operation: 'INDEX',
    partitionId: 0,
    indexName: 'papers',
    documentId: `p${seqNo}`,
    document: encode(document),
  })
}

async function* inOrder(entries: ReplicationLogEntry[]): AsyncGenerator<ReplicationLogEntry> {
  yield* entries
}

async function segmentOf(entries: ReplicationLogEntry[]): Promise<Uint8Array | undefined> {
  const built = await buildSegmentFromEntries({
    indexName: 'papers',
    config: CONFIG,
    language: getLanguage('english'),
    vectorFieldPaths: new Set(['embedding']),
    entries: inOrder(entries),
  })
  return built?.payload
}

describe('a document segment built from the log', () => {
  it('holds the same bytes whether or not the logged documents carry their vectors', async () => {
    const titles = ['harbour lights', 'night ferry', 'salt and rope']
    const withVectors = titles.map((title, i) =>
      indexEntry(i + 1, { title, year: 1990 + i, embedding: [i + 0.5, i + 1.5, i + 2.5, i + 3.5] }),
    )
    const withoutVectors = titles.map((title, i) => indexEntry(i + 1, { title, year: 1990 + i }))

    const segment = await segmentOf(withVectors)

    expect(segment).toBeDefined()
    expect(segment).toEqual(await segmentOf(withoutVectors))
  })
})
