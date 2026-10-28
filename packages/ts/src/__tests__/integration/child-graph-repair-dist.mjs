import { readFile } from 'node:fs/promises'
import { createNarsil } from '../../../dist/index.mjs'

const RESTORED_INDEX = 'earlier'

async function main() {
  const directory = process.env.NARSIL_DIR
  const snapshot = process.env.NARSIL_SNAPSHOT
  if (directory === undefined || snapshot === undefined) {
    process.stderr.write('missing NARSIL_DIR or NARSIL_SNAPSHOT\n')
    process.exit(2)
    return
  }
  const narsil = await createNarsil({
    durability: { directory, checkpointIntervalMs: 0 },
    workers: { enabled: false },
  })
  await narsil.restore(RESTORED_INDEX, new Uint8Array(await readFile(snapshot)))
  const [field] = narsil.vectorMaintenanceStatus(RESTORED_INDEX)
  process.stdout.write(field?.building ? 'REPAIRING\n' : 'IDLE\n')
  setInterval(() => undefined, 60_000)
}

main().catch(err => {
  process.stderr.write(`child error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
