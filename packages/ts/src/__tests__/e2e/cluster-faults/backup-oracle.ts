import { createLedger, type Ledger, type LedgerDocument } from './oracle'

interface Settled {
  intended: LedgerDocument | null
  outcome: 'acknowledged' | 'refused' | 'unanswered'
  at: number
}

export interface BackupLedger extends Ledger {
  checkBackup(cutAt: number, restored: ReadonlyMap<string, LedgerDocument>): string[]
}

function same(left: LedgerDocument | null, right: LedgerDocument | null): boolean {
  if (left === null || right === null) return left === right
  return left.title === right.title && left.version === right.version
}

function describe(state: LedgerDocument | null): string {
  return state === null ? 'absent' : `version ${state.version}`
}

export function createBackupLedger(): BackupLedger {
  const ledger = createLedger()
  const timelines = new Map<string, Settled[]>()

  function allowedAt(timeline: readonly Settled[], cutAt: number): Array<LedgerDocument | null> {
    let certain: LedgerDocument | null = null
    const later: Array<LedgerDocument | null> = []
    for (const entry of timeline) {
      if (entry.outcome === 'refused') continue
      if (entry.outcome === 'acknowledged' && entry.at < cutAt) certain = entry.intended
      else later.push(entry.intended)
    }
    return [certain, ...later]
  }

  return {
    ...ledger,
    record(docId, intended, outcome) {
      ledger.record(docId, intended, outcome)
      let timeline = timelines.get(docId)
      if (timeline === undefined) {
        timeline = []
        timelines.set(docId, timeline)
      }
      timeline.push({ intended, outcome, at: Date.now() })
    },
    checkBackup(cutAt, restored) {
      const problems = [...ledger.contradictions()]
      for (const [docId, timeline] of timelines) {
        const stored = restored.get(docId) ?? null
        const allowed = allowedAt(timeline, cutAt)
        if (allowed.some(state => same(state, stored))) continue
        problems.push(
          `${docId} holds ${describe(stored)}, but the backup had to hold ${allowed.map(describe).join(' or ')}`,
        )
      }
      for (const docId of restored.keys()) {
        if (!timelines.has(docId)) problems.push(`${docId} is restored, but no writer ever sent it`)
      }
      return problems
    },
  }
}
