# Usage

This document describes the public API shape exposed by the 0.1 release.

## Loading

Load the built bundle before the Unity game instantiates WebAssembly. In userscripts, use `@run-at document-start`.

```js
const UWM = unsafeWindow.UnityWebModkit || window.UnityWebModkit;
```

## Create A Plugin

```js
const plugin = UWM.Runtime.createPlugin({
  name: "my-plugin",
  version: "0.1.0",
  referencedAssemblies: ["Assembly-CSharp.dll", "UnityEngine.CoreModule.dll"],
  preferIndirectHooks: false,
  globalName: "ctx",
});
```

Options:

- `name`: plugin display name used by the logger.
- `version`: optional plugin version.
- `referencedAssemblies`: IL2CPP assemblies to parse. Add every assembly that contains classes or Unity APIs you want to call/hook.
- `preferIndirectHooks`: when true, hooks are applied through indirect table wiring only.
- `globalName`: optional page-global name, or array of names, used to expose the plugin for DevTools access. For example `globalName: "ctx"` exposes `window.ctx`.

The most recently created plugin is also available as:

```js
UWM.Runtime.lastPlugin;
```

`plugin.onLoaded` runs after metadata and method mappings are ready:

```js
plugin.onLoaded = () => {
  plugin.logger.info("ready: %o", plugin.metadata);
};
```

`plugin.metadata` is available after metadata loading:

```js
plugin.metadata.version;              // normalized metadata version
plugin.metadata.rawVersion;           // raw global-metadata.dat header version
plugin.metadata.referencedAssemblies; // assemblies requested by plugins
plugin.metadata.imageCount;           // original IL2CPP image count
plugin.metadata.methodCount;          // original IL2CPP method count
plugin.metadata.fieldCount;           // original IL2CPP field count
```

## Method Hooks

### Prefix Hook

```js
plugin.hookPrefix(
  {
    typeName: "PlayerController",
    methodName: "Update",
    params: ["i32", "i32"],
  },
  (self, methodInfo) => {
    plugin.logger.info("Update self=%x", self.val());
  },
);
```

Return `false` from a prefix callback to skip the original method when the hook path supports it.

### Postfix Hook

```js
plugin.hookPostfix(
  {
    typeName: "Gun",
    methodName: "CanShoot",
    params: ["i32", "i32"],
    returnType: "i32",
  },
  (result, self) => {
    plugin.logger.info("CanShoot result=%d self=%x", result.val(), self.val());
  },
);
```

Hook signatures use wasm ABI types such as `i32` and `f32`. For instance methods, the first argument is normally `self`; IL2CPP methods usually include a trailing `MethodInfo*`.

## Import Hooks

Use import hooks to intercept wasm imports before Unity receives them.

```js
plugin.hookImport(
  { moduleName: "env", importName: "_JS_Log_Dump" },
  (...args) => {
    console.log("Unity log import called", args);
  },
);
```

You can also match by multiple names or by pattern:

```js
plugin.hookImport(
  { importNames: ["emscripten_webgl_commit_frame", "glClear"] },
  (...args) => undefined,
);
```

## Bytecode Patches

Patch a method with raw wasm bytecode:

```js
plugin.patchBytecode(
  { typeName: "Gun", methodName: "CanShoot", returnType: "i32" },
  [0x41, 0x01, 0x0b],
);
```

NOP a method:

```js
plugin.nopMethod("SomeType.SomeMethod");
plugin.nopMethod("SomeType$$SomeMethod");
```

Use small, verifiable patches. Match the target method return type when replacing a method body.

## Calling IL2CPP Methods

```js
const result = plugin.call("Gun", "CanShoot", [gunPtr, 0]);
const same = plugin.call("Gun$$CanShoot", [gunPtr, 0]);
```

Return values are wrapped in `ValueWrapper`.

## ValueWrapper

```js
const value = new UWM.ValueWrapper(ptr);

value.val();                  // raw pointer/value
value.mstr();                 // read managed UTF-16 string
value.getClassName();         // read IL2CPP class name from object pointer
value.readField(0x10, "i32"); // read by raw offset
value.writeField(0x10, "i32", 123);
```

Read or write a field by resolved metadata name:

