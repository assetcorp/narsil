const { createRunOncePlugin, withGradleProperties } = require('expo/config-plugins')
const packageJson = require('./package.json')

const ARCHITECTURES_PROPERTY = 'reactNativeArchitectures'
const SIXTY_FOUR_BIT_ARCHITECTURES = 'arm64-v8a,x86_64'

function withSixtyFourBitAndroid(config) {
  return withGradleProperties(config, modified => {
    const properties = modified.modResults
    const existing = properties.find(item => item.type === 'property' && item.key === ARCHITECTURES_PROPERTY)
    if (existing === undefined) {
      properties.push({ type: 'property', key: ARCHITECTURES_PROPERTY, value: SIXTY_FOUR_BIT_ARCHITECTURES })
    } else {
      existing.value = SIXTY_FOUR_BIT_ARCHITECTURES
    }
    return modified
  })
}

function withNarsil(config, options = {}) {
  if (options.keep32BitAndroid === true) return config
  return withSixtyFourBitAndroid(config)
}

module.exports = createRunOncePlugin(withNarsil, packageJson.name, packageJson.version)
