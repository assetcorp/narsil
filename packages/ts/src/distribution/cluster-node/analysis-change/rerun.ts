import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnalysisView } from './view'

export async function rerunOnNewerGeneration<T>(
  view: AnalysisView,
  indexName: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof NarsilError) || error.code !== ErrorCodes.ANALYSIS_GENERATION_MISSING) throw error
    await view.refresh(indexName)
    return run()
  }
}
