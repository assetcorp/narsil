import type { VectorIndex } from '../../vector/vector-index'

export interface CheckpointTurns {
  checkpointInFlight: Promise<void> | null
}

export interface CheckpointTurn {
  joinsInFlight: boolean
  mayStart(): boolean
  perform(): Promise<void>
  afterSettling(): void
}

export interface IndexLoads {
  track(indexName: string, load: Promise<void>, startsGraphRepairs?: boolean): Promise<void>
  settled(indexName: string): Promise<void>
  startGraphRepairs(indexName: string): void
}

export function createIndexLoads(vectorIndexesOf: (indexName: string) => Map<string, VectorIndex>): IndexLoads {
  const loads = new Map<string, Promise<void>>()
  const startGraphRepairs = (indexName: string): void => {
    for (const vectorIndex of vectorIndexesOf(indexName).values()) vectorIndex.startShuffledRebuildWhenDue()
  }
  return {
    track(indexName, load, startsGraphRepairs = true) {
      const loaded = startsGraphRepairs ? load.then(() => startGraphRepairs(indexName)) : load
      loads.set(
        indexName,
        loaded.catch(() => undefined),
      )
      return loaded
    },
    settled: indexName => loads.get(indexName) ?? Promise.resolve(),
    startGraphRepairs,
  }
}

export interface SwitchTurn {
  mayStart(): boolean
  swap(): boolean
  checkpoint(): Promise<void>
  afterSettling(): void
}

export async function switchInTurn(turns: CheckpointTurns, turn: SwitchTurn): Promise<boolean> {
  let swapped = false
  await checkpointInTurn(turns, {
    joinsInFlight: false,
    mayStart: turn.mayStart,
    perform: async () => {
      swapped = turn.swap()
      if (swapped) await turn.checkpoint()
    },
    afterSettling: turn.afterSettling,
  })
  return swapped
}

export async function checkpointInTurn(turns: CheckpointTurns, turn: CheckpointTurn): Promise<void> {
  if (turn.joinsInFlight && turns.checkpointInFlight !== null) return turns.checkpointInFlight
  while (turns.checkpointInFlight !== null) await turns.checkpointInFlight.catch(() => undefined)
  if (!turn.mayStart()) return
  const run = turn.perform().finally(() => {
    turns.checkpointInFlight = null
    turn.afterSettling()
  })
  turns.checkpointInFlight = run
  return run
}
