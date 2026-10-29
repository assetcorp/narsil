import { ErrorCodes, NarsilError } from '../../errors'
import type { ReplicationLog, ReplicationLogEntry } from '../replication/types'

interface KnownTerms {
  led: number
  accepted: number
}

interface LeadingWait {
  primaryTerm: number
  supersede: (error: NarsilError) => void
}

const knownTerms = new WeakMap<ReplicationLog, KnownTerms>()
const leadingWaits = new WeakMap<ReplicationLog, Set<LeadingWait>>()

function termsOf(log: ReplicationLog): KnownTerms {
  let terms = knownTerms.get(log)
  if (terms === undefined) {
    terms = { led: 0, accepted: 0 }
    knownTerms.set(log, terms)
  }
  return terms
}

export function noteLedTerm(log: ReplicationLog, primaryTerm: number): void {
  const terms = termsOf(log)
  if (primaryTerm > terms.led) terms.led = primaryTerm
}

export function noteAcceptedPrimaryTerm(log: ReplicationLog, primaryTerm: number): void {
  const terms = termsOf(log)
  if (primaryTerm > terms.accepted) terms.accepted = primaryTerm
}

export function carryKnownTerms(from: ReplicationLog | undefined, to: ReplicationLog): void {
  const terms = from === undefined ? undefined : knownTerms.get(from)
  if (terms !== undefined) knownTerms.set(to, { ...terms })
}

export function termRefusingSender(log: ReplicationLog, senderTerm: number): number | null {
  const terms = knownTerms.get(log)
  if (terms === undefined) return null
  if (senderTerm <= terms.led) return terms.led
  if (senderTerm < terms.accepted) return terms.accepted
  return null
}

export function untilSuperseded<T>(log: ReplicationLog, entry: ReplicationLogEntry, work: Promise<T>): Promise<T> {
  let waits = leadingWaits.get(log)
  if (waits === undefined) {
    waits = new Set()
    leadingWaits.set(log, waits)
  }
  const held = waits
  let wait: LeadingWait | undefined
  const superseded = new Promise<never>((_, reject) => {
    wait = { primaryTerm: entry.primaryTerm, supersede: reject }
  })
  if (wait !== undefined) held.add(wait)
  return Promise.race([work, superseded]).finally(() => {
    if (wait !== undefined) held.delete(wait)
  })
}

export function noteSupersedingPrimary(
  log: ReplicationLog,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  primaryTerm: number,
): void {
  const waits = leadingWaits.get(log)
  if (waits === undefined) return
  for (const wait of waits) {
    if (wait.primaryTerm >= primaryTerm) continue
    waits.delete(wait)
    wait.supersede(
      new NarsilError(
        ErrorCodes.PARTITION_NOT_PRIMARY,
        `Primary authority changed before acknowledging write for index '${indexName}' partition ${partitionId}`,
        {
          indexName,
          partitionId,
          expectedPrimaryTerm: wait.primaryTerm,
          currentPrimaryNodeId: primaryNodeId,
          currentPrimaryTerm: primaryTerm,
        },
      ),
    )
  }
}
