const { readFileSync } = require('node:fs')
const { basename } = require('node:path')

const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})(.*)$/
const INFO_STRING_SEPARATOR = /[\s,]+/
const SETUP_OPENING = '<!-- example setup'
const COMMENT_CLOSING = '-->'
const EXAMPLE_PLACEHOLDER = '{example}'
const RUN_ATTRIBUTE = 'run'
const SKIP_ATTRIBUTE = 'skip'
const KNOWN_ATTRIBUTES = new Set([RUN_ATTRIBUTE, SKIP_ATTRIBUTE])

function closesFence(line, opening) {
  const trimmed = line.trim()
  if (trimmed.length < opening.length || trimmed[0] !== opening[0]) return false
  return [...trimmed].every(character => character === opening[0]) && line.search(/\S/) <= 3
}

function setupEndingAt(lines, fenceIndex, markdownPath) {
  const closingIndex = fenceIndex - 1
  if (closingIndex < 0 || lines[closingIndex].trim() !== COMMENT_CLOSING) return null
  for (let index = closingIndex - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line.trim() === SETUP_OPENING) return lines.slice(index + 1, closingIndex)
    if (line.includes(COMMENT_CLOSING) || line.trim().startsWith('```')) break
  }
  throw new Error(`${markdownPath}:${closingIndex + 1} closes a comment above a code block without '${SETUP_OPENING}'`)
}

function withSetup(body, setup, location) {
  if (setup === null) return { code: body, setupLineCount: 0 }
  const placeholder = setup.findIndex(line => line.trim() === EXAMPLE_PLACEHOLDER)
  if (placeholder === -1) return { code: [...setup, ...body], setupLineCount: setup.length }
  if (setup.findIndex((line, index) => index > placeholder && line.trim() === EXAMPLE_PLACEHOLDER) !== -1) {
    throw new Error(`${location} holds ${EXAMPLE_PLACEHOLDER} more than once in its setup`)
  }
  return {
    code: [...setup.slice(0, placeholder), ...body, ...setup.slice(placeholder + 1)],
    setupLineCount: placeholder,
  }
}

function codeBlocksIn(markdownPath) {
  const lines = readFileSync(markdownPath, 'utf8').split(/\r?\n/)
  const blocks = []
  let open = null
  lines.forEach((line, index) => {
    if (open !== null) {
      if (!closesFence(line, open.fence)) {
        open.body.push(line)
        return
      }
      const location = `${markdownPath}:${open.line}`
      const { code, setupLineCount } = withSetup(open.body, open.setup, location)
      const unknown = open.attributes.filter(attribute => !KNOWN_ATTRIBUTES.has(attribute))
      if (unknown.length > 0) {
        throw new Error(`${location} marks its code block with ${unknown.join(', ')}, and only run and skip are known`)
      }
      if (open.attributes.includes(RUN_ATTRIBUTE) && open.attributes.includes(SKIP_ATTRIBUTE)) {
        throw new Error(`${location} marks its code block with both run and skip`)
      }
      blocks.push({
        markdownPath,
        line: open.line,
        language: open.language,
        runs: open.attributes.includes(RUN_ATTRIBUTE),
        skipped: open.attributes.includes(SKIP_ATTRIBUTE),
        setupLineCount,
        code: `${code.join('\n')}\n`,
        name: `${basename(markdownPath, '.md')}-L${open.line}`.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase(),
      })
      open = null
      return
    }
    const match = FENCE_OPENING.exec(line)
    if (match === null) return
    const [, fence, infoString] = match
    if (fence[0] === '`' && infoString.includes('`')) return
    const [language = '', ...attributes] = infoString.trim().split(INFO_STRING_SEPARATOR).filter(Boolean)
    open = {
      fence,
      line: index + 1,
      language: language.toLowerCase(),
      attributes,
      body: [],
      setup: setupEndingAt(lines, index, markdownPath),
    }
  })
  if (open !== null) throw new Error(`${markdownPath}:${open.line} opens a code block that the file never closes`)
  return blocks
}

function describe(block) {
  return `${block.markdownPath}:${block.line}`
}

module.exports = { codeBlocksIn, describe }
