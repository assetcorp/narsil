module.exports = api => {
  api.cache(true)
  return {
    presets: [['babel-preset-expo', { worklets: false }]],
    plugins: [
      [
        'react-native-worklets/plugin',
        { bundleMode: true, strictGlobal: true, importForwarding: { relativePaths: ['packages/react-native/src'] } },
      ],
    ],
  }
}
