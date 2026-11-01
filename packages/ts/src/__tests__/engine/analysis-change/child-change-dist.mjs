import { createNarsil, registerLanguage, registerTokenizer } from '../../../../dist/index.mjs'

const CHILD_WRITES = 10

function dashedTokensOf(text) {
  const tokens = []
  for (const word of text.toLowerCase().split(/[\s-]+/)) {
    if (word.length > 0) tokens.push({ token: word, position: tokens.length })
  }
  return tokens
}

async function writeWhileChanging(narsil) {
  for (let i = 0; i < CHILD_WRITES; i++) {
    await narsil.insert('prose', { title: 'sea-wall stone' }, `child-${i}`)
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
  registerLanguage({ name: 'change-plain-fixture', revision: '1', stemmer: null, stopWords: new Set() })
  registerTokenizer('change-dashes', { tokenize: dashedTokensOf })
  const narsil = await createNarsil({ durability: { directory }, workers: { enabled: false } })

  let finished = false
  narsil.changeAnalysis('prose', { tokenizer: 'change-dashes' }).then(
    () => {
      finished = true
    },
    error => {
      process.stderr.write(`change failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(4)
    },
  )
  await writeWhileChanging(narsil)
  if (process.env.NARSIL_KILL_AT === 'after-checkpoint') await narsil.checkpoint('prose')
  process.stdout.write(finished ? 'LATE\n' : 'READY\n')
  setInterval(() => undefined, 60_000)
}

main().catch(err => {
  process.stderr.write(`child error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
