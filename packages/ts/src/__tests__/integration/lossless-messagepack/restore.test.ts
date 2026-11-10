import { expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil } from '../../../narsil'
import { bytesOf, readTar, rewriteFiles, writeTar } from '../../e2e/portability/archive-oracle'

it('refuses prototype keys in a snapshot containing strings with a byte order mark and preserves the live index', async () => {
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    await engine.createIndex('records', { schema: { title: 'string' } })
    await engine.insert('records', { title: 'catalogue', value: 'retained' }, 'record')
    const entries = readTar(await bytesOf(await engine.snapshot('records')))
    for (const nested of [false, true]) {
      let changed = 0
      const hostile = rewriteFiles(entries, (payload, name) => {
        if (!name.startsWith('segments/')) return false
        const value = { ['__proto__']: { polluted: true }, text: `\ufeff${'x'.repeat(198)}` }
        if (nested) payload.extra = [{ value }]
        else Object.defineProperties(payload, Object.getOwnPropertyDescriptors(value))
        changed++
        return true
      })
      expect(changed).toBeGreaterThan(0)
      await expect(engine.restore('records', writeTar(hostile))).rejects.toMatchObject({
        code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
      })
      expect(await engine.get('records', 'record')).toEqual({ title: 'catalogue', value: 'retained' })
      expect((await engine.query('records', { term: 'catalogue' })).hits.map(hit => hit.id)).toEqual(['record'])
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    }
  } finally {
    await engine.shutdown()
  }
})
