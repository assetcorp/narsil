import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNarsil, type Narsil } from '../../../narsil'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import type { NarsilConfig } from '../../../types/config'
import type { AnyDocument } from '../../../types/schema'

export const SCHEMA = { body: 'string', group: 'enum', embedding: 'vector[8]' } as const
export const LIVE = 'live'
export const SOURCE = 'source'
export const OLD_COUNT = 3_000
export const NEW_COUNT = 2_000
export const TERM = 'lantern'

export interface Generation {
  documents: Map<string, AnyDocument>
  termHits: Set<string>
  filteredHits: Set<string>
  prefix: string
}

export function vectorOf(seed: number): number[] {
  return Array.from({ length: 8 }, (_, i) => Math.sin(seed * 7.3 + i * 1.7))
}

function generation(prefix: string, count: number, carriesTerm: (n: number) => boolean): Generation {
  const documents = new Map<string, AnyDocument>()
  const termHits = new Set<string>()
  const filteredHits = new Set<string>()
  for (let n = 0; n < count; n++) {
    const id = `${prefix}-${n}`
    const group = n % 2 === 0 ? 'even' : 'odd'
    const body = carriesTerm(n) ? `the ${TERM} by quay ${n}` : `the ferry by quay ${n}`
    documents.set(id, { body, group, embedding: vectorOf(n + prefix.length * 1_000) })
    if (carriesTerm(n)) {
      termHits.add(id)
      if (group === 'even') filteredHits.add(id)
    }
  }
  return { documents, termHits, filteredHits, prefix }
}

export const OLD = generation('old', OLD_COUNT, n => n % 3 === 0)
export const NEW = generation('new', NEW_COUNT, n => n % 5 === 0)

export function sameSet(found: readonly string[], expected: Set<string>): boolean {
  return found.length === expected.size && found.every(id => expected.has(id))
}

export async function fill(engine: Narsil, indexName: string, documents: Map<string, AnyDocument>): Promise<void> {
  await engine.createIndex(indexName, { schema: SCHEMA })
  const result = await engine.insertBatch(
    indexName,
    [...documents].map(([id, document]) => ({ id, ...document })),
  )
  if (result.failed.length > 0) throw new Error(`the engine refused ${result.failed.length} documents`)
}

export async function termHitsOf(engine: Narsil, indexName: string): Promise<string[]> {
  return (await engine.query(indexName, { term: TERM, limit: OLD_COUNT })).hits.map(hit => hit.id)
}

export async function holdsGeneration(engine: Narsil, indexName: string, expected: Generation): Promise<boolean> {
  if (!sameSet(await termHitsOf(engine, indexName), expected.termHits)) return false
  const sample = [...expected.documents].filter((_, n) => n % 97 === 0)
  for (const [id, document] of sample) {
    if ((await engine.get(indexName, id))?.body !== document.body) return false
  }
  return true
}

export interface Observed {
  rounds: number
  failures: string[]
  written: string[]
}

export interface HammerTarget {
  query(params: Record<string, unknown>): Promise<string[]>
  get(id: string): Promise<AnyDocument | undefined>
  insert(id: string, document: AnyDocument): Promise<void>
}

export function engineTarget(engine: Narsil, indexName: string): HammerTarget {
  return {
    query: async params => (await engine.query(indexName, params)).hits.map(hit => hit.id),
    get: id => engine.get(indexName, id),
    insert: async (id, document) => {
      await engine.insert(indexName, document, id)
    },
  }
}

function settledFlag(until: Promise<unknown>): () => boolean {
  let settled = false
  until.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  return () => settled
}