```js
value.readFieldByName("Player", "health", "u8");
value.writeFieldByName("Player", "health", "u8", 100);
```

This field-name syntax is one of the NextUWMK 0.1 additions. It resolves offsets from runtime IL2CPP metadata, then reads or writes the field through wasm memory.

Supported primitive field types include `i32`, `u32`, `u8`, and `f32`.

## ClassWrapper

`ClassWrapper` binds a pointer to a type name:

```js
class Player extends UWM.ClassWrapper {
  constructor(ptr) {
    super(ptr, "Player");
  }

  get health() {
    return this.readFieldByName("health", "u8").val();
  }

  set health(value) {
    this.writeFieldByName("health", "u8", value);
  }
}
```

## Memory Helpers

```js
const ptr = plugin.malloc(16);
plugin.free(ptr);
```

Scoped allocation:

```js
const block = plugin.alloc(12);
try {
  // use block.val()
} finally {
  block.dispose();
}
```

Other helpers:

```js
plugin.slice(address, size);       // Uint8Array copy
plugin.memcpy(dest, src, count);   // copy wasm memory
plugin.createMstr("hello");        // managed string
plugin.createObject(typeInfoPtr);  // managed object
```

## Field Discovery

```js
plugin.listFields("Player");
plugin.findFields("health");
```

`listFields()` returns entries shaped like:

```js
{
  typeName: "Player",
  name: "health",
  index: 1234,
  offset: 0x28,
  token: 0x04000000,
  typeIndex: 42,
}
```

`findFields(pattern)` searches both class names and field names.

Override field offsets when runtime metadata is incomplete:

```js
plugin.registerFieldOffsets({
  Player: {
    health: 0x28,
  },
});
```

## Object And Transform Query

`plugin.objects` provides Unity runtime object helpers for exploratory scripts.
It is designed for cases where SDK metadata gives class/method names, but the live scene/prefab hierarchy must be discovered at runtime.

Find live objects/components by type:

```js
const players = plugin.objects.findByType("PlayerController");
const transforms = plugin.objects.findComponents("UnityEngine.Transform");
const cameras = plugin.objects.findByType("UnityEngine.Camera");
```

Read common Unity object relations:

```js
const player = players[0];
const go = plugin.objects.gameObject(player);
const t = plugin.objects.transform(player);
const name = plugin.objects.name(player);
const renderer = plugin.objects.getComponent(player, "UnityEngine.Renderer");
```

Inspect Transform children:

```js
const count = plugin.objects.childCount(t);
const firstChild = plugin.objects.child(t, 0);
const children = plugin.objects.children(t);
```

Dump a Transform tree:

```js
const tree = plugin.objects.dumpTree(t, {
  depth: 4,
  includePosition: true,
});
console.log(tree);
```

`dumpTree()` returns:

```js
{
  ptr: 0x123456,
  name: "Player",
  position: { x: 1, y: 2, z: 3 },
  children: [
    { ptr: 0x234567, name: "Rig1", children: [] },
  ],
}
```

Position helpers use Unity injected APIs:

```js
plugin.objects.position(t);
plugin.objects.localPosition(t);
```

## Metadata

```js
console.log(plugin.metadata);
```

The metadata object includes parsed IL2CPP version, image count, method count, field count, and referenced assemblies.

Typical metadata logging:

```js
plugin.onLoaded = () => {
  console.info("[plugin] metadata", {
    version: plugin.metadata.version,
    rawVersion: plugin.metadata.rawVersion,
    assemblies: plugin.metadata.referencedAssemblies,
    methods: plugin.metadata.methodCount,
    fields: plugin.metadata.fieldCount,
  });
};
```

## Logging

Each plugin has a scoped logger:

```js
plugin.logger.info("hello %s", "world");
plugin.logger.warn("warn: %o", data);
plugin.logger.error("error");
```

## Practical Notes

- Load at `document-start`, before Unity creates the wasm instance.
- Add every assembly you need to `referencedAssemblies`.
- Prefer metadata-derived field access; use offset overrides only when runtime evidence proves metadata is incomplete.
- Keep hooks small and log enough runtime evidence to verify call signatures.
- For Unity injected APIs, pass native object pointers when the dump signature expects `intptr_t _unity_self`.
