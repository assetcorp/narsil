import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'

async function checkDocuments(engine: Narsil): Promise<void> {
  expect(await engine.countDocuments('records')).toBe(5)
  for (const length of [0, 1, 197, 198, 65_536]) {
    const value = `\ufeff${'x'.repeat(length)}`
    const key = `\ufeff${'k'.repeat(length)}`
    const document = await engine.get('records', `record-${length}`)
    expect(document?.value).toBe(value)
    expect(document?.[key]).toBe(value)
    expect(document?.nested).toEqual([{ [key]: [value, '', null, false, 0] }])
    expect(document?.bytes).toEqual(new Uint8Array([0xef, 0xbb, 0xbf, 0, 255]))
    expect(document?.date).toEqual(new Date('2020-02-03T04:05:06.789Z'))
  }
  const projected = await engine.query('records', {
    term: 'catalogue',
    document: { include: ['value', 'nested'] },
    limit: 10,
  })
  expect(projected.hits).toHaveLength(5)
  for (const hit of projected.hits) {
    const length = Number(hit.id.slice('record-'.length))
    const value = `\ufeff${'x'.repeat(length)}`
    const key = `\ufeff${'k'.repeat(length)}`
    expect(hit.document).toEqual({ value, nested: [{ [key]: [value, '', null, false, 0] }] })
  }
}

it('preserves string content, binary fields, and dates through WAL recovery and vector checkpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-lossless-wal-'))
  let engine: Narsil | undefined
  const child = spawn(process.execPath, [fileURLToPath(new URL('./writer.mjs', import.meta.url)), directory], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  try {
    expect(await exited, stderr).toBe(0)
    expect(stdout).toContain('ACKED')
    engine = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    await checkDocuments(engine)
    await engine.checkpoint('records')
    await checkDocuments(engine)
    await engine.shutdown()
    engine = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    await checkDocuments(engine)
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const hostile = { title: 'catalogue', value: `\ufeff${'x'.repeat(198)}`, nested: { [key]: { polluted: true } } }
      await expect(engine.insert('records', hostile, 'hostile')).rejects.toMatchObject({
        code: ErrorCodes.DOC_VALIDATION_FAILED,
      })
      expect(await engine.has('records', 'hostile')).toBe(false)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited.catch(() => undefined)
    await engine?.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