async function checkRound(target: HammerTarget, observed: Observed): Promise<void> {
  const record = (what: string, error: unknown): void => {
    observed.failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const ids = await target.query({ term: TERM, limit: OLD_COUNT })
    if (!sameSet(ids, OLD.termHits) && !sameSet(ids, NEW.termHits)) {
      observed.failures.push(`text query returned ${ids.length} hits, matching neither generation`)
    }
  } catch (error) {
    record('text query', error)
  }
  try {
    const ids = await target.query({ term: TERM, limit: OLD_COUNT, filters: { fields: { group: { eq: 'even' } } } })
    if (!sameSet(ids, OLD.filteredHits) && !sameSet(ids, NEW.filteredHits)) {
      observed.failures.push(`filtered query returned ${ids.length} hits, matching neither generation`)
    }
  } catch (error) {
    record('filtered query', error)
  }
  try {
    const ids = await target.query({ vector: { field: 'embedding', value: vectorOf(11) }, limit: 10 })
    const restored = ids.filter(id => !id.startsWith('write-'))
    const fromOne = restored.every(id => id.startsWith('old-')) || restored.every(id => id.startsWith('new-'))
    if (ids.length !== 10 || !fromOne) {
      observed.failures.push(`vector query returned ${ids.length} hits from mixed generations`)
    }
  } catch (error) {
    record('vector query', error)
  }
  try {
    const oldDocument = await target.get('old-9')
    const newDocument = await target.get('new-10')
    if (oldDocument !== undefined && oldDocument.body !== OLD.documents.get('old-9')?.body) {
      observed.failures.push('a get returned a document that neither generation holds')
    }
    if (newDocument !== undefined && newDocument.body !== NEW.documents.get('new-10')?.body) {
      observed.failures.push('a get returned a document that neither generation holds')
    }
    if (oldDocument === undefined && newDocument === undefined) {
      observed.failures.push('a get found the document of neither generation')
    }
  } catch (error) {
    record('get', error)
  }
  const id = `write-${observed.rounds}`
  try {
    await target.insert(id, { body: 'the beacon', group: 'odd', embedding: vectorOf(-observed.rounds) })
    observed.written.push(id)
  } catch (error) {
    record('insert', error)
  }
}

export async function hammer(target: HammerTarget, until: Promise<unknown>): Promise<Observed> {
  const settled = settledFlag(until)
  const observed: Observed = { rounds: 0, failures: [], written: [] }
  while (!settled()) {
    await new Promise(resolve => setImmediate(resolve))
    observed.rounds += 1
    await checkRound(target, observed)
  }
  return observed
}

export type EngineKind = 'memory' | 'wal' | 'snapshot'

export async function newDirectory(roots: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-restore-serving-'))
  roots.push(directory)
  return directory
}

export function configFor(kind: EngineKind, directory: string, workers: boolean): NarsilConfig {
  const config: NarsilConfig = workers ? {} : { workers: { enabled: false } }
  if (kind === 'wal') config.durability = { directory }
  if (kind === 'snapshot') {
    config.persistence = createFilesystemPersistence({ directory })
    config.durability = { tier: 'snapshot' }
  }
  return config
}

export async function openEngine(config: NarsilConfig, engines: Narsil[]): Promise<Narsil> {
  const engine = await createNarsil(config)
  engines.push(engine)
  return engine
}

export async function archiveBytes(engine: Narsil, indexName: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await engine.snapshot(indexName)).arrayBuffer())
}

const TAR_BLOCK = 512

function tarEntrySize(header: Uint8Array): number {
  const field = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0/g, '').trim()
  return Number.parseInt(field, 8)
}

function tarEntryName(header: Uint8Array): string {
  return new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/s, '')
}

export function corruptFirstSegmentBody(archive: Uint8Array): Uint8Array {
  const copy = archive.slice()
  let offset = 0
  while (offset + TAR_BLOCK <= copy.byteLength) {
    const header = copy.subarray(offset, offset + TAR_BLOCK)
    if (header.every(byte => byte === 0)) break
    const size = tarEntrySize(header)
    const body = offset + TAR_BLOCK
    if (tarEntryName(header).startsWith('segments/') && !tarEntryName(header).includes('vec-')) {
      copy[body + size - 1] ^= 0xff
      return copy
    }
    offset = body + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  throw new Error('the archive holds no text segment')
}
