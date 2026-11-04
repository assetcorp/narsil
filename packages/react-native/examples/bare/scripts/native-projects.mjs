import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_NAME = 'NarsilBare'
const TEMPLATE_NAME = 'HelloWorld'
const ANDROID_ARCHITECTURES = 'arm64-v8a,x86_64'
const BINARY_EXTENSIONS = new Set(['.jar', '.keystore', '.png', '.jpg', '.jpeg', '.webp', '.ttf', '.otf'])
const DOTFILE_PREFIX = '_'
const TEMPLATE_BUNDLE_IDENTIFIER = '"org.reactjs.native.example.$(PRODUCT_NAME:rfc1034identifier)"'
const BUNDLE_IDENTIFIER = 'com.sondelali.narsil.bare'
const HARNESS_URL_LAUNCH_ARGUMENT = 'NarsilHarnessURL'
const LOCAL_NETWORK_PURPOSE = 'Narsil Bare sends its search results to the computer that runs the checks.'

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(exampleRoot, 'package.json'))
const templateRoot = join(dirname(require.resolve('@react-native-community/template/package.json')), 'template')

function renamed(text) {
  return text.replaceAll(TEMPLATE_NAME, APP_NAME).replaceAll(TEMPLATE_NAME.toLowerCase(), APP_NAME.toLowerCase())
}

function targetName(name) {
  const visible = name.startsWith(DOTFILE_PREFIX) ? `.${name.slice(DOTFILE_PREFIX.length)}` : name
  return renamed(visible)
}

function copyRenamed(source, target) {
  const stats = statSync(source)
  if (stats.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const name of readdirSync(source)) copyRenamed(join(source, name), join(target, targetName(name)))
    return
  }
  const bytes = readFileSync(source)
  writeFileSync(target, BINARY_EXTENSIONS.has(extname(source).toLowerCase()) ? bytes : renamed(bytes.toString('utf8')))
  chmodSync(target, stats.mode)
}

function keepSixtyFourBitAndroid(androidRoot) {
  const path = join(androidRoot, 'gradle.properties')
  const properties = readFileSync(path, 'utf8')
  const line = `reactNativeArchitectures=${ANDROID_ARCHITECTURES}`
  const updated = /^reactNativeArchitectures=.*$/m.test(properties)
    ? properties.replace(/^reactNativeArchitectures=.*$/m, line)
    : `${properties.trimEnd()}\n${line}\n`
  writeFileSync(path, updated)
}

function replaceOrFail(path, search, replacement) {
  const text = readFileSync(path, 'utf8')
  if (!text.includes(search)) throw new Error(`${path} no longer holds ${search}`)
  writeFileSync(path, text.replaceAll(search, replacement))
}

function prepareIosForHarness(iosRoot) {
  replaceOrFail(
    join(iosRoot, `${APP_NAME}.xcodeproj`, 'project.pbxproj'),
    TEMPLATE_BUNDLE_IDENTIFIER,
    BUNDLE_IDENTIFIER,
  )
  replaceOrFail(
    join(iosRoot, APP_NAME, 'Info.plist'),
    '<key>NSLocationWhenInUseUsageDescription</key>',
    `<key>NSLocalNetworkUsageDescription</key>\n\t<string>${LOCAL_NETWORK_PURPOSE}</string>\n\t<key>NSLocationWhenInUseUsageDescription</key>`,
  )
  replaceOrFail(
    join(iosRoot, APP_NAME, 'AppDelegate.swift'),
    ') -> Bool {\n    true\n  }',
    `) -> Bool {\n    if UserDefaults.standard.string(forKey: "${HARNESS_URL_LAUNCH_ARGUMENT}") != nil {\n      UIApplication.shared.isIdleTimerDisabled = true\n    }\n    return true\n  }`,
  )
}

function reachHarnessFromAndroid(androidRoot) {
  replaceOrFail(
    join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml'),
    'android:usesCleartextTraffic="${usesCleartextTraffic}"',
    'android:usesCleartextTraffic="true"',
  )
}

for (const platform of ['ios', 'android']) {
  const target = join(exampleRoot, platform)
  rmSync(target, { recursive: true, force: true })
  copyRenamed(join(templateRoot, platform), target)
}
keepSixtyFourBitAndroid(join(exampleRoot, 'android'))
prepareIosForHarness(join(exampleRoot, 'ios'))
reachHarnessFromAndroid(join(exampleRoot, 'android'))
console.log(`Wrote ios/ and android/ for ${APP_NAME} from ${templateRoot}`)
