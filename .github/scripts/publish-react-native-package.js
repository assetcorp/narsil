const { execFileSync } = require('node:child_process')
const { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const PACKAGE_NAME = '@delali/narsil-react-native'
const ENGINE_PACKAGE_NAME = '@delali/narsil'
const PACKAGE_DIRECTORY = join('packages', 'react-native')
const MANIFEST = join(PACKAGE_DIRECTORY, 'package.json')

const [version, distTag] = process.argv.slice(2)
if (!version || !distTag) {
  console.error('Usage: publish-react-native-package.js <version> <dist-tag>')
  process.exit(2)
}

function onTheRegistry(packageName) {
  try {
    const published = execFileSync('npm', ['view', `${packageName}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return published.trim() === version
  } catch {
    return false
  }
}

if (onTheRegistry(PACKAGE_NAME)) {
  console.log(`npm already holds ${PACKAGE_NAME}@${version}, so this script skips it`)
  process.exit(0)
}

if (!onTheRegistry(ENGINE_PACKAGE_NAME)) {
  console.error(
    `npm holds no ${ENGINE_PACKAGE_NAME}@${version}, and ${PACKAGE_NAME}@${version} requires exactly that version, so this script publishes nothing`,
  )
  process.exit(1)
}

const originalManifest = readFileSync(MANIFEST, 'utf8')
const manifest = JSON.parse(originalManifest)
manifest.version = version
manifest.peerDependencies[ENGINE_PACKAGE_NAME] = version
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

function packAndPublish(packDirectory) {
  execFileSync('pnpm', ['pack', '--pack-destination', packDirectory], { cwd: PACKAGE_DIRECTORY, stdio: 'inherit' })
  const tarballs = readdirSync(packDirectory).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`pnpm pack wrote ${tarballs.length} tarballs to ${packDirectory}, where this script expects one`)
  }
  execFileSync('npm', ['publish', join(packDirectory, tarballs[0]), '--tag', distTag, '--access', 'public'], {
    stdio: 'inherit',
  })
  console.log(`Published ${PACKAGE_NAME}@${version} under the ${distTag} dist-tag`)
}

const packDirectory = mkdtempSync(join(tmpdir(), 'narsil-react-native-'))
try {
  packAndPublish(packDirectory)
} finally {
  writeFileSync(MANIFEST, originalManifest)
  rmSync(packDirectory, { recursive: true, force: true })
}
