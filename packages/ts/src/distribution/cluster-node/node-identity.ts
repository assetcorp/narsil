import { getFs, getPath } from '#platform/durable-fs'
import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'

const NODE_ID_FILE_NAME = '.narsil-node-id'
const STORED_NODE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

async function readStoredNodeId(filePath: string): Promise<string | null> {
  const fs = await getFs()
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return null
    throw error
  }
  const nodeId = text.trim()
  if (!STORED_NODE_ID_PATTERN.test(nodeId)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The node id file "${filePath}" holds no node id that this node wrote. Restore the file, or delete it so that the node starts under a new id, which leaves the copies it held for the cluster to rebuild`,
      { file: filePath },
    )
  }
  return nodeId
}

async function syncDirectory(directory: string): Promise<void> {
  const fs = await getFs()
  const handle = await fs.open(directory, 'r').catch(() => null)
  if (handle === null) return
  try {
    await handle.sync().catch(() => undefined)
  } finally {
    await handle.close()
  }
}

async function storeNewNodeId(directory: string, filePath: string): Promise<string> {
  const fs = await getFs()
  const nodeId = generateId()
  const draftPath = `${filePath}.${process.pid}.draft`
  const handle = await fs.open(draftPath, 'w')
  try {
    await handle.writeFile(`${nodeId}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(draftPath, filePath)
  await syncDirectory(directory)
  return nodeId
}

export async function resolveNodeId(
  explicitNodeId: string | undefined,
  directory: string | undefined,
): Promise<string> {
  if (explicitNodeId !== undefined) return explicitNodeId
  if (directory === undefined) return generateId()

  const pathModule = await getPath()
  const root = pathModule.resolve(directory)
  const filePath = pathModule.join(root, NODE_ID_FILE_NAME)
  try {
    return (await readStoredNodeId(filePath)) ?? (await storeNewNodeId(root, filePath))
  } catch (error) {
    if (error instanceof NarsilError) throw error
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `The node cannot read or store its id in "${root}"`, {
      directory: root,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}
