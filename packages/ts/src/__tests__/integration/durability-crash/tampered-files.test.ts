import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NarsilError } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'

const CHECKPOINTED_MOVIES = 40
const LOGGED_MOVIES = 20
const POSITIONS_IN_EACH_FILE = 6
const SCHEMA = { schema: { title: 'string', year: 'number' }, language: 'english' } as const

function movie(position: number): { title: string; year: number } {
  return { title: `Film number ${position}`, year: 1950 + position }
}

async function everyFile(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await everyFile(path)))
    else files.push(path)
  }
  return files
}

function positionsIn(size: number): number[] {
  const positions = new Set([0, size - 1])
  for (let step = 1; step < POSITIONS_IN_EACH_FILE - 1; step++) {
    positions.add(Math.floor((size * step) / (POSITIONS_IN_EACH_FILE - 1)))
  }
  return [...positions]
}

async function expectRefusalOrWhatWasWritten(open: () => Promise<Narsil>, label: string): Promise<void> {
  let narsil: Narsil | null = null
  try {
    narsil = await open()
    let missingFrom = Number.POSITIVE_INFINITY
    for (let position = 0; position < CHECKPOINTED_MOVIES + LOGGED_MOVIES; position++) {
      const stored = await narsil.get('movies', `m${position}`)
      if (stored === undefined) {
        missingFrom = Math.min(missingFrom, position)
        continue
      }
      expect(position, `${label} kept m${position} after losing m${missingFrom}`).toBeLessThan(missingFrom)
      expect(stored, `${label} changed m${position}`).toEqual(movie(position))
    }
    const kept = Math.min(missingFrom, CHECKPOINTED_MOVIES + LOGGED_MOVIES)
    expect(await narsil.countDocuments('movies'), label).toBe(kept)
  } catch (error) {
    if (!(error instanceof NarsilError) && !String(error).includes('AssertionError')) {
      throw new Error(`${label} failed without a NarsilError: ${String(error)}`)
    }
    if (!(error instanceof NarsilError)) throw error
  } finally {
    await narsil?.shutdown().catch(() => undefined)
  }
}

describe('saved files that somebody or something has changed', { timeout: 120_000 }, () => {
  let pristine: string
  let snapshot: Uint8Array

  beforeAll(async () => {
    pristine = await mkdtemp(join(tmpdir(), 'narsil-tampered-'))
    const narsil = await createNarsil({
      durability: { directory: pristine, tier: 'wal', mode: 'sync' },
      workers: { enabled: false },
    })
    await narsil.createIndex('movies', SCHEMA)
    for (let position = 0; position < CHECKPOINTED_MOVIES; position++) {
      await narsil.insert('movies', movie(position), `m${position}`)
    }
    await narsil.checkpoint('movies')
    for (let position = CHECKPOINTED_MOVIES; position < CHECKPOINTED_MOVIES + LOGGED_MOVIES; position++) {
      await narsil.insert('movies', movie(position), `m${position}`)
    }
    snapshot = new Uint8Array(await new Response(await narsil.snapshot('movies')).arrayBuffer())
    await narsil.shutdown()
  })

  afterAll(async () => {
    await rm(pristine, { recursive: true, force: true })
  })

  it('refuses a durable directory with one changed byte, or answers with an unchanged prefix of the writes', async () => {
    const files = (await everyFile(pristine)).filter(file => !file.endsWith('.lock'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const { size } = await stat(file)
      if (size === 0) continue
      for (const position of positionsIn(size)) {
        const copy = await mkdtemp(join(tmpdir(), 'narsil-tampered-copy-'))
        try {
          await cp(pristine, copy, { recursive: true })
          const target = join(copy, relative(pristine, file))
          const bytes = await readFile(target)
          bytes[position] ^= 0xff
          await writeFile(target, bytes)
          await expectRefusalOrWhatWasWritten(
            () => createNarsil({ durability: { directory: copy, tier: 'wal' }, workers: { enabled: false } }),
            `${relative(pristine, file)} with byte ${position} changed`,
          )
        } finally {
          await rm(copy, { recursive: true, force: true })
        }
      }
    }
  })

  it('refuses a durable directory with a shortened file, or answers with an unchanged prefix of the writes', async () => {
    const files = (await everyFile(pristine)).filter(file => !file.endsWith('.lock'))
    for (const file of files) {
      const { size } = await stat(file)
      if (size === 0) continue
      for (const kept of [0, 1, Math.floor(size / 2), size - 1]) {
        const copy = await mkdtemp(join(tmpdir(), 'narsil-tampered-copy-'))
        try {
          await cp(pristine, copy, { recursive: true })
          const target = join(copy, relative(pristine, file))
          await writeFile(target, (await readFile(target)).subarray(0, kept))
          await expectRefusalOrWhatWasWritten(
            () => createNarsil({ durability: { directory: copy, tier: 'wal' }, workers: { enabled: false } }),
            `${relative(pristine, file)} cut to ${kept} bytes`,
          )
        } finally {
          await rm(copy, { recursive: true, force: true })
        }
      }
    }
  })

  it('keeps what the index held when it refuses a damaged snapshot, and restores only unchanged documents', async () => {
    const damaged: Array<[string, Uint8Array]> = [
      ['the last byte gone', snapshot.subarray(0, snapshot.length - 1)],
      ['half the file gone', snapshot.subarray(0, Math.floor(snapshot.length / 2))],
      ['nothing in it', new Uint8Array(0)],
    ]
    for (const position of positionsIn(snapshot.length)) {
      const bytes = Uint8Array.from(snapshot)
      bytes[position] ^= 0xff
      damaged.push([`byte ${position} of ${snapshot.length} changed`, bytes])
    }

    for (const [label, bytes] of damaged) {
      const narsil = await createNarsil({ workers: { enabled: false } })
      try {
        await narsil.createIndex('movies', SCHEMA)
        await narsil.insert('movies', { title: 'Already here', year: 2000 }, 'held')
        const refusal = await narsil.restore('movies', bytes).then(
          () => null,
          (error: unknown) => error,
        )
        if (refusal === null) {
          for (let movieAt = 0; movieAt < CHECKPOINTED_MOVIES + LOGGED_MOVIES; movieAt++) {
            expect(await narsil.get('movies', `m${movieAt}`), label).toEqual(movie(movieAt))
          }
        } else {
          expect(refusal, label).toBeInstanceOf(NarsilError)
          expect(await narsil.get('movies', 'held'), label).toEqual({ title: 'Already here', year: 2000 })
        }
      } finally {
        await narsil.shutdown()
      }
    }
  })
})
