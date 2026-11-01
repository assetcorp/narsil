import type { CheckpointStore } from '../durability/segment/store'

export async function writeArchiveFile(
  store: CheckpointStore,
  key: string,
  chunks: AsyncIterable<Uint8Array>,
): Promise<void> {
  const { directory } = store
  if (directory === undefined) {
    const held: Uint8Array[] = []
    for await (const chunk of chunks) held.push(chunk)
    await store.write(key, held)
    return
  }
  const receiving = `${key}.receiving`
  await directory.remove(receiving)
  const handle = await directory.appendHandle(receiving)
  try {
    for await (const chunk of chunks) await handle.append(chunk)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await directory.move(receiving, key)
}
