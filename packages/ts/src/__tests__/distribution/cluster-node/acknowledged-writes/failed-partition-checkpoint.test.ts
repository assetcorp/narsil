import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createNarsil } from '../../../../narsil'
import { INDEX } from './harness'

it.each([
  { prior: true, failedPartition: 0, healthyId: 'b' },
  { prior: false, failedPartition: 1, healthyId: 'a' },
])('recovers acknowledged writes after a scheduled checkpoint with prior=$prior and failed partition $failedPartition', async ({
  prior,
  failedPartition,
  healthyId,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-failed-partition-checkpoint-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./failed-checkpoint-writer.mjs', import.meta.url))], {
    env: { ...process.env, NARSIL_WAL_DIR: directory, NARSIL_PRIOR_CHECKPOINT: prior ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(20_000),
  })
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  let output = ''
  let errors = ''
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('ACKED')) resolve()
      })
      child.once('exit', () => reject(new Error(errors || 'Writer exited before acknowledging its writes')))
    })
    child.kill('SIGKILL')
    await exited
    await rm(join(directory, INDEX, 'wal', String(failedPartition), 'next'), { recursive: true, force: true })
    const recovered = await createNarsil({ workers: { enabled: false }, durability: { directory } })
    try {
      expect(recovered.getPartitionStats(INDEX)).toHaveLength(2)
      expect(await recovered.get(INDEX, 'a')).toEqual(
        healthyId === 'a' ? { title: 'lake', amount: 4 } : { title: 'river', amount: prior ? 5 : 1 },
      )
      expect(await recovered.get(INDEX, 'b')).toEqual(
        healthyId === 'b' ? { title: 'lake', amount: 4 } : { title: 'shore', amount: 2 },
      )
      expect(
        (await recovered.query(INDEX, { term: 'river shore lake', limit: 10 })).hits.map(hit => hit.id).sort(),
      ).toEqual(['a', 'b'])
    } finally {
      await recovered.shutdown()
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
