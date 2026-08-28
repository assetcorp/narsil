import { describe, expect, it } from 'vitest'
import type { ClusterNodeRow, ClusterSnapshot, LinkRow } from '../src/lib/cluster-types'
import { buildControls, linkControlOf, localReasonOf, probeWithTerm } from '../src/lib/controls'
import { NODES } from '../src/topology'

function node(nodeId: string, registered: boolean): ClusterNodeRow {
  return {
    nodeId,
    address: registered ? `${nodeId}:9301` : null,
    roles: registered ? ['data'] : [],
    startedAt: null,
    version: null,
    registered,
  }
}

function links(enabled: boolean | null): LinkRow[] {
  return NODES.flatMap(spec => [
    { nodeId: spec.nodeId, kind: 'coordinator' as const, proxyName: spec.etcdProxyName, enabled },
    { nodeId: spec.nodeId, kind: 'replication' as const, proxyName: spec.replicationProxyName, enabled },
  ])
}

function snapshot(overrides: Partial<ClusterSnapshot> = {}): ClusterSnapshot {
  return {
    updatedAt: '2026-08-28T10:00:00.000Z',
    indexName: 'forum-answers',
    indexExists: true,
    allocationVersion: 4,
    replicationFactor: 1,
    controllerNodeId: 'node-a',
    nodes: NODES.map(spec => node(spec.nodeId, true)),
    partitions: [],
    links: links(true),
    coordinatorError: null,
    faultInjectorError: null,
    ...overrides,
  }
}

describe('buildControls on a healthy cluster', () => {
  const controls = buildControls(snapshot(), 'live', null)

  it('offers the reads and the ingest', () => {
    expect(controls.probe.enabled).toBe(true)
    expect(controls.provision.enabled).toBe(true)
    expect(controls.provision.nodeId).toBe('node-a')
  })

  it('offers the link of every node', () => {
    const control = linkControlOf(snapshot(), controls.blockedReason, 'node-b', 'coordinator')

    expect(control).toMatchObject({ linkUp: true, enabled: true, reason: null })
  })

  it('withholds the repair while no link is cut, and it gives no reason for that', () => {
    expect(controls.heal).toEqual({ enabled: false, reason: null })
  })

  it('offers the repair once a link is down', () => {
    const cut = snapshot({ links: links(false) })

    expect(buildControls(cut, 'live', null).heal.enabled).toBe(true)
  })
})

describe('buildControls while the page has no live view', () => {
  const stale = buildControls(snapshot(), 'offline', null)

  it('says the page shows what it saw last', () => {
    expect(stale.staleReason).toContain('saw last')
    expect(stale.blockedReason).toBe(stale.staleReason)
  })

  it('withholds every action that acts on what the page shows', () => {
    expect(stale.probe.enabled).toBe(false)
    expect(stale.provision.enabled).toBe(false)
    expect(buildControls(snapshot({ links: links(false) }), 'offline', null).heal.enabled).toBe(false)
    expect(linkControlOf(snapshot(), stale.blockedReason, 'node-a', 'replication').enabled).toBe(false)
  })

  it('withholds them while the stream is still connecting as well', () => {
    expect(buildControls(snapshot(), 'connecting', null).probe.enabled).toBe(false)
  })
})

describe('buildControls while an action is in flight', () => {
  const busy = buildControls(snapshot({ links: links(false) }), 'live', 'Cutting the coordinator link of node-a')

  it('names the action that has yet to finish', () => {
    expect(busy.blockedReason).toBe('Cutting the coordinator link of node-a has yet to finish.')
    expect(busy.staleReason).toBeNull()
    expect(busy.pendingLabel).toBe('Cutting the coordinator link of node-a')
  })

  it('withholds a second action until the first one finishes', () => {
    expect(busy.heal.enabled).toBe(false)
    expect(busy.provision.enabled).toBe(false)
    expect(linkControlOf(snapshot(), busy.blockedReason, 'node-a', 'coordinator').enabled).toBe(false)
  })
})

