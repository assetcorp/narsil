export interface LedgerDocument {
  title: string
  version: number
}

type Outcome = 'acknowledged' | 'refused' | 'unanswered'

interface DocumentHistory {
  certain: LedgerDocument | null
  pending: Array<LedgerDocument | null>
  retired: boolean
}

export const REFUSED_BEFORE_APPLY = new Set([
  'PARTITION_NOT_PRIMARY',
  'PARTITION_UNASSIGNED',
  'NODE_NOT_READY',
  'CLUSTER_WRITE_BLOCKED',
  'REPLICATION_LOG_FULL',
])

export interface Ledger {
  record(docId: string, intended: LedgerDocument | null, outcome: Outcome): void
  contradict(message: string): void
  certainState(docId: string): LedgerDocument | null
  isRetired(docId: string): boolean
  counts(): Record<Outcome, number>
  contradictions(): readonly string[]
  check(actual: ReadonlyMap<string, LedgerDocument>): string[]
}

function same(left: LedgerDocument | null, right: LedgerDocument | null): boolean {
  if (left === null || right === null) return left === right
  return left.title === right.title && left.version === right.version
}

function describe(state: LedgerDocument | null): string {
  return state === null ? 'absent' : `version ${state.version}`
}

export function createLedger(): Ledger {
  const histories = new Map<string, DocumentHistory>()
  const tally: Record<Outcome, number> = { acknowledged: 0, refused: 0, unanswered: 0 }
  const found: string[] = []

  function historyOf(docId: string): DocumentHistory {
    let history = histories.get(docId)
    if (history === undefined) {
      history = { certain: null, pending: [], retired: false }
      histories.set(docId, history)
    }
    return history
  }

  return {
    record(docId, intended, outcome) {
      tally[outcome] += 1
      const history = historyOf(docId)
      if (outcome === 'acknowledged') history.certain = intended
      if (outcome === 'unanswered') {
        history.pending.push(intended)
        history.retired = true
      }
    },
    contradict(message) {
      found.push(message)
    },
    certainState: docId => historyOf(docId).certain,
    isRetired: docId => historyOf(docId).retired,
    counts: () => ({ ...tally }),
    contradictions: () => found,
    check(actual) {
      const problems = [...found]
      for (const [docId, history] of histories) {
        const stored = actual.get(docId) ?? null
        const allowed = [history.certain, ...history.pending]
        if (allowed.some(state => same(state, stored))) continue
        problems.push(
          `${docId} holds ${describe(stored)}, but the cluster acknowledged ${describe(history.certain)}${
            history.pending.length > 0 ? ` and left ${history.pending.map(describe).join(', ')} unanswered` : ''
          }`,
        )
      }
      for (const docId of actual.keys()) {
        if (!histories.has(docId)) problems.push(`${docId} is stored, but no writer ever sent it`)
      }
      return problems
    },
  }
}
