const { execFileSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const BINARY = 'narsil-core.node'
const BUILDS = {
  'darwin-arm64': { package: 'darwin-arm64', binary: BINARY },
  'darwin-x64': { package: 'darwin-x64', binary: BINARY },
  'linux-arm64': { package: 'linux-arm64', binary: BINARY },
  'linux-arm64-musl': { package: 'linux-arm64', binary: join('musl', BINARY) },
  'linux-x64': { package: 'linux-x64', binary: BINARY },
  'linux-x64-musl': { package: 'linux-x64', binary: join('musl', BINARY) },
  'win32-arm64': { package: 'win32-arm64', binary: BINARY },
  'win32-x64': { package: 'win32-x64', binary: BINARY },
}
const PACKAGES = [...new Set(Object.values(BUILDS).map(build => build.package))]
const ARTIFACTS_DIRECTORY = join('packages', 'native', 'artifacts')
const PLATFORM_PACKAGES_DIRECTORY = join('packages', 'native', 'npm')
const LIBRARY_MANIFEST = join('packages', 'ts', 'package.json')

const [version, distTag] = process.argv.slice(2)
if (!version || !distTag) {
  console.error('Usage: publish-native-packages.js <version> <dist-tag>')
  process.exit(2)
}

function alreadyOnTheRegistry(packageName) {
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

function rewriteManifest(manifestPath, apply) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  apply(manifest)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

for (const [build, { package: packageName, binary }] of Object.entries(BUILDS)) {
  const built = join(ARTIFACTS_DIRECTORY, `narsil-native-${build}`, BINARY)
  if (!existsSync(built)) {
    console.error(`The downloaded artifacts hold no ${BINARY} for ${build}`)
    process.exit(1)
  }
  const destination = join(PLATFORM_PACKAGES_DIRECTORY, packageName, binary)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(built, destination)
}

let publishedCount = 0
const refused = []
for (const packageName of PACKAGES) {
  const packageDirectory = join(PLATFORM_PACKAGES_DIRECTORY, packageName)
  rewriteManifest(join(packageDirectory, 'package.json'), manifest => {
    manifest.version = version
  })
  if (alreadyOnTheRegistry(`@delali/narsil-native-${packageName}`)) {
    console.log(`npm already holds @delali/narsil-native-${packageName}@${version}, so this script skips it`)
    continue
  }
  try {
    execFileSync('npm', ['publish', '--tag', distTag, '--access', 'public'], {
      cwd: packageDirectory,
      stdio: 'inherit',
    })
    publishedCount++
  } catch {
    refused.push(`@delali/narsil-native-${packageName}`)
  }
}

if (refused.length > 0) {
  console.error(
    `npm publish failed for ${refused.length} of ${PACKAGES.length} platform packages at ${version}: ${refused.join(', ')}. ` +
      'This workflow can publish a package only where npm holds a trusted publisher for it. ' +
      'npm stores a trusted publisher only for a package that already exists, so publish each new package once by hand, ' +
      'then configure its publisher with: npm trust github <package> --file publish.yml --repo assetcorp/narsil',
  )
  process.exit(1)
}

rewriteManifest(LIBRARY_MANIFEST, manifest => {
  manifest.optionalDependencies = {}
  for (const packageName of PACKAGES) {
    manifest.optionalDependencies[`@delali/narsil-native-${packageName}`] = version
  }
})

console.log(
  `This script published ${publishedCount} of ${PACKAGES.length} platform packages at ${version} under the ${distTag} tag`,
)
