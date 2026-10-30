import { setTimeout as sleep } from 'node:timers/promises'
import type { Fleet } from './fleet'
import { type Ledger, type LedgerDocument, REFUSED_FOR_CERTAIN } from './oracle'

const WRITE_TIMEOUT_MS = 20_000
const SEARCH_TIMEOUT_MS = 30_000
const OPERATIONS_PER_DOCUMENT = 5
const REMOVE_SHARE = 0.3
const SEARCH_PAUSE_MS = 50
const IDLE_PAUSE_MS = 100

export const SEARCH_TERM = 'ledger'

export interface Reply {
  status: number
  code: string | null
  text: string
}

export interface FaultState {
  unavailable: Set<number>
  startedOn: number[]
  describe(): string
}

export interface Workload {
  stop(): Promise<void>
  searchFailures(): readonly string[]
  searches(): number
}

export async function send(base: string, method: string, path: string, body: unknown, timeoutMs: number) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let code: string | null = null
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } }
    code = typeof parsed.error?.code === 'string' ? parsed.error.code : null
  } catch {
    code = null
  }
  return { status: response.status, code, text } satisfies Reply
}

function pickNode(fleet: Fleet, faults: FaultState, random: () => number): number | null {
  const choices = fleet.nodes.filter(node => node.running() && !faults.unavailable.has(node.slot))
  if (choices.length === 0) return null
  return choices[Math.floor(random() * choices.length)]?.slot ?? null
}

async function writeOnce(
  fleet: Fleet,
  slot: number,
  indexName: string,
  docId: string,
  current: LedgerDocument | null,
  next: LedgerDocument | null,
): Promise<Reply | null> {
  const base = fleet.nodes[slot]?.base ?? ''
  const path = `/indexes/${indexName}/documents`
  try {
    if (current === null) return await send(base, 'POST', path, { id: docId, document: next }, WRITE_TIMEOUT_MS)
    if (next === null) return await send(base, 'DELETE', `${path}/${docId}`, undefined, WRITE_TIMEOUT_MS)
    return await send(base, 'PATCH', `${path}/${docId}`, { document: next }, WRITE_TIMEOUT_MS)
  } catch {
    return null
  }
}

function settle(
  ledger: Ledger,
  docId: string,
  current: LedgerDocument | null,
  next: LedgerDocument | null,
  reply: Reply | null,
  slot: number,
) {
  if (reply !== null && reply.status >= 200 && reply.status < 300) {
    ledger.record(docId, next, 'acknowledged')
    return
  }
  if (reply === null || reply.code === null) {
    ledger.record(docId, next, 'unanswered')
    return
  }
  if (REFUSED_FOR_CERTAIN.has(reply.code)) {
    ledger.record(docId, next, 'refused')
    return
  }
  if (reply.code === 'DOC_NOT_FOUND' && current !== null) {
    ledger.contradict(
      `${docId}: the cluster acknowledged version ${current.version}, then slot ${slot} answered DOC_NOT_FOUND at ${new Date().toISOString()}`,
    )
    ledger.record(docId, next, 'refused')
    return
  }
  if (reply.code === 'DOC_ALREADY_EXISTS' && current === null) {
    ledger.contradict(`${docId}: the cluster acknowledged it absent, then answered DOC_ALREADY_EXISTS`)
    ledger.record(docId, next, 'refused')
    return
  }
  if (reply.status < 500) {
    ledger.contradict(`${docId}: unexpected ${reply.status} ${reply.text.slice(0, 300)}`)
    ledger.record(docId, next, 'refused')
    return
  }
  ledger.record(docId, next, 'unanswered')
}

export function startWorkload(options: {
  fleet: Fleet
  ledger: Ledger
  faults: FaultState
  indexName: string
  writers: number
  searchers: number
  random: () => number
}): Workload {
  const { fleet, ledger, faults, indexName, random } = options
  let stopping = false
  let version = 0
  let searchCount = 0
  const failures: string[] = []

  async function writer(writerId: number): Promise<void> {
    for (let documentNumber = 0; !stopping; documentNumber++) {
      const docId = `w${writerId}-${documentNumber}`
      for (let operation = 0; operation < OPERATIONS_PER_DOCUMENT && !stopping; operation++) {
        const slot = pickNode(fleet, faults, random)
        if (slot === null) {
          await sleep(IDLE_PAUSE_MS)
          continue
        }
        const current = ledger.certainState(docId)
        version += 1
        const next =
          current !== null && random() < REMOVE_SHARE ? null : { title: `${SEARCH_TERM} entry ${docId}`, version }
        const reply = await writeOnce(fleet, slot, indexName, docId, current, next)
        settle(ledger, docId, current, next, reply, slot)
        if (ledger.isRetired(docId)) break
      }
    }
  }

  async function searcher(): Promise<void> {
    while (!stopping) {
      const slot = pickNode(fleet, faults, random)
      if (slot === null) {
        await sleep(IDLE_PAUSE_MS)
        continue
      }
      const startedOn = faults.startedOn[slot] ?? 0
      const during = faults.describe()
      let reply: Reply | null = null
      let failure = ''
      try {
        reply = await send(
          fleet.nodes[slot]?.base ?? '',
          'POST',
          `/indexes/${indexName}/search`,
          { term: SEARCH_TERM, limit: 1 },
          SEARCH_TIMEOUT_MS,
        )
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      searchCount += 1
      const faultedMeanwhile = (faults.startedOn[slot] ?? 0) !== startedOn || !(fleet.nodes[slot]?.running() ?? false)
      if (!faultedMeanwhile && (reply === null || reply.status !== 200)) {
        failures.push(
          `search on slot ${slot} during ${during}: ${reply === null ? failure : `${reply.status} ${reply.text.slice(0, 300)}`}`,
        )
      }
      await sleep(SEARCH_PAUSE_MS)
    }
  }

  const running = [
    ...Array.from({ length: options.writers }, (_, writerId) => writer(writerId)),
    ...Array.from({ length: options.searchers }, () => searcher()),
  ]

  return {
    async stop() {
      stopping = true
      await Promise.all(running)
    },
    searchFailures: () => failures,
    searches: () => searchCount,
  }
}
