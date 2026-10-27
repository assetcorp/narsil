import { createNarsil, registerLanguage } from '../../../../dist/index.mjs'

const LANGUAGE = 'switch-fixture'
const WRITES = 10

function stripProgressive(token) {
  return token.endsWith('ing') ? token.slice(0, -3) : token
}

async function writeWhileDue(narsil) {
  for (let i = 0; i < WRITES; i++) {
    await narsil.insert('prose', { title: 'jumping stone' }, `child-${i}`)
  }
  await narsil.remove('prose', 'doc-1')
}

async function main() {
  const directory = process.env.NARSIL_DIR
  if (directory === undefined) {
    process.stderr.write('missing NARSIL_DIR\n')
    process.exit(2)
    return
  }
  registerLanguage({ name: LANGUAGE, revision: '2', stemmer: stripProgressive, stopWords: new Set() })
  const narsil = await createNarsil({
    durability: { directory },
    analysis: { rebuild: 'manual' },
    workers: { enabled: false },
  })

  if (process.env.NARSIL_KILL_AT === 'after-checkpoint') {
    await writeWhileDue(narsil)
    await narsil.checkpoint('prose')
    process.stdout.write('READY\n')
  } else {
    let finished = false
    narsil.rebuildAnalysis('prose').then(
      () => {
        finished = true
      },
      error => {
        process.stderr.write(`rebuild failed: ${error instanceof Error ? error.message : String(error)}\n`)
        process.exit(4)
      },
    )
    await writeWhileDue(narsil)
    process.stdout.write(finished ? 'LATE\n' : 'READY\n')
  }

  setInterval(() => undefined, 60_000)
}

main().catch(err => {
  process.stderr.write(`child error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
