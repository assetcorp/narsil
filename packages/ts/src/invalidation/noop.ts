import type { InvalidationAdapter } from '../types/adapters'

export function createNoopInvalidation(): InvalidationAdapter {
  return {
    async publish(): Promise<void> {},

    async subscribe(): Promise<void> {},

    async shutdown(): Promise<void> {},
  }
}
