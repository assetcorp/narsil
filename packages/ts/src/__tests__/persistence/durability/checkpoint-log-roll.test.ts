import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import type { Narsil } from '../../../types/engine'
import type { IndexConfig, TextStorage } from '../../../types/schema'
import {
  type ArticleDocument,
  ArticleOracle,
  expectEngineMatchesOracle,
  randomArticle,
  seededRandom,
} from '../../integration/disk-backed/oracle'

const INDEX = 'articles'
const SEGMENT_NAME = /^\d{16}$/
const SEGMENT_HEADER_BYTES = 8
const LOCK_FILE = '.narsil.lock'
const BASE_DOCUMENTS = 300

function configOf(textStorage: TextStorage): IndexConfig {
  return {
    schema: { title: 'string', body: 'string', year: 'number' },
    textStorage,
    surfaceForms: true,
  }
}

function logDirectory(root: string): string {
  return join(root, INDEX, 'wal', '0')
}

async function logSegments(root: string): Promise<string[]> {
  const names = await readdir(logDirectory(root))
  return names.filter(name => SEGMENT_NAME.test(name)).sort()
}

async function copyAsACrash(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true })
  await rm(join(to, LOCK_FILE), { force: true })
}

async function copyLogFile(fromRoot: string, toRoot: string, name: string): Promise<void> {
  await writeFile(join(logDirectory(toRoot), name), await readFile(join(logDirectory(fromRoot), name)))
}

async function openEngine(root: string): Promise<Narsil> {
  return createNarsil({ durability: { directory: root }, workers: { enabled: false } })
}

async function insertInto(
  engine: Narsil,
  oracle: ArticleOracle,
  random: () => number,
  prefix: string,
  count: number,
): Promise<void> {
  for (let at = 0; at < count; at++) {
    const id = `${prefix}${at}`
    const document: ArticleDocument = randomArticle(random)
    await engine.insert(INDEX, document, id)
    oracle.set(id, document)
  }
}

async function expectTheCheckpointAloneHoldsTheOracle(root: string, scratch: string, oracle: ArticleOracle) {
  const withoutTheLog = join(scratch, 'without-the-log')
  await copyAsACrash(root, withoutTheLog)
  await rm(join(withoutTheLog, INDEX, 'wal'), { recursive: true, force: true })
  const engine = await openEngine(withoutTheLog)
  await expectEngineMatchesOracle(engine, INDEX, oracle)
  await engine.shutdown()
}

