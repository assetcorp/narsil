const { readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { codeBlocksIn, describe } = require('./readme-code-blocks.js')
const { checkGo, checkPython, checkTypescript, report, withWorkspace } = require('./example-checkers.js')

const REPOSITORY_ROOT = resolve(__dirname, '..', '..')
const GUIDES_DIRECTORY = join(REPOSITORY_ROOT, 'docs')
const SKILLS_DIRECTORY = join(REPOSITORY_ROOT, 'skills')
const TYPESCRIPT_PACKAGE = join(REPOSITORY_ROOT, 'packages', 'ts')
const REACT_NATIVE_PACKAGE = join(REPOSITORY_ROOT, 'packages', 'react-native')
const PYTHON_CLIENT_PACKAGE = join(REPOSITORY_ROOT, 'packages', 'python')
const GO_CLIENT_MODULE = join(REPOSITORY_ROOT, 'packages', 'go')
const GO_CHANGES_MODULE = join(GO_CLIENT_MODULE, 'changes')
const REACT_NATIVE_IMPORT = /from\s+['"]@delali\/narsil-react-native(?:\/[^'"]*)?['"]/
const TYPESCRIPT_FENCES = new Set(['ts', 'typescript', 'tsx'])
const PYTHON_FENCES = new Set(['python', 'py'])
const GO_FENCES = new Set(['go'])

function markdownIn(directory, recursive) {
  return readdirSync(directory, { withFileTypes: true, recursive })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => join(entry.parentPath, entry.name))
}

function guidePaths() {
  return [...markdownIn(GUIDES_DIRECTORY, false), ...markdownIn(SKILLS_DIRECTORY, true)].sort()
}

function selectedGuides(requested) {
  const guides = guidePaths()
  if (requested.length === 0) return guides
  return requested.map(path => {
    const absolute = resolve(path)
    if (!guides.includes(absolute)) {
      throw new Error(`${path} is neither a guide directly under docs/ nor a Markdown file under skills/`)
    }
    return absolute
  })
}

function main() {
  const blocks = selectedGuides(process.argv.slice(2)).flatMap(codeBlocksIn)
  const unchecked = blocks.filter(
    block =>
      !block.skipped &&
      !TYPESCRIPT_FENCES.has(block.language) &&
      !PYTHON_FENCES.has(block.language) &&
      !GO_FENCES.has(block.language),
  )
  if (unchecked.length > 0) {
    const listed = unchecked.map(block => `  ${describe(block)} (${block.language || 'no language'})`).join('\n')
    throw new Error(`These code blocks are in no language that the check compiles, so mark each one skip:\n${listed}`)
  }
  const checked = blocks.filter(block => !block.skipped)
  const typescript = checked.filter(block => TYPESCRIPT_FENCES.has(block.language))
  const reactNative = typescript.filter(block => REACT_NATIVE_IMPORT.test(block.code))
  const engine = typescript.filter(block => !REACT_NATIVE_IMPORT.test(block.code))
  const python = checked.filter(block => PYTHON_FENCES.has(block.language))
  const go = checked.filter(block => GO_FENCES.has(block.language))

  if (engine.length > 0) checkTypescript(engine, TYPESCRIPT_PACKAGE)
  if (reactNative.length > 0) checkTypescript(reactNative, REACT_NATIVE_PACKAGE)
  if (python.length > 0) withWorkspace(workspace => checkPython(python, PYTHON_CLIENT_PACKAGE, workspace))
  if (go.length > 0) withWorkspace(workspace => checkGo(go, GO_CLIENT_MODULE, workspace, [GO_CHANGES_MODULE]))
  report(blocks)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
