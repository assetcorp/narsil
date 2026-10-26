import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitFor } from '../../server/helpers'

export interface CompactionGate {
  source: string
  close(): Promise<void>
  awaitHeldCompaction(): Promise<void>
  open(): Promise<void>
}

export function compactionGate(dir: string): CompactionGate {
  const gate = join(dir, 'compaction-gate')
  const held = join(dir, 'compaction-held')
  const source = `import { parentPort } from 'node:worker_threads'
import { existsSync, writeFileSync } from 'node:fs'
const pause = new Int32Array(new SharedArrayBuffer(4))
parentPort.on('message', message => {
  if (message?.type !== 'compactSegments' || !existsSync(${JSON.stringify(gate)})) return
  writeFileSync(${JSON.stringify(held)}, '')
  while (existsSync(${JSON.stringify(gate)})) Atomics.wait(pause, 0, 0, 10)
})`
  return {
    source,
    close: () => writeFile(gate, ''),
    awaitHeldCompaction: () => waitFor(async () => existsSync(held)),
    open: () => rm(gate, { force: true }),
  }
}
