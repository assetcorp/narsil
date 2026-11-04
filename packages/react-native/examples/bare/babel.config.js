module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'react-native-worklets/plugin',
      {
        bundleMode: true,
        strictGlobal: true,
        importForwarding: { relativePaths: ['packages/react-native/src', 'packages/react-native/examples/bare/src'] },
      },
    ],
  ],
}
