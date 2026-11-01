import type { EngineCore, IndexRegistryEntry } from './core'

function holdsChangeWork(entry: IndexRegistryEntry | undefined): boolean {
  return entry !== undefined && (entry.pendingAnalysis !== null || entry.durableAnalysis !== null)
}

export async function abandonChangeOf(core: EngineCore, indexName: string): Promise<void> {
  if (!holdsChangeWork(core.indexRegistry.get(indexName))) return
  const { abandonAnalysisChange } = await import('./analysis-change')
  await abandonAnalysisChange(core, indexName)
}

export async function resumeChangeOf(core: EngineCore, indexName: string): Promise<void> {
  if ((core.indexRegistry.get(indexName)?.pendingAnalysis ?? null) === null) return
  if (core.mutationCtx.capacityScope === 'partition') return
  if (core.executor.getManager(indexName) === undefined) return
  const { resumeAnalysisChange } = await import('./analysis-change')
  void resumeAnalysisChange(core, indexName).catch(() => undefined)
}

export async function resumeEveryChange(core: EngineCore): Promise<void> {
  for (const indexName of [...core.indexRegistry.keys()]) await resumeChangeOf(core, indexName)
}
