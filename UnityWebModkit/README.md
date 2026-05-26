# NextUWMK

NextUWMK is a Unity WebGL IL2CPP runtime modkit based on UnityWebModkit. It loads as a browser userscript/library, discovers Unity WebGL metadata at runtime, resolves IL2CPP methods and fields, and exposes a compact JavaScript API for instrumentation, hooks, memory reads/writes, and WebAssembly bytecode patches.

This repository contains the 0.1 release: TypeScript source and a prebuilt `dist` bundle.

## What It Does

- Hooks Unity WebGL `WebAssembly.instantiate` / `instantiateStreaming`.
- Extracts `global-metadata.dat` from Unity WebGL data and caches parsed metadata in IndexedDB.
- Resolves IL2CPP method table indexes from metadata and wasm code registration data.
- Supports prefix/postfix method hooks.
- Supports import hooks for wasm import interception.
- Supports small WebAssembly bytecode method patches and method NOP patches.
- Provides `ValueWrapper` and `ClassWrapper` helpers for IL2CPP object fields.
- Provides managed heap helpers for `malloc`, scoped `alloc`, `free`, `memcpy`, and managed string creation.
- Exposes field discovery and field offset overrides for games with missing or unusual field-offset data.

## Documentation

- [Usage.md](Usage.md) - API syntax and examples.
- [CHANGELOG.md](CHANGELOG.md) - changes in version 0.1.

## Build

```bash
npm install
npm run build
```

The browser bundle is emitted into `dist/`.

## Minimal Userscript Shape

```js
// ==UserScript==
// @name         NextUWMK Plugin
// @match        https://example.com/*
// @require      https://your-host/dist/unity-web-modkit.xxxxx.js
// @run-at       document-start
// ==/UserScript==

(function () {
  const UWM = unsafeWindow.UnityWebModkit || window.UnityWebModkit;

  const plugin = UWM.Runtime.createPlugin({
    name: "example-plugin",
    version: "0.1.0",
    referencedAssemblies: ["Assembly-CSharp.dll", "UnityEngine.CoreModule.dll"],
  });

  plugin.onLoaded = () => {
    plugin.logger.info("metadata ready: %o", plugin.metadata);
  };
})();
```

## Credits

This project is based on and credits:

- [mxte/UnityWebModkit](https://github.com/mxte/UnityWebModkit)
- [SamboyCoding/Cpp2IL](https://github.com/SamboyCoding/Cpp2IL)

## License

See [LICENSE](LICENSE). WAIL-related code retains its upstream Apache 2.0 licensing note from the original project.
