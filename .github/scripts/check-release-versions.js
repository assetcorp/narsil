const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { manifestVersion, markdownFilesInScope, problemsIn } = require('./release-versions.js')

const REPOSITORY_ROOT = resolve(__dirname, '..', '..')

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function main() {
  const versions = new Map()
  const versionOf = project => {
    if (!versions.has(project)) versions.set(project, manifestVersion(REPOSITORY_ROOT, project, readText))
    return versions.get(project)
  }
  const files = markdownFilesInScope(REPOSITORY_ROOT)
  const problems = files.flatMap(path =>
    problemsIn(path, readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8'), versionOf),
  )
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    console.error(
      'Wrap each line that names a released Narsil version in <!-- release-version <project> --> and <!-- /release-version -->, and keep the version equal to that project manifest.',
    )
    process.exit(1)
  }
  const marked = [...versions].map(([project, version]) => `${project} ${version}`).join(', ')
  console.log(`${files.length} Markdown files checked; the marked lines name ${marked || 'no project'}.`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
