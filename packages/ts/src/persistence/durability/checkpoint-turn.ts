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
  track(indexName: string, load: Promise<void>): Promise<void>
  settled(indexName: string): Promise<void>
}

export function createIndexLoads(): IndexLoads {
  const loads = new Map<string, Promise<void>>()
  return {
    track(indexName, load) {
      loads.set(
        indexName,
        load.catch(() => undefined),
      )
      return load
    },
    settled: indexName => loads.get(indexName) ?? Promise.resolve(),
  }
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
