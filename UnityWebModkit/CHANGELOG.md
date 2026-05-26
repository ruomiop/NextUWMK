# Changelog

## 0.1.0

Initial NextUWMK release.

Compared with the original UnityWebModkit base, this version adds or updates:

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
