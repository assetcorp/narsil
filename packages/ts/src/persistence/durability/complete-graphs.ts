import type { VectorIndex } from '../../vector/vector-index'

export async function whileGraphsStayComplete<T>(
  vectorIndexes: ReadonlyMap<string, VectorIndex>,
  capture: () => T | Promise<T>,
): Promise<T> {
  const letBuildsIn: Array<() => void> = []
  try {
    for (const fieldPath of [...vectorIndexes.keys()].sort()) {
      const vectorIndex = vectorIndexes.get(fieldPath)
      if (vectorIndex !== undefined) letBuildsIn.push(await vectorIndex.holdGraphComplete())
    }
    return await capture()
  } finally {
    for (const release of letBuildsIn) release()
  }
}
