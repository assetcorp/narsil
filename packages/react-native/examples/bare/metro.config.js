const path = require('node:path')
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')
const { getBundleModeMetroConfig } = require('react-native-worklets/bundleMode')

const workspaceRoot = path.resolve(__dirname, '../../../..')

const monorepo = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [path.join(__dirname, 'node_modules'), path.join(workspaceRoot, 'node_modules')],
  },
}

module.exports = getBundleModeMetroConfig(mergeConfig(getDefaultConfig(__dirname), monorepo))
