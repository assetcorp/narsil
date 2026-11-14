const { resolve } = require('node:path')
const { codeBlocksIn } = require('./readme-code-blocks.js')
const { checkGo, checkPython, checkTypescript, report, withWorkspace } = require('./example-checkers.js')

const CHECKS_BY_LANGUAGE = {
  go: { fences: ['go'], check: (blocks, root) => withWorkspace(workspace => checkGo(blocks, root, workspace)) },
  python: {
    fences: ['python', 'py'],
    check: (blocks, root) => withWorkspace(workspace => checkPython(blocks, root, workspace)),
  },
  typescript: { fences: ['ts', 'typescript', 'tsx'], check: (blocks, root) => checkTypescript(blocks, root) },
}

function main() {
  const [language, ...readmes] = process.argv.slice(2)
  const checker = CHECKS_BY_LANGUAGE[language]
  if (checker === undefined || readmes.length === 0) {
    console.error(`Usage: check-readme-examples.js <${Object.keys(CHECKS_BY_LANGUAGE).join('|')}> <README path>...`)
    process.exit(2)
  }
  const packageRoot = process.cwd()
  const blocks = []
  for (const readme of readmes) {
    const found = codeBlocksIn(resolve(packageRoot, readme)).filter(block => checker.fences.includes(block.language))
    if (found.length === 0) throw new Error(`${readme} holds no ${checker.fences.join(' or ')} code block to check`)
    blocks.push(...found)
  }
  const checked = blocks.filter(block => !block.skipped)
  if (checked.length > 0) checker.check(checked, packageRoot)
  report(blocks)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
