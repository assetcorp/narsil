import { renameSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { registerTokenizer } from '../../analysis/registry'
import { createNarsil } from '../../narsil'

it.each([
  'insert',
  'update',
  'remove',
  'repeated updates',
] as const)('restores a refused durable %s without another analyser call', async operation => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-analysis-rollback-'))
  const moved = `${directory}-moved`
  const tokenizer = `durable-analysis-${operation}`
  let trigger: string | undefined
  let movedDirectory = false
  const calls: string[] = []
  registerTokenizer(tokenizer, {
    tokenize(text) {
      calls.push(text)
      if (movedDirectory) throw new Error('The analyser refuses another call')
      if (text === trigger) {
        renameSync(directory, moved)
        movedDirectory = true
      }
      return text.split(' ').map((token, position) => ({ token, position }))
    },
  })
  const engine = await createNarsil({ durability: { directory, mode: 'sync' }, workers: { enabled: false } })
  const original = { title: 'river', rating: 7 }
  try {
    await engine.createIndex('readings', { schema: { title: 'string', rating: 'number' }, tokenizer })
    if (operation !== 'insert') await engine.insert('readings', original, 'reading')
    calls.length = 0
    trigger = operation === 'remove' ? 'river' : 'forest'
    if (operation === 'insert') {
      await expect(engine.insert('readings', { title: 'forest', rating: 99 }, 'reading')).rejects.toMatchObject({
        code: 'PERSISTENCE_SAVE_FAILED',
      })
      expect(calls).toEqual(['forest'])
      expect(await engine.get('readings', 'reading')).toBeUndefined()
    } else if (operation === 'remove') {
      await expect(engine.remove('readings', 'reading')).rejects.toMatchObject({ code: 'PERSISTENCE_SAVE_FAILED' })
      expect(calls).toEqual(['river'])
    } else if (operation === 'update') {
      await expect(engine.update('readings', 'reading', { title: 'forest', rating: 99 })).rejects.toMatchObject({
        code: 'PERSISTENCE_SAVE_FAILED',
      })
      expect(calls).toEqual(['river', 'forest'])
    } else {
      const result = await engine.updateBatch('readings', [
        { docId: 'reading', document: { title: 'lake', rating: 12 } },
        { docId: 'reading', document: { title: 'forest', rating: 99 } },
      ])
      expect(result.succeeded).toEqual([])
      expect(result.failed.map(entry => entry.error.code)).toEqual([
        'PERSISTENCE_SAVE_FAILED',
        'PERSISTENCE_SAVE_FAILED',
      ])
      expect(calls).toEqual(['river', 'lake', 'lake', 'forest'])
    }
    if (operation !== 'insert') expect(await engine.get('readings', 'reading')).toEqual(original)
    expect(await engine.countDocuments('readings')).toBe(operation === 'insert' ? 0 : 1)
    movedDirectory = false
    trigger = undefined
    expect((await engine.query('readings', { term: 'forest lake' })).count).toBe(0)
    expect((await engine.query('readings', { term: 'river' })).count).toBe(operation === 'insert' ? 0 : 1)
    expect(engine.getStats('readings').heldSearchStates).toBe(0)
  } finally {
    await engine.shutdown().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
    await rm(moved, { recursive: true, force: true })
  }
})
