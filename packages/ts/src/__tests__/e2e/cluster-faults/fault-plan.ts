const MIN_HOLD_MS = 3_000
const MAX_HOLD_MS = 14_000
const PULL_REQUEST_FAULT_COUNT = 6
const PULL_REQUEST_WRITERS = 4
const PULL_REQUEST_SEARCHERS = 2
const CAMPAIGN_MIN_FAULTS = 6
const CAMPAIGN_MAX_FAULTS = 10
const CAMPAIGN_MIN_WRITERS = 4
const CAMPAIGN_MAX_WRITERS = 16
const CAMPAIGN_MIN_SEARCHERS = 2
const CAMPAIGN_MAX_SEARCHERS = 6
const CAMPAIGN_OVERLAP_SHARE = 0.35
const CAMPAIGN_GRPC_SHARE = 0.5
const CAMPAIGN_PLAIN_SHARE = 0.5
const QUICK_RESTART_SHARE = 0.5
const MAX_QUICK_RESTART_HOLD_MS = 1_000
const CLIENTS_REST_SHARE = 0.5

export const PULL_REQUEST_FAULT_KINDS = ['kill', 'pause', 'isolate', 'etcd-restart', 'etcd-outage'] as const
export const CAMPAIGN_FAULT_KINDS = [...PULL_REQUEST_FAULT_KINDS, 'kill-wipe', 'stop-wipe', 'blackhole'] as const

export type FaultKind = (typeof CAMPAIGN_FAULT_KINDS)[number]

export function isWipe(kind: FaultKind): boolean {
  return kind === 'kill-wipe' || kind === 'stop-wipe'
}

export interface PlannedFault {
  kind: FaultKind
  slot: number
  holdMs: number
  startAfterMs: number
  clientsRest?: boolean
}

export interface FaultPlan {
  transport: 'tcp' | 'grpc'
  plain: boolean
  writers: number
  searchers: number
  rounds: PlannedFault[][]
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function isEtcdFault(kind: FaultKind): boolean {
  return kind === 'etcd-restart' || kind === 'etcd-outage'
}

export function describeFault(fault: PlannedFault): string {
  const target = isEtcdFault(fault.kind) ? `etcd member ${fault.slot}` : `slot ${fault.slot}`
  const delay = fault.startAfterMs > 0 ? ` from ${fault.startAfterMs} ms in` : ''
  const rest = fault.clientsRest === true ? ' while every client rests' : ''
  return `${fault.kind} on ${target} for ${fault.holdMs} ms${delay}${rest}`
}

function between(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1))
}

function pick<T>(random: () => number, choices: readonly T[], fallback: T): T {
  return choices[Math.floor(random() * choices.length)] ?? fallback
}

function holdFor(random: () => number): number {
  return MIN_HOLD_MS + Math.floor(random() * (MAX_HOLD_MS - MIN_HOLD_MS))
}

function campaignHoldFor(random: () => number, kind: FaultKind): number {
  if (isWipe(kind) && random() < QUICK_RESTART_SHARE) return Math.floor(random() * MAX_QUICK_RESTART_HOLD_MS)
  return holdFor(random)
}

export function pullRequestPlan(random: () => number, nodeCount: number, plain: boolean): FaultPlan {
  const rounds: PlannedFault[][] = []
  for (let at = 0; at < PULL_REQUEST_FAULT_COUNT; at++) {
    const kind = pick(random, PULL_REQUEST_FAULT_KINDS, 'kill')
    const slot = Math.floor(random() * nodeCount)
    rounds.push([{ kind, slot, holdMs: holdFor(random), startAfterMs: 0 }])
  }
  return { transport: 'tcp', plain, writers: PULL_REQUEST_WRITERS, searchers: PULL_REQUEST_SEARCHERS, rounds }
}

function overlappingFault(random: () => number, first: PlannedFault, nodeCount: number): PlannedFault {
  let kind = pick(random, CAMPAIGN_FAULT_KINDS, 'kill')
  if (isEtcdFault(kind) && isEtcdFault(first.kind)) kind = 'pause'
  if (isWipe(kind) && isWipe(first.kind)) kind = 'kill'
  const otherSlots = Array.from({ length: nodeCount }, (_, slot) => slot).filter(slot => slot !== first.slot)
  const slot = pick(random, otherSlots, 0)
  return { kind, slot, holdMs: campaignHoldFor(random, kind), startAfterMs: Math.floor(random() * first.holdMs) }
}

export function campaignPlan(random: () => number, nodeCount: number): FaultPlan {
  const transport = random() < CAMPAIGN_GRPC_SHARE ? 'grpc' : 'tcp'
  const plain = random() < CAMPAIGN_PLAIN_SHARE
  const writers = between(random, CAMPAIGN_MIN_WRITERS, CAMPAIGN_MAX_WRITERS)
  const searchers = between(random, CAMPAIGN_MIN_SEARCHERS, CAMPAIGN_MAX_SEARCHERS)
  const faultCount = between(random, CAMPAIGN_MIN_FAULTS, CAMPAIGN_MAX_FAULTS)
  const rounds: PlannedFault[][] = []
  for (let at = 0; at < faultCount; at++) {
    const kind = pick(random, CAMPAIGN_FAULT_KINDS, 'kill')
    const slot = Math.floor(random() * nodeCount)
    const first: PlannedFault = { kind, slot, holdMs: campaignHoldFor(random, kind), startAfterMs: 0 }
    if (random() < CAMPAIGN_OVERLAP_SHARE) {
      rounds.push([first, overlappingFault(random, first, nodeCount)])
    } else {
      if (isWipe(kind)) first.clientsRest = random() < CLIENTS_REST_SHARE
      rounds.push([first])
    }
  }
  return { transport, plain, writers, searchers, rounds }
}
