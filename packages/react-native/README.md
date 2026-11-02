# @delali/narsil-react-native

`@delali/narsil-react-native` runs a Narsil search engine inside an iOS or Android app, so that the app can search its own documents by keyword, by vector, or by both while the phone is offline. The engine works on a Hermes runtime of its own, which keeps the app's JS thread free while a search or an import works, and it keeps each index in files in the app's private storage, so that the index survives a restart.

## Install

```bash
npm install @delali/narsil @delali/narsil-react-native react-native-nitro-modules react-native-worklets
```

The package carries native code, so it needs a development build with React Native's New Architecture. Expo Go has no such build, and the package compiles for 64-bit Android alone, so `createNarsil` rejects with `NATIVE_DEPENDENCY_MISSING` in Expo Go and on a 32-bit Android phone.

## Use it

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

Every method resolves through a promise, and otherwise it takes the same arguments and returns the same answer as the method of the same name in `@delali/narsil`.

## Set up the app

The engine's runtime loads this package's code through Worklets Bundle Mode, so the app's Babel and Metro settings have to turn Bundle Mode on and forward the package's source to that runtime. An Expo app also adds the config plugin to `app.json`:

```json
{
  "expo": {
    "plugins": ["@delali/narsil-react-native"]
  }
}
```

The [React Native guide](https://github.com/assetcorp/narsil/blob/main/docs/react-native.md) gives the Babel and Metro settings for an app with Expo and for an app without it, and it covers where the index lives, snapshots, memory, and errors.

## License

Apache-2.0
