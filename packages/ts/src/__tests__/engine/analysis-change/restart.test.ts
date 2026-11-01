import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import { createMemoryPersistence } from '../../../persistence/memory'
import { readMetadataEnvelope, writeMetadataEnvelope } from '../../../serialization/envelope'
import type { NarsilConfig } from '../../../types/config'
import { waitFor } from '../../server/helpers'
import {
  allHitsOf,
  ChangeOracle,
  DASHES_SETTINGS,
  DASHES_TOKENIZER,
  OLD_SETTINGS,
  type OracleSettings,
  PLAIN_LANGUAGE,
  PROBES,
  registerFixtures,
  seededRandom,
  sentence,
} from './oracle'

const DOCUMENTS = 3_000
const CONFIG = { schema: { title: 'string' as const }, language: PLAIN_LANGUAGE }

async function expectMatches(engine: Narsil, oracle: ChangeOracle, settings: OracleSettings): Promise<void> {
  for (const probe of PROBES) {
    expect({ probe, hits: await allHitsOf(engine, 'prose', probe) }).toEqual({
      probe,
      hits: oracle.matches(probe, settings),
    })
  }
}

function withoutTheLock(source: string): boolean {
  return basename(source) !== '.narsil.lock'
}

describe('a restart during an analysis change', () => {
  let dir: string
  let frozen: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    registerFixtures()
    dir = await mkdtemp(join(tmpdir(), 'narsil-change-restart-'))
    frozen = `${dir}-frozen`
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
    await rm(frozen, { recursive: true, force: true })
  })

  function openConfig(): NarsilConfig {
    return { durability: { directory: dir }, workers: { enabled: false } }
  }

  async function written(oracle: ChangeOracle): Promise<Narsil> {
    const opened = await createNarsil(openConfig())
    await opened.createIndex('prose', CONFIG)
    const random = seededRandom(19)
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    for (const document of documents) oracle.write(document.id, document.title)
    await opened.insertBatch('prose', documents)
    await opened.checkpoint('prose')
    return opened
  }

  async function changedWithFrozenDirectory(oracle: ChangeOracle): Promise<void> {
    const opened = await written(oracle)
    opened.on('analysisRebuild', event => {
      if (event.status === 'started') cpSync(dir, frozen, { recursive: true, filter: withoutTheLock })
    })
    await opened.changeAnalysis('prose', { tokenizer: DASHES_TOKENIZER })
    await opened.shutdown()
  }

  async function restoreFrozen(): Promise<void> {
    await rm(dir, { recursive: true, force: true })
    cpSync(frozen, dir, { recursive: true })
  }

  function metaPath(root: string): string {
    return join(root, 'prose', 'meta')
  }

  it('finishes the change after a crash before the switch', async () => {
    const oracle = new ChangeOracle()
    await changedWithFrozenDirectory(oracle)
    await restoreFrozen()
    engine = await createNarsil(openConfig())
    const opened = engine
    await waitFor(async () => {
      const hits = await allHitsOf(opened, 'prose', 'wall')
      return hits.join('\n') === oracle.matches('wall', DASHES_SETTINGS).join('\n')
    })
    await expectMatches(engine, oracle, DASHES_SETTINGS)
  })

  it('reads the new terms under the new settings after a crash between the manifest and the metadata', async () => {
    const oracle = new ChangeOracle()
    await changedWithFrozenDirectory(oracle)
    expect(existsSync(metaPath(frozen))).toBe(true)
    writeFileSync(metaPath(dir), readFileSync(metaPath(frozen)))
    engine = await createNarsil(openConfig())
    await expectMatches(engine, oracle, DASHES_SETTINGS)
    await engine.shutdown()
    engine = await createNarsil(openConfig())
    await expectMatches(engine, oracle, DASHES_SETTINGS)
  })

  it('refuses to open saved terms from a generation that the metadata does not record', async () => {
    const oracle = new ChangeOracle()
    await changedWithFrozenDirectory(oracle)
    const { metadata } = await readMetadataEnvelope(new Uint8Array(readFileSync(metaPath(frozen))))
    const { pendingAnalysis: _pending, ...withNoPending } = metadata
    writeFileSync(metaPath(dir), await writeMetadataEnvelope(withNoPending, { checksum: true }))
    const refused = await createNarsil(openConfig()).catch(error => error)
    expect(refused).toBeInstanceOf(NarsilError)
    expect(refused.code).toBe(ErrorCodes.CONFIG_INVALID)
  })

  it('keeps serving and keeps the change when its tokeniser is missing after a restart', async () => {
    const oracle = new ChangeOracle()
    await changedWithFrozenDirectory(oracle)
    await restoreFrozen()
    const { metadata } = await readMetadataEnvelope(new Uint8Array(readFileSync(metaPath(dir))))
    const pending = metadata.pendingAnalysis
    expect(pending).toBeDefined()
    if (pending === undefined) return
    const withMissingName = { ...metadata, pendingAnalysis: { ...pending, tokenizer: 'never-registered-tokenizer' } }
    writeFileSync(metaPath(dir), await writeMetadataEnvelope(withMissingName, { checksum: true }))

    engine = await createNarsil(openConfig())
    await expectMatches(engine, oracle, OLD_SETTINGS)
    await engine.shutdown()

    const { metadata: kept } = await readMetadataEnvelope(new Uint8Array(readFileSync(metaPath(dir))))
    expect(kept.pendingAnalysis?.tokenizer).toBe('never-registered-tokenizer')
    engine = await createNarsil(openConfig())
    await expectMatches(engine, oracle, OLD_SETTINGS)
  })

  it('reads every acknowledged write after a checkpoint and a restart that follow the switch', async () => {
    const oracle = new ChangeOracle()
    const opened = await written(oracle)
    await opened.changeAnalysis('prose', { tokenizer: DASHES_TOKENIZER })
    await opened.insert('prose', { title: 'sea-wall' }, 'after-switch')
    oracle.write('after-switch', 'sea-wall')
    await opened.remove('prose', 'doc-0')
    oracle.remove('doc-0')
    await opened.checkpoint('prose')
    await opened.insert('prose', { title: 'stone-river' }, 'after-checkpoint')
    oracle.write('after-checkpoint', 'stone-river')
    await opened.shutdown()
    engine = await createNarsil(openConfig())
    await expectMatches(engine, oracle, DASHES_SETTINGS)
  })

  it('answers under the new settings on the snapshot tier after a restart', async () => {
    const persistence = createMemoryPersistence()
    const oracle = new ChangeOracle()
    const opened = await createNarsil({ persistence, workers: { enabled: false } })
    await opened.createIndex('prose', CONFIG)
    await opened.insert('prose', { title: 'sea-wall river' }, 'first')
    oracle.write('first', 'sea-wall river')
    await opened.changeAnalysis('prose', { tokenizer: DASHES_TOKENIZER })
    await expectMatches(opened, oracle, DASHES_SETTINGS)
    await opened.shutdown()
    engine = await createNarsil({ persistence, workers: { enabled: false } })
    await expectMatches(engine, oracle, DASHES_SETTINGS)
  })
})
