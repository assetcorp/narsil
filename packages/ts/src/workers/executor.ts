import type { WorkerAction } from './protocol'

export interface Executor {
  execute<T>(action: WorkerAction, transfer?: object[]): Promise<T>
  shutdown(): Promise<void>
}
