# @delali/narsil-react-native

`@delali/narsil-react-native` runs a Narsil search engine inside an iOS or Android app, so that the app can search its own documents by keyword, by vector, or by both while the phone is offline. The engine keeps each index in files in the app's private storage, so that the index survives a restart.

## Install

```bash
npm install @delali/narsil @delali/narsil-react-native react-native-nitro-modules
```

The package carries native code, so it needs a development build with React Native's New Architecture. Expo Go has no such build, and the package compiles for 64-bit Android alone, so `createNarsil` rejects with `NATIVE_DEPENDENCY_MISSING` in Expo Go and on a 32-bit Android phone.

## Use it

<!-- example setup
declare const tentVector: number[]
-->
```ts
import { createNarsil } from '@delali/narsil-react-native'

const narsil = await createNarsil()
await narsil.createIndex('notes', {
  schema: { title: 'string', embedding: 'vector[384]' },
  language: 'english',
})
await narsil.insert('notes', { title: 'Pack the tent poles', embedding: tentVector })
const { hits } = await narsil.query('notes', { term: 'tent', limit: 10 })
```

The engine works on the app's own JS runtime and takes the same settings as on Node.js, including an embedding adapter, a plugin, or a tokenizer. Every method resolves through a promise, and otherwise it takes the same arguments and returns the same answer as the method of the same name in `@delali/narsil`. Each file read, file write, and vector search runs on a native thread, so the app can keep drawing the screen while the engine works.

## Set up the app

An Expo app adds the config plugin to `app.json`, which limits the Android build to 64-bit architectures, and then makes a development build:

```json
{
  "expo": {
    "plugins": ["@delali/narsil-react-native"]
  }
}
```

An app without Expo sets `reactNativeArchitectures=arm64-v8a,x86_64` in `android/gradle.properties` and runs `pod install` before it rebuilds. Neither kind of app needs a change to its Babel or Metro settings.

An app can also run the engine on a separate [Worklets](https://docs.swmansion.com/react-native-worklets/) runtime through `@delali/narsil-react-native/worklets`, which needs `react-native-worklets` and the Bundle Mode settings in Babel and Metro. The [React Native guide](https://github.com/assetcorp/narsil/blob/main/docs/react-native.md) gives those settings, and it covers where the index lives, snapshots, memory, and errors.

## License

Apache-2.0
