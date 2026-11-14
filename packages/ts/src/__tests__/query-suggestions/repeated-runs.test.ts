import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import { querySuggestions } from '../../query-suggestions'
import type { PersistenceAdapter } from '../../types/adapters'
import type { NarsilConfig } from '../../types/config'
import type { Narsil } from '../../types/engine'

const KEY = new Uint8Array(32).fill(11)
const SOURCE = 'lighting'
const PHRASE = 'brass reading lamp'
const GROUP = 'shop-floor'
const FIRST_PEOPLE = ['person-1', 'person-2', 'person-3']
const RUNS = 4
const STEADY_PEOPLE = 10

function adapterThatLendsItsBytes(): PersistenceAdapter {
  const stored = new Map<string, Uint8Array>()
  return {
    async save(key, data) {
      stored.set(key, data.slice())
    },
    async load(key) {
      return stored.get(key) ?? null
    },
    async delete(key) {
      stored.delete(key)
    },
    async list(prefix) {
      return [...stored.keys()].filter(key => key.startsWith(prefix))
    },
  }
}

const ENGINES: Array<{ label: string; config: () => NarsilConfig }> = [
  { label: 'an engine with no durability', config: () => ({ querySuggestions: { key: KEY } }) },
  {
    label: 'an engine that saves to an adapter whose load returns the bytes that it holds',
    config: () => ({
      persistence: adapterThatLendsItsBytes(),
      durability: { tier: 'snapshot' },
      querySuggestions: { key: KEY },
    }),
  },
]

describe('popular query suggestions over repeated previews and builds', () => {
  let engine: Narsil | null = null

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
  })

  async function openSource(config: NarsilConfig): Promise<{
    running: Narsil
    suggestions: ReturnType<typeof querySuggestions>
    recordPerson: (person: string) => Promise<void>
  }> {
    const running = await createNarsil(config)
    engine = running
    await running.createIndex(SOURCE, { schema: { title: 'string' } })
    await running.insert(SOURCE, { title: PHRASE }, 'lamp-1')
    const suggestions = querySuggestions(running)
    await suggestions.updateSetting(SOURCE, {
      enabled: true,
      fields: ['title'],
      minPeople: 2,
      minResults: 1,
      schedule: 'off',
    })
    async function recordPerson(person: string): Promise<void> {
      expect(await suggestions.recordQuery(SOURCE, { query: PHRASE, person, group: GROUP })).toEqual({
        recorded: true,
        outcome: 'recorded',
      })
    }
    return { running, suggestions, recordPerson }
  }

  for (const { label, config } of ENGINES) {
    it(`answers previews and builds in a row with no new history between them on ${label}`, async () => {
      const { suggestions, recordPerson } = await openSource(config())
      for (let person = 1; person <= STEADY_PEOPLE; person++) await recordPerson(`steady-person-${person}`)
      const expected = [{ group: GROUP, query: PHRASE, count: STEADY_PEOPLE }]
      const calls: Array<'preview' | 'build'> = ['preview', 'preview', 'build', 'build', 'preview']
      for (const [at, call] of calls.entries()) {
        const step = `${call} at call ${at + 1}`
        if (call === 'preview') {
          expect((await suggestions.preview(SOURCE)).entries, step).toEqual(expected)
          continue
        }
        const build = await suggestions.build(SOURCE)
        expect(['completed', 'skipped'], `${step} reported ${build.status} with ${build.errorCode}`).toContain(
          build.status,
        )
        expect(build.errorCode, step).toBeNull()
      }
    })

    it(`answers every preview and build in a row on ${label}`, async () => {
      const { running, suggestions, recordPerson } = await openSource(config())
      for (const person of FIRST_PEOPLE) await recordPerson(person)

      for (let run = 1; run <= RUNS; run++) {
        const people = FIRST_PEOPLE.length + run - 1
        const expected = [{ group: GROUP, query: PHRASE, count: people }]
        expect((await suggestions.preview(SOURCE)).entries, `first preview of run ${run}`).toEqual(expected)
        expect((await suggestions.preview(SOURCE)).entries, `second preview of run ${run}`).toEqual(expected)
        const build = await suggestions.build(SOURCE)
        expect({ status: build.status, errorCode: build.errorCode }, `build of run ${run}`).toEqual({
          status: 'completed',
          errorCode: null,
        })
        expect(
          await running.get(`${SOURCE}.suggestions.${GROUP}`, PHRASE),
          `suggestion after run ${run}`,
        ).toMatchObject({
          query: PHRASE,
          count: people,
        })
        expect((await suggestions.preview(SOURCE)).entries, `preview after the build of run ${run}`).toEqual(expected)
        await recordPerson(`later-person-${run}`)
      }
    })
  }
})
