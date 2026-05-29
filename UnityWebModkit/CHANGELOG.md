# Changelog

## 0.1.0

Initial NextUWMK release.

Compared with the original UnityWebModkit base, this version adds or updates:

- UnityCache probing for Unity loader builds that return empty `304` XHR responses while storing real payloads under `UnityCache.XMLHttpRequest[*].xhr.response`.
- IL2CPP helper resolution improvements:
  - Unity 2019-style `il2cpp_object_new` static resolver support.
  - UTF-16 `il2cpp_string_new_len` static resolver support.
  - Managed string creation now tracks whether the resolved string helper expects UTF-8 or UTF-16 input.
  - IL2CPP helper resolver cache now stores the managed string input encoding.
  - Runtime helper lookup now falls back to raw `WebAssembly.Instance.exports` when a Unity loader does not mirror patched exports onto `Module.asm`.
  - Runtime allocator lookup now prefers raw wasm exports before Unity loader wrappers, avoiding broken `_malloc` / `_free` wrappers on loaders that do not mirror patched exports onto `Module.asm`.
- Runtime Unity WebGL candidate detection before wasm interception.
- Unity WebGL data probing and metadata loading fallback from browser cache/runtime data.
- IndexedDB cache versioning for parsed metadata and IL2CPP function mappings.
- Broader IL2CPP metadata version handling, including newer Unity metadata layouts.
- Field offset recovery improvements:
  - field offset data from metadata registration;
  - fallback metadata registration scan;
  - managed field layout computation when field offset tables are missing.
- Full type-name candidate lookup for field reads, allowing short names and namespace-qualified names.
- Field discovery helpers:
  - `plugin.listFields()`
  - `plugin.findFields()`
- Runtime field offset override support with `plugin.registerFieldOffsets()`.
- Metadata inspection through `plugin.metadata`, including normalized metadata version, raw metadata version, referenced assemblies, image count, method count, and field count.
- Safer managed allocation helper `plugin.alloc()` with explicit `dispose()` support.
- More flexible method target syntax:
  - `Type.Method`
  - `Type$$Method`
  - `{ typeName, methodName, returnType }`
- Import hook support through `plugin.hookImport()`.
- Bytecode patch helpers:
  - `plugin.patchBytecode()`
  - `plugin.nopMethod()`
- `ValueWrapper.getClassName()` helper for runtime object inspection.
- Metadata-aware field access syntax:
  - `ValueWrapper.readFieldByName(typeName, fieldName, dataType)`
  - `ValueWrapper.writeFieldByName(typeName, fieldName, dataType, value)`
  - `ClassWrapper.readFieldByName(fieldName, dataType)`
  - `ClassWrapper.writeFieldByName(fieldName, dataType, value)`
- Browser global compatibility for userscript contexts that expose `unsafeWindow`.
- Prebuilt `dist` userscript bundle included in the repository.

Credits remain with the upstream projects listed in README.