describe('buildControls while the fault injector is unreachable', () => {
  const unreachable = snapshot({ links: links(null), faultInjectorError: 'fetch failed' })
  const controls = buildControls(unreachable, 'live', null)

  it('reports no state for a link and offers no button', () => {
    const control = linkControlOf(unreachable, controls.blockedReason, 'node-a', 'coordinator')

    expect(control.linkUp).toBeNull()
    expect(control.enabled).toBe(false)
    expect(control.reason).toContain('fetch failed')
  })

  it('withholds the repair and says why', () => {
    expect(controls.heal.enabled).toBe(false)
    expect(controls.heal.reason).toContain('fetch failed')
  })

  it('names the link whose proxy the injector left out', () => {
    const partial = snapshot({ links: links(true).filter(link => link.kind !== 'replication') })
    const control = linkControlOf(partial, null, 'node-c', 'replication')

    expect(control.enabled).toBe(false)
    expect(control.reason).toBe('The fault injector names no proxy for the replication link of node-c.')
  })

  it('keeps the reads and the ingest available, because neither one goes through the injector', () => {
    expect(controls.probe.enabled).toBe(true)
    expect(controls.provision.enabled).toBe(true)
  })
})

describe('buildControls while the coordinator is unreachable', () => {
  const lost = snapshot({
    coordinatorError: 'connection refused',
    nodes: NODES.map(spec => node(spec.nodeId, false)),
  })
  const controls = buildControls(lost, 'live', null)

  it('withholds the ingest and repeats what the coordinator answered', () => {
    expect(controls.provision.enabled).toBe(false)
    expect(controls.provision.reason).toBe('The coordinator answered with an error: connection refused')
  })

  it('still offers the link, because restoring one is how the cluster comes back', () => {
    expect(linkControlOf(lost, controls.blockedReason, 'node-a', 'coordinator').enabled).toBe(true)
  })
})

describe('the node that takes the corpus', () => {
  it('skips a node whose registration has expired', () => {
    const partial = snapshot({ nodes: [node('node-a', false), node('node-b', true), node('node-c', true)] })

    expect(buildControls(partial, 'live', null).provision.nodeId).toBe('node-b')
  })

  it('withholds the ingest while no node holds a registration', () => {
    const empty = snapshot({ nodes: NODES.map(spec => node(spec.nodeId, false)) })
    const control = buildControls(empty, 'live', null).provision

    expect(control).toEqual({
      nodeId: null,
      enabled: false,
      reason: 'No node holds a registration in etcd, so none of them can take a corpus.',
    })
  })
})

describe('the three reads', () => {
  it('waits for an index to exist', () => {
    const control = buildControls(snapshot({ indexExists: false }), 'live', null).probe

    expect(control.enabled).toBe(false)
    expect(control.reason).toBe("No node has allocated 'forum-answers' yet, so there is nothing to read.")
  })

  it('waits for a term the server would accept', () => {
    const control = buildControls(snapshot(), 'live', null).probe

    expect(probeWithTerm(control, '   ').enabled).toBe(false)
    expect(probeWithTerm(control, 'mortgage')).toBe(control)
  })

  it('keeps the earlier refusal where the term is blank as well', () => {
    const control = buildControls(snapshot({ indexExists: false }), 'live', null).probe

    expect(probeWithTerm(control, '')).toBe(control)
  })
})

describe('localReasonOf', () => {
  const controls = buildControls(snapshot(), 'offline', null)

  it('says nothing about a control the reader may press', () => {
    expect(localReasonOf({ enabled: true, reason: null })).toBeNull()
  })

  it('says nothing where a banner already carries the sentence', () => {
    expect(localReasonOf(controls.probe, controls.blockedReason)).toBeNull()
  })

  it('gives the sentence no other part of the page shows', () => {
    expect(localReasonOf(controls.probe, null)).toBe(controls.staleReason)
  })
})
