import { ErrorCodes, NarsilError } from '../../errors'
import type { IndexConfig } from '../../types/schema'
import type { OrchestratorState } from './types'

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function isDeterministicFailure(error: Error): boolean {
  return error instanceof NarsilError && error.code === ErrorCodes.CONFIG_INVALID
}

export function alreadyPresentOnWorker(reason: unknown): boolean {
  return reason instanceof NarsilError && reason.code === ErrorCodes.DOC_ALREADY_EXISTS
}

function assertConfigReachesWorker(indexName: string, config: IndexConfig, bootstrapModule: string | undefined): void {
  if (config.tokenizer !== undefined && typeof config.tokenizer !== 'string') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index "${indexName}" holds a tokenizer instance, and no worker thread can receive one. Register the tokenizer with registerTokenizer and name it in the index config`,
      { indexName },
    )
  }
  if (typeof config.stopWords === 'function') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index "${indexName}" holds a stop word function, and no worker thread can receive one. Register the function with registerStopWords and name it in the index config`,
      { indexName },
    )
  }
  const language = config.language ?? 'english'
  if (language !== 'english' && bootstrapModule === undefined) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index "${indexName}" uses language "${language}", which a worker thread registers only from a bootstrap module. Set workers.bootstrapModule to a module that registers it`,
      { indexName, language },
    )
  }
}

export function workerIneligibility(
  indexName: string,
  config: IndexConfig,
  bootstrapModule: string | undefined,
): NarsilError | null {
  try {
    assertConfigReachesWorker(indexName, config, bootstrapModule)
    return null
  } catch (err) {
    if (err instanceof NarsilError && err.code === ErrorCodes.CONFIG_INVALID) {
      return err
    }
    throw err
  }
}

export function reportIneligible(state: OrchestratorState, indexName: string, error: NarsilError): void {
  if (state.reportedIneligible.has(indexName)) return
  state.reportedIneligible.add(indexName)
  state.callbacks?.onCopyLoadFailure?.('index-excluded', error, false)
}

export function eligibleIndexNames(state: OrchestratorState): string[] {
  const names: string[] = []
  for (const [name, entry] of state.indexRegistry) {
    const ineligibility = workerIneligibility(name, entry.config, state.bootstrapModule)
    if (ineligibility) {
      reportIneligible(state, name, ineligibility)
      continue
    }
    names.push(name)
  }
  return names
}

export function collectEligibleIndexes(state: OrchestratorState): Map<string, { documentCount: number }> {
  const eligible = new Map<string, { documentCount: number }>()
  for (const name of eligibleIndexNames(state)) {
    const manager = state.executor.getManager(name)
    eligible.set(name, { documentCount: manager?.countDocuments() ?? 0 })
  }
  return eligible
}
