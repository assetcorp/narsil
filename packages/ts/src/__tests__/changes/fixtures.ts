import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNarsil, type Narsil } from '../../narsil'
import type { Change, ChangePosition, ChangesEvent, FollowChangesOptions } from '../../types/changes'

export type Stored = Record<string, unknown>

export interface ExportedCopy {
  epoch: string
  positions: ChangePosition[]
  documents: Map<string, Stored>
}

export interface Followed {
  events: ChangesEvent[]
  changes: Array<Change & { partitionId: number }>
  positions: Map<number, number>
  resync: string | null
}

const opened: Narsil[] = []
const directories: string[] = []

export async function durableEngine(directory?: string): Promise<{ engine: Narsil; directory: string }> {
  const root = directory ?? (await mkdtemp(join(tmpdir(), 'narsil-changes-')))
  if (directory === undefined) directories.push(root)
  const engine = await createNarsil({ workers: { enabled: false }, durability: { directory: root } })
  opened.push(engine)
  return { engine, directory: root }
}

export async function closeEngine(engine: Narsil): Promise<void> {
  const at = opened.indexOf(engine)
  if (at >= 0) opened.splice(at, 1)
  await engine.shutdown()
}

export async function cleanUp(): Promise<void> {
  for (const engine of opened.splice(0)) await engine.shutdown().catch(() => undefined)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
}

export async function exportedCopy(engine: Narsil, indexName: string): Promise<ExportedCopy> {
  const stream = await engine.exportDocuments(indexName)
  const text = await new Response(stream).text()
  const lines = text.split('\n').filter(line => line.length > 0)
  const header = JSON.parse(lines[0]) as { epoch: string; positions: ChangePosition[] }
  const documents = new Map<string, Stored>()
  for (const line of lines.slice(1)) {
    const { id, ...rest } = JSON.parse(line) as Stored & { id: string }
    documents.set(id, rest)
  }
  return { epoch: header.epoch, positions: header.positions, documents }
}

export async function follow(
  engine: Narsil,
  indexName: string,
  options: FollowChangesOptions,
  until: (followed: Followed) => boolean,
  timeoutMs = 20_000,
): Promise<Followed> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const followed: Followed = { events: [], changes: [], positions: new Map(), resync: null }
  try {
    for await (const event of engine.followChanges(indexName, { ...options, signal: controller.signal })) {
      followed.events.push(event)
      if (event.type === 'subscribed') {
        for (const position of event.positions) followed.positions.set(position.partitionId, position.seqNo)
      } else if (event.type === 'changes') {
        for (const change of event.changes) followed.changes.push({ ...change, partitionId: event.partitionId })
        followed.positions.set(event.partitionId, event.scannedSeqNo)
      } else {
        followed.resync = event.reason
      }
      if (until(followed)) break
    }
  } finally {
    clearTimeout(timer)
  }
  return followed
}

export function reachedHeads(heads: ReadonlyMap<number, number>): (followed: Followed) => boolean {
  return followed => {
    for (const [partitionId, head] of heads) if ((followed.positions.get(partitionId) ?? -1) < head) return false
    return true
  }
}

export function headsOf(followed: Followed): Map<number, number> {
  const subscribed = followed.events.find(event => event.type === 'subscribed')
  const heads = new Map<number, number>()
  if (subscribed?.type === 'subscribed') for (const head of subscribed.heads) heads.set(head.partitionId, head.seqNo)
  return heads
}

export function plain(document: unknown): Stored {
  if (document === undefined) return {}
  const { id: _id, ...fields } = JSON.parse(JSON.stringify(document)) as Stored
  return fields
}
