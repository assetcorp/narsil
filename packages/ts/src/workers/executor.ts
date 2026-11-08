import type { WorkerAction } from './protocol'

export interface Executor {
  execute<T>(action: WorkerAction, transfer?: object[]): Promise<T>
  executeRetained?<T>(action: WorkerAction, settled: () => void): Promise<T>
  shutdown(): Promise<void>
}

export function executeRetained<T>(executor: Executor, action: WorkerAction, settled: () => void): Promise<T> {
  try {
    return executor.executeRetained === undefined
      ? executor.execute<T>(action).finally(settled)
      : executor.executeRetained<T>(action, settled)
  } catch (error) {
    settled()
    return Promise.reject(error)
  }
}
