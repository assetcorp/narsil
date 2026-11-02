const { getDefaultConfig } = require('expo/metro-config')
const { getBundleModeMetroConfig } = require('react-native-worklets/bundleMode')

module.exports = getBundleModeMetroConfig(getDefaultConfig(__dirname))
