import type { AllocationTable, ClusterCoordinator, NodeRegistration } from '../coordinator/types'

export interface AllocationView {
  readonly routing: ClusterCoordinator
  read(indexName: string): Promise<AllocationTable | null>
  refresh(indexName: string): Promise<AllocationTable | null>
  readLive(indexName: string): Promise<AllocationTable | null>
  start(): Promise<void>
  stop(): void
}

export function createAllocationView(coordinator: ClusterCoordinator): AllocationView {
  const tables = new Map<string, AllocationTable>()
  let nodes: Map<string, NodeRegistration> | null = null
  let watching = false
  const unwatchers: Array<() => void> = []

  function tornDown(table: AllocationTable): boolean {
    return table.assignments.size === 0 && table.generation === undefined
  }

  function holdNewest(indexName: string, table: AllocationTable): AllocationTable {
    const held = tables.get(indexName)
    if (held !== undefined && held.version > table.version && !tornDown(held)) return held
    tables.set(indexName, table)
    return table
  }

  function rememberLive(table: AllocationTable): AllocationTable {
    return watching ? holdNewest(table.indexName, table) : table
  }

  async function readLive(indexName: string): Promise<AllocationTable | null> {
    const live = await coordinator.getAllocation(indexName)
    if (live === null) {
      tables.delete(indexName)
      return null
    }
    return rememberLive(live)
  }

  async function refresh(indexName: string): Promise<AllocationTable | null> {
    try {
      return await readLive(indexName)
    } catch (error) {
      const held = tables.get(indexName)
      if (held !== undefined) return held
      throw error
    }
  }

  async function read(indexName: string): Promise<AllocationTable | null> {
    if (!watching) return coordinator.getAllocation(indexName)
    const held = tables.get(indexName)
    return held === undefined || tornDown(held) ? refresh(indexName) : held
  }

  async function listNodes(): Promise<NodeRegistration[]> {
    if (watching && nodes !== null) return [...nodes.values()]
    const live = await coordinator.listNodes()
    if (watching) nodes = new Map(live.map(registration => [registration.nodeId, registration]))
    return live
  }

  const routing = new Proxy(coordinator, {
    get(target, property, receiver) {
      if (property === 'getAllocation') return read
      if (property === 'listNodes') return listNodes
      return Reflect.get(target, property, receiver)
    },
  })

  return {
    routing,
    read,
    refresh,
    readLive,
    async start() {
      if (watching) return
      unwatchers.push(
        await coordinator.watchAllocation(event => {
          holdNewest(event.indexName, event.table)
        }),
      )
      unwatchers.push(
        await coordinator.watchSchemas(event => {
          if (event.type === 'schema_dropped') tables.delete(event.indexName)
        }),
      )
      unwatchers.push(
        await coordinator.watchNodes(event => {
          if (nodes === null) return
          if (event.registration === null) nodes.delete(event.nodeId)
          else nodes.set(event.nodeId, event.registration)
        }),
      )
      watching = true
      const live = await coordinator.listNodes()
      nodes = new Map(live.map(registration => [registration.nodeId, registration]))
    },
    stop() {
      watching = false
      for (const unwatch of unwatchers.splice(0)) unwatch()
      tables.clear()
      nodes = null
    },
  }
}
