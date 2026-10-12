import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNarsil, type Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import type { AnyDocument, IndexConfig } from '../../../types/schema'

export const CATALOG_CONFIG: IndexConfig = {
  schema: { title: 'string', body: 'string', price: 'number', inStock: 'boolean', category: 'enum', tags: 'string[]' },
  language: 'english',
}

const WORDS = ['harbour', 'lantern', 'ferry', 'quay', 'slipway', 'beacon', 'tide', 'anchor']
const CATEGORIES = ['tools', 'garden', 'kitchen']

export function catalogDocument(n: number): AnyDocument {
  return {
    title: `${WORDS[n % WORDS.length]} ${WORDS[(n * 3) % WORDS.length]} item ${n}`,
    body: `The ${WORDS[(n * 5) % WORDS.length]} stands by the ${WORDS[(n * 7) % WORDS.length]} number ${n}`,
    price: ((n * 37) % 500) + 0.25,
    inStock: n % 3 !== 0,
    category: CATEGORIES[n % CATEGORIES.length],
    tags: [WORDS[n % 4], `tag-${n % 5}`],
  }
}

export function catalogOf(count: number, start = 0): Map<string, AnyDocument> {
  const documents = new Map<string, AnyDocument>()
  for (let n = start; n < start + count; n++) documents.set(`doc-${String(n).padStart(4, '0')}`, catalogDocument(n))
  return documents
}

export async function insertCatalog(engine: Narsil, indexName: string, documents: Map<string, AnyDocument>) {
  const batch = [...documents].map(([id, document]) => ({ id, ...document }))
  const result = await engine.insertBatch(indexName, batch)
  if (result.failed.length > 0) throw new Error(`the engine refused ${result.failed.length} documents`)
}

export function storedForm(documents: Map<string, AnyDocument>): Map<string, AnyDocument> {
  return new Map([...documents].map(([id, document]) => [id, { id, ...document }]))
}

export async function documentsOf(engine: Narsil, indexName: string, ids: Iterable<string>) {
  const found = new Map<string, AnyDocument | undefined>()
  for (const id of ids) found.set(id, await engine.get(indexName, id))
  return found
}

export interface TemporaryRoots {
  make(prefix: string): Promise<string>
  removeAll(): Promise<void>
}

export function temporaryRoots(): TemporaryRoots {
  const roots: string[] = []
  return {
    async make(prefix) {
      const root = await mkdtemp(join(tmpdir(), prefix))
      roots.push(root)
      return root
    },
    async removeAll() {
      for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
    },
  }
}

export interface EngineKind {
  name: string
  open(roots: TemporaryRoots): Promise<{ engine: Narsil; reopen(): Promise<Narsil> }>
}

const NO_WORKERS: NarsilConfig = { workers: { enabled: false } }

export const ENGINE_KINDS: EngineKind[] = [
  {
    name: 'an engine in memory',
    async open() {
      const engine = await createNarsil(NO_WORKERS)
      return { engine, reopen: async () => engine }
    },
  },
  {
    name: 'an engine with a write-ahead log',
    async open(roots) {
      const directory = await roots.make('narsil-portability-wal-')
      const config: NarsilConfig = { ...NO_WORKERS, durability: { directory } }
      return { engine: await createNarsil(config), reopen: () => createNarsil(config) }
    },
  },
]
