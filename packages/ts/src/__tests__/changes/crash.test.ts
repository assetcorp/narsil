import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Change } from '../../types/changes'
import {
  cleanUp,
  closeEngine,
  durableEngine,
  exportedCopy,
  type Followed,
  follow,
  headsOf,
  plain,
  type Stored,
} from './fixtures'

const CHILD_SCRIPT = fileURLToPath(new URL('./crash-child.mjs', import.meta.url))
const built = existsSync(new URL('../../../dist/index.mjs', import.meta.url))
const SCHEMA = { schema: { title: 'string', price: 'number' }, partitions: { maxPartitions: 2 } } as const
const FIRST_DOCUMENTS = 80
const WRITES = 240
const CHILD_TIMEOUT_MS = 60_000

interface Write {
  op: 'insert' | 'update' | 'remove'
  id: string
  document?: Stored
}

interface ChildRun {
  acknowledged: Write[]
  inFlight: Write | null
  signal: NodeJS.Signals | null
  output: string
}

afterEach(cleanUp)

function runChild(directory: string, killAt: string): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD_SCRIPT], {
      env: {
        ...process.env,
        NARSIL_DIR: directory,
        NARSIL_KILL_AT: killAt,
        NARSIL_WRITES: String(WRITES),
        NARSIL_FIRST_DOCUMENTS: String(FIRST_DOCUMENTS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => {
      output += String(chunk)
    })
    child.stderr.on('data', chunk => {
      output += String(chunk)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
    child.on('error', reject)
    child.on('exit', (_code, signal) => {
      clearTimeout(timer)
      const acknowledged: Write[] = []
      let inFlight: Write | null = null
      for (const line of output.split('\n')) {
        if (line.startsWith('ACK ')) acknowledged.push(JSON.parse(line.slice('ACK '.length)) as Write)
        if (line.startsWith('INFLIGHT ')) inFlight = JSON.parse(line.slice('INFLIGHT '.length)) as Write
      }
      resolve({ acknowledged, inFlight, signal, output })
    })
  })
}

function applied(base: ReadonlyMap<string, Stored>, writes: readonly Write[]): Map<string, Stored> {
  const result = new Map(base)
  for (const write of writes) {
    if (write.op === 'remove') result.delete(write.id)
    else result.set(write.id, write.document ?? {})
  }
  return result
}

function sameDocuments(left: ReadonlyMap<string, Stored>, right: ReadonlyMap<string, Stored>): boolean {
  if (left.size !== right.size) return false
  for (const [id, document] of left) {
    if (JSON.stringify(plain(document)) !== JSON.stringify(plain(right.get(id)))) return false
  }
  return true
}

function applyingInto(copy: Map<string, Stored>, problems: string[]): (followed: Followed) => void {
  let at = 0
  return followed => {
    for (; at < followed.changes.length; at++) {
      const change: Change = followed.changes[at]
      const held = copy.get(change.documentId)
      if (change.type === 'insert' && held !== undefined) problems.push(`insert of held ${change.documentId}`)
      if (change.type === 'update' || change.type === 'remove') {
        if (JSON.stringify(plain(change.previousDocument)) !== JSON.stringify(plain(held))) {
          problems.push(`previous document of ${change.documentId} at ${change.seqNo}`)
        }
      }
      if (change.type === 'remove') copy.delete(change.documentId)
      else copy.set(change.documentId, plain(change.document))
    }
  }
}

describe.skipIf(!built)('following changes after a crash', () => {
  it.each([
    { killAt: 'write', what: 'while a write with its previous document reaches the log' },
    { killAt: 'history-move', what: 'while a checkpoint moves a log segment into history' },
  ])('rebuilds every acknowledged write with its previous document after a kill $what', async ({ killAt }) => {
    const { engine, directory } = await durableEngine()
    await engine.createIndex('shop', SCHEMA)
    await engine.updateChanges('shop', { enabled: true, previousDocument: true })
    const batch = Array.from({ length: FIRST_DOCUMENTS }, (_, at) => ({
      id: `p${at}`,
      title: `product ${at}`,
      price: at,
    }))
    expect((await engine.insertBatch('shop', batch)).failed).toEqual([])
    const exported = await exportedCopy(engine, 'shop')
    expect(exported.positions.map(position => position.partitionId)).toEqual([0, 1])
    await closeEngine(engine)

    const run = await runChild(directory, killAt)
    expect(run.signal, run.output).toBe('SIGKILL')
    if (killAt === 'write') expect(run.acknowledged.length).toBe(WRITES - 1)

    const restarted = (await durableEngine(directory)).engine
    const recovered = (await exportedCopy(restarted, 'shop')).documents
    const withoutInFlight = applied(exported.documents, run.acknowledged)
    const withInFlight = applied(withoutInFlight, run.inFlight === null ? [] : [run.inFlight])
    expect(sameDocuments(recovered, withoutInFlight) || sameDocuments(recovered, withInFlight)).toBe(true)

    const copy = new Map(exported.documents)
    const problems: string[] = []
    const apply = applyingInto(copy, problems)
    const followed = await follow(
      restarted,
      'shop',
      { epoch: exported.epoch, positions: exported.positions },
      state => {
        apply(state)
        const heads = headsOf(state)
        return (
          heads.size > 0 && [...heads].every(([partitionId, head]) => (state.positions.get(partitionId) ?? -1) >= head)
        )
      },
    )
    expect(followed.resync).toBeNull()
    expect(problems).toEqual([])
    expect(sameDocuments(copy, recovered)).toBe(true)
  }, 120_000)
})
