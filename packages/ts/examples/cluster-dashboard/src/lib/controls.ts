import type { ClusterSnapshot, LinkKind, StreamState } from './cluster-types'
import { cutLinkCountOf, linkOf } from './cluster-types'

export interface ControlState {
  readonly enabled: boolean
  readonly reason: string | null
}

export interface LinkControl extends ControlState {
  readonly nodeId: string
  readonly kind: LinkKind
  readonly linkUp: boolean | null
}

export interface ProvisionControl extends ControlState {
  readonly nodeId: string | null
}

export interface DashboardControls {
  staleReason: string | null
  blockedReason: string | null
  pendingLabel: string | null
  heal: ControlState
  provision: ProvisionControl
  probe: ControlState
}

const STALE_TEXT =
  'The dashboard has lost its live view of the cluster, so this page shows what it saw last. Every control stays off until that view comes back.'

const ALLOWED: ControlState = { enabled: true, reason: null }

function refused(reason: string): ControlState {
  return { enabled: false, reason }
}

function staleReasonOf(stream: StreamState): string | null {
  return stream === 'live' ? null : STALE_TEXT
}

function blockedReasonOf(stream: StreamState, pending: string | null): string | null {
  const stale = staleReasonOf(stream)
  if (stale !== null) {
    return stale
  }
  return pending === null ? null : `${pending} has yet to finish.`
}

function faultInjectorReasonOf(snapshot: ClusterSnapshot): string | null {
  if (snapshot.faultInjectorError === null) {
    return null
  }
  return `The fault injector answered with an error, so the dashboard cannot read or change a link: ${snapshot.faultInjectorError}`
}

export function linkControlOf(
  snapshot: ClusterSnapshot,
  blockedReason: string | null,
  nodeId: string,
  kind: LinkKind,
): LinkControl {
  const linkUp = linkOf(snapshot, nodeId, kind)?.enabled ?? null

  if (linkUp === null) {
    const missing = `The fault injector names no proxy for the ${kind} link of ${nodeId}.`
    return { nodeId, kind, linkUp, enabled: false, reason: faultInjectorReasonOf(snapshot) ?? missing }
  }
  if (blockedReason !== null) {
    return { nodeId, kind, linkUp, enabled: false, reason: blockedReason }
  }
  return { nodeId, kind, linkUp, enabled: true, reason: null }
}

function healControlOf(snapshot: ClusterSnapshot, blockedReason: string | null): ControlState {
  const injector = faultInjectorReasonOf(snapshot)
  if (injector !== null) {
    return refused(injector)
  }
  if (blockedReason !== null) {
    return refused(blockedReason)
  }
  if (cutLinkCountOf(snapshot) === 0) {
    return { enabled: false, reason: null }
  }
  return ALLOWED
}

function provisionControlOf(snapshot: ClusterSnapshot, blockedReason: string | null): ProvisionControl {
  const nodeId = snapshot.nodes.find(node => node.registered)?.nodeId ?? null

  if (snapshot.coordinatorError !== null) {
    return { nodeId, enabled: false, reason: `The coordinator answered with an error: ${snapshot.coordinatorError}` }
  }
  if (nodeId === null) {
    return {
      nodeId,
      enabled: false,
      reason: 'No node holds a registration in etcd, so none of them can take a corpus.',
    }
  }
  if (blockedReason !== null) {
    return { nodeId, enabled: false, reason: blockedReason }
  }
  return { nodeId, enabled: true, reason: null }
}

function probeControlOf(snapshot: ClusterSnapshot, blockedReason: string | null): ControlState {
  if (!snapshot.indexExists) {
    return refused(`No node has allocated '${snapshot.indexName}' yet, so there is nothing to read.`)
  }
  if (blockedReason !== null) {
    return refused(blockedReason)
  }
  return ALLOWED
}

export function buildControls(
  snapshot: ClusterSnapshot,
  stream: StreamState,
  pending: string | null,
): DashboardControls {
  const blockedReason = blockedReasonOf(stream, pending)

  return {
    staleReason: staleReasonOf(stream),
    blockedReason,
    pendingLabel: pending,
    heal: healControlOf(snapshot, blockedReason),
    provision: provisionControlOf(snapshot, blockedReason),
    probe: probeControlOf(snapshot, blockedReason),
  }
}

export function probeWithTerm(probe: ControlState, term: string): ControlState {
  if (!probe.enabled) {
    return probe
  }
  return term.trim().length === 0 ? refused('Type a term for the three reads to look for.') : probe
}

export function localReasonOf(control: ControlState, ...shownElsewhere: Array<string | null>): string | null {
  if (control.enabled || control.reason === null || shownElsewhere.includes(control.reason)) {
    return null
  }
  return control.reason
}
