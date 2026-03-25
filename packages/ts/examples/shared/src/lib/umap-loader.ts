export interface UmapData {
  positions: Float32Array
  ids: string[]
  count: number
}

export async function loadUmapData(basePath: string, prefix: string): Promise<UmapData> {
  const [binResponse, idsResponse] = await Promise.all([
    fetch(`${basePath}${prefix}-umap-3d.bin`),
    fetch(`${basePath}${prefix}-vector-ids.json`),
  ])

  if (!binResponse.ok) {
    throw new Error(`Failed to load UMAP binary: ${binResponse.status}`)
  }
  if (!idsResponse.ok) {
    throw new Error(`Failed to load vector IDs: ${idsResponse.status}`)
  }

  const [buffer, ids] = await Promise.all([binResponse.arrayBuffer(), idsResponse.json() as Promise<string[]>])

  const view = new DataView(buffer)
  const count = view.getUint32(0, true)
  const dims = view.getUint32(4, true)

  if (dims !== 3) {
    throw new Error(`Expected 3D UMAP data, got ${dims} dimensions`)
  }

  const positions = new Float32Array(buffer, 8, count * 3)

  return { positions, ids, count }
}