describe.each<TextStorage>(['memory', 'disk'])('the log roll at a checkpoint of a %s index', textStorage => {
  let scratch: string
  let root: string
  let oracle: ArticleOracle
  let random: () => number

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'narsil-log-roll-'))
    root = join(scratch, 'live')
    await mkdir(root)
    oracle = new ArticleOracle()
    random = seededRandom(95)
  })

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  async function loadedEngine(): Promise<Narsil> {
    const engine = await openEngine(root)
    await engine.createIndex(INDEX, configOf(textStorage))
    await insertInto(engine, oracle, random, 'base', BASE_DOCUMENTS)
    await engine.checkpoint(INDEX)
    return engine
  }

  it('leaves only an empty active segment after a checkpoint that covers every record', async () => {
    const engine = await loadedEngine()
    const segments = await logSegments(root)
    expect(segments).toHaveLength(1)
    const { size } = await stat(join(logDirectory(root), segments[0]))
    expect(size).toBe(SEGMENT_HEADER_BYTES)
    await engine.shutdown()
  })

  it('creates no file when a checkpoint finds no new writes', async () => {
    const engine = await loadedEngine()
    const before = await logSegments(root)
    await engine.checkpoint(INDEX)
    await engine.checkpoint(INDEX)
    expect(await logSegments(root)).toEqual(before)
    await engine.shutdown()
  })

  it('recovers every acknowledged write after a crash between the roll and the manifest commit', async () => {
    const engine = await loadedEngine()
    await insertInto(engine, oracle, random, 'late', 40)
    const beforeCheckpoint = join(scratch, 'before')
    await copyAsACrash(root, beforeCheckpoint)
    const sealed = await logSegments(beforeCheckpoint)
    await engine.checkpoint(INDEX)
    const rolled = await logSegments(root)
    expect(rolled).toHaveLength(1)
    expect(sealed).not.toContain(rolled[0])

    await copyLogFile(root, beforeCheckpoint, rolled[0])
    await copyLogFile(root, beforeCheckpoint, 'commit')
    await engine.shutdown()

    const recovered = await openEngine(beforeCheckpoint)
    await expectEngineMatchesOracle(recovered, INDEX, oracle)
    await insertInto(recovered, oracle, random, 'after', 10)
    await recovered.checkpoint(INDEX)
    await expectEngineMatchesOracle(recovered, INDEX, oracle)
    await recovered.shutdown()
    await expectTheCheckpointAloneHoldsTheOracle(beforeCheckpoint, scratch, oracle)
  }, 60_000)

  it('applies no record twice after a crash between the manifest commit and truncation', async () => {
    const engine = await loadedEngine()
    await insertInto(engine, oracle, random, 'late', 40)
    const updated = randomArticle(random)
    await engine.update(INDEX, 'base0', updated)
    oracle.set('base0', updated)
    await engine.remove(INDEX, 'base1')
    oracle.delete('base1')
    const beforeCheckpoint = join(scratch, 'before')
    await copyAsACrash(root, beforeCheckpoint)
    const sealed = await logSegments(beforeCheckpoint)
    await engine.checkpoint(INDEX)
    const crashed = join(scratch, 'crashed')
    await copyAsACrash(root, crashed)
    await engine.shutdown()
    for (const name of sealed) await copyLogFile(beforeCheckpoint, crashed, name)
    const leftBehind = await logSegments(crashed)
    expect(leftBehind.length).toBe(sealed.length + 1)

    const recovered = await openEngine(crashed)
    await expectEngineMatchesOracle(recovered, INDEX, oracle)
    await insertInto(recovered, oracle, random, 'after', 10)
    await recovered.checkpoint(INDEX)
    const afterNext = await logSegments(crashed)
    for (const name of sealed) expect(afterNext).not.toContain(name)
    await expectEngineMatchesOracle(recovered, INDEX, oracle)
    await recovered.shutdown()
  }, 60_000)

  it('keeps every write that arrives during a checkpoint', async () => {
    const engine = await loadedEngine()
    for (let round = 0; round < 6; round++) {
      const checkpoint = engine.checkpoint(INDEX)
      await insertInto(engine, oracle, random, `during${round}-`, 25)
      await checkpoint
    }
    const crashed = join(scratch, 'crashed')
    await copyAsACrash(root, crashed)
    await engine.shutdown()

    const recovered = await openEngine(crashed)
    await expectEngineMatchesOracle(recovered, INDEX, oracle)
    await recovered.checkpoint(INDEX)
    await recovered.shutdown()
    await expectTheCheckpointAloneHoldsTheOracle(crashed, scratch, oracle)
  }, 90_000)

  it('finds every record at a good checkpoint after one that failed reading the sealed segment', async () => {
    const engine = await loadedEngine()
    await insertInto(engine, oracle, random, 'late', 20)
    const [activeBeforeFailure] = await logSegments(root)
    const path = join(logDirectory(root), activeBeforeFailure)
    const intact = await readFile(path)
    const damaged = Buffer.from(intact)
    damaged[damaged.length - 3] ^= 0xff
    await writeFile(path, damaged)

    await expect(engine.checkpoint(INDEX)).rejects.toThrow()
    expect(await logSegments(root)).toHaveLength(2)
    await writeFile(path, intact)

    await insertInto(engine, oracle, random, 'next', 20)
    await engine.checkpoint(INDEX)
    await expectEngineMatchesOracle(engine, INDEX, oracle)
    const remaining = await logSegments(root)
    expect(remaining).toHaveLength(1)
    expect(remaining).not.toContain(activeBeforeFailure)
    const crashed = join(scratch, 'crashed')
    await copyAsACrash(root, crashed)
    await engine.shutdown()
    await expectTheCheckpointAloneHoldsTheOracle(crashed, scratch, oracle)
  }, 60_000)

  it('finds every record after a restart that follows a checkpoint the disk refused', async () => {
    const engine = await loadedEngine()
    await insertInto(engine, oracle, random, 'late', 20)
    const segments = join(root, INDEX, 'segments')
    const aside = join(scratch, 'segments-aside')
    await rename(segments, aside)
    await writeFile(segments, 'a file where the checkpoint expects a directory')

    await expect(engine.checkpoint(INDEX)).rejects.toThrow()
    const crashed = join(scratch, 'crashed')
    await copyAsACrash(root, crashed)
    await engine.shutdown().catch(() => undefined)
    await rm(join(crashed, INDEX, 'segments'))
    await cp(aside, join(crashed, INDEX, 'segments'), { recursive: true })
    expect(await logSegments(crashed)).toHaveLength(2)

    const recovered = await openEngine(crashed)
    await expectEngineMatchesOracle(recovered, INDEX, oracle)
    await insertInto(recovered, oracle, random, 'next', 20)
    await recovered.checkpoint(INDEX)
    await expectEngineMatchesOracle(recovered, INDEX, oracle)
    await recovered.shutdown()
    await expectTheCheckpointAloneHoldsTheOracle(crashed, scratch, oracle)
  }, 60_000)

  it('restarts on an empty active segment and keeps writing to it', async () => {
    const engine = await loadedEngine()
    const crashed = join(scratch, 'crashed')
    await copyAsACrash(root, crashed)
    await engine.shutdown()
    const [emptyActive] = await logSegments(crashed)

    const quiet = await openEngine(crashed)
    await expectEngineMatchesOracle(quiet, INDEX, oracle)
    await quiet.checkpoint(INDEX)
    expect(await logSegments(crashed)).toEqual([emptyActive])
    await quiet.shutdown()

    const writing = await openEngine(crashed)
    await insertInto(writing, oracle, random, 'after', 15)
    const again = join(scratch, 'again')
    await copyAsACrash(crashed, again)
    await writing.shutdown()
    expect(await logSegments(again)).toEqual([emptyActive])

    const recovered = await openEngine(again)
    await expectEngineMatchesOracle(recovered, INDEX, oracle)
    await recovered.shutdown()
  }, 60_000)
})
