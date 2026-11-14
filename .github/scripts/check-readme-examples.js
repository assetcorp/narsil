const { resolve } = require('node:path')
const { codeBlocksIn, describe } = require('./readme-code-blocks.js')
const { checkGo, checkPython, checkTypescript, report, withWorkspace } = require('./example-checkers.js')

const TYPE_CHECK_ONLY_FLAG = '--type-check-only'
const EXECUTE_ONLY_FLAG = '--execute-only'

const CHECKS_BY_LANGUAGE = {
  go: { fences: ['go'], check: (blocks, root) => withWorkspace(workspace => checkGo(blocks, root, workspace)) },
  python: {
    fences: ['python', 'py'],
    stages: true,
    check: (blocks, root, stages) => withWorkspace(workspace => checkPython(blocks, root, workspace, stages)),
  },
  typescript: { fences: ['ts', 'typescript', 'tsx'], check: (blocks, root) => checkTypescript(blocks, root) },
}

function stagesFrom(flags) {
  const unknown = flags.filter(flag => flag !== TYPE_CHECK_ONLY_FLAG && flag !== EXECUTE_ONLY_FLAG)
  if (unknown.length > 0) throw new Error(`Unknown option ${unknown.join(', ')}`)
  const typeCheckOnly = flags.includes(TYPE_CHECK_ONLY_FLAG)
  const executeOnly = flags.includes(EXECUTE_ONLY_FLAG)
  if (typeCheckOnly && executeOnly) throw new Error(`Pass ${TYPE_CHECK_ONLY_FLAG} or ${EXECUTE_ONLY_FLAG}, not both`)
  return { typeCheck: !executeOnly, execute: !typeCheckOnly }
}

function main() {
  const [language, ...rest] = process.argv.slice(2)
  const flags = rest.filter(argument => argument.startsWith('--'))
  const readmes = rest.filter(argument => !argument.startsWith('--'))
  const checker = CHECKS_BY_LANGUAGE[language]
  if (checker === undefined || readmes.length === 0) {
    const languages = Object.keys(CHECKS_BY_LANGUAGE).join('|')
    console.error(
      `Usage: check-readme-examples.js <${languages}> [${TYPE_CHECK_ONLY_FLAG}|${EXECUTE_ONLY_FLAG}] <README path>...`,
    )
    process.exit(2)
  }
  const stages = stagesFrom(flags)
  if (flags.length > 0 && !checker.stages) throw new Error(`The ${language} check takes no stage option`)
  const packageRoot = process.cwd()
  const blocks = []
  for (const readme of readmes) {
    const found = codeBlocksIn(resolve(packageRoot, readme))
    const unchecked = found.filter(block => !block.skipped && !checker.fences.includes(block.language))
    if (unchecked.length > 0) {
      const listed = unchecked.map(block => `  ${describe(block)} (${block.language || 'no language'})`).join('\n')
      throw new Error(
        `These code blocks are in no language that the ${language} check compiles, so mark each one skip:\n${listed}`,
      )
    }
    const inLanguage = found.filter(block => checker.fences.includes(block.language))
    if (inLanguage.length === 0)
      throw new Error(`${readme} holds no ${checker.fences.join(' or ')} code block to check`)
    blocks.push(...found)
  }
  const checked = blocks.filter(block => !block.skipped && checker.fences.includes(block.language))
  if (checked.length > 0) checker.check(checked, packageRoot, stages)
  report(blocks, stages)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
