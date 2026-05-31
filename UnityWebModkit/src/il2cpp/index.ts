import { ok, err, Result } from "neverthrow";
import { BinaryReader, BinaryWriter } from "../utils/binary";
import { Il2CppContextCreationError, MetadataParsingError } from "../errors";
import { patternSearch, bufToHex } from "../utils";

export type Il2CppMetadata = {
  buffer: ArrayBuffer;
  header: Il2CppGlobalMetadataHeader;
  integrityHash: string;
  referencedAssemblies?: string[];
  imageDefs: Il2CppImageDefinition[];
  typeDefs: Il2CppTypeDefinition[];
  fieldDefs: Il2CppFieldDefinition[];
  methodDefs: Il2CppMethodDefinition[];
  originalImageDefCount: number;
  originalTypeDefCount: number;
  originalFieldDefCount: number;
  originalMethodDefCount: number;
  version: number;
  name: string;
};

type Il2CppGlobalMetadataHeader = {
  sanity: number;
  version: number;
  stringLiteralOffset?: number;
  stringLiteralSize?: number;
  stringLiteralDataOffset?: number;
  stringLiteralDataSize?: number;
  stringOffset?: number;
  stringSize?: number;
  eventsOffset?: number;
  eventsSize?: number;
  propertiesOffset?: number;
  propertiesSize?: number;
  methodsOffset?: number;
  methodsSize?: number;
  parameterDefaultValuesOffset?: number;
  parameterDefaultValuesSize?: number;
  fieldDefaultValuesOffset?: number;
  fieldDefaultValuesSize?: number;
  fieldAndParameterDefaultValueDataOffset?: number;
  fieldAndParameterDefaultValueDataSize?: number;
  fieldMarshaledSizesOffset?: number;
  fieldMarshaledSizesSize?: number;
  parametersOffset?: number;
  parametersSize?: number;
  fieldsOffset?: number;
  fieldsSize?: number;
  genericParametersOffset?: number;
  genericParametersSize?: number;
  genericParameterConstraintsOffset?: number;
  genericParameterConstraintsSize?: number;
  genericContainersOffset?: number;
  genericContainersSize?: number;
  nestedTypesOffset?: number;
  nestedTypesSize?: number;
  interfacesOffset?: number;
  interfacesSize?: number;
  vtableMethodsOffset?: number;
  vtableMethodsSize?: number;
  interfaceOffsetsOffset?: number;
  interfaceOffsetsSize?: number;
  typeDefinitionsOffset?: number;
  typeDefinitionsSize?: number;
  // rgctxEntriesOffset: number; // Max v24.1
  // rgctxEntriesCount: number; // Max v24.1
  imagesOffset?: number;
  imagesSize?: number;
  assembliesOffset?: number;
  assembliesSize?: number;
  // metadataUsageListsOffset: number; // Max v24.5
  // metadataUsageListsCount: number; // Max v24.5
  // metadataUsagePairsOffset: number; // Max v24.5
  // metadataUsagePairsCount: number; // Max v24.5
  fieldRefsOffset?: number;
  fieldRefsSize?: number;
  referencedAssembliesOffset?: number;
  referencedAssembliesSize?: number;
  // attributesInfoOffset: number; // Max v27.2
  // attributesInfoCount: number; // Max v27.2
  // attributeTypesOffset: number; // Max v27.2
  // attributeTypesCount: number; // Max v27.2
  attributeDataOffset?: number;
  attributeDataSize?: number;
  attributeDataRangeOffset?: number;
  attributeDataRangeSize?: number;
  unresolvedVirtualCallParameterTypesOffset?: number;
  unresolvedVirtualCallParameterTypesSize?: number;
  unresolvedVirtualCallParameterRangesOffset?: number;
  unresolvedVirtualCallParameterRangesSize?: number;
  windowsRuntimeTypeNamesOffset?: number;
  windowsRuntimeTypeNamesSize?: number;
  windowsRuntimeStringsOffset?: number;
  windowsRuntimeStringsSize?: number;
  exportedTypeDefinitionsOffset?: number;
  exportedTypeDefinitionsSize?: number;
  [key: string]: number | undefined;
};

type Il2CppImageDefinition = {
  nameIndex: number;
  assemblyIndex: number;
  typeStart: number;
  typeCount: number;
  exportedTypeStart: number;
  exportedTypeCount: number;
  entryPointIndex: number;
  token: number;
  customAttributeStart: number;
  customAttributeCount: number;
};

type Il2CppTypeDefinition = {
  typeIndex?: number;
  nameIndex: number;
  namespaceIndex: number;
  byvalTypeIndex: number;
  declaringTypeIndex: number;
  parentIndex: number;
  elementTypeIndex: number;
  genericContainerIndex: number;
  flags: number;
  fieldStart: number;
  methodStart: number;
  eventStart: number;
  propertyStart: number;
  nestedTypesStart: number;
  interfacesStart: number;
  vtableStart: number;
  interfaceOffsetsStart: number;
  method_count: number;
  property_count: number;
  field_count: number;
  event_count: number;
  nested_type_count: number;
  vtable_count: number;
  interfaces_count: number;
  interface_offsets_count: number;
  bitfield: number;
  token: number;
};

type Il2CppMethodDefinition = {
  methodIndex?: number;
  nameIndex: number;
  declaringType: number;
  returnType: number;
  parameterStart: number;
  genericContainerIndex: number;
  token: number;
  flags: number;
  iflags: number;
  slot: number;
  parameterCount: number;
};

export type Il2CppContext = {
  codeGenModules: Il2CppCodeGenModuleCollection;
  codeGenModuleMethodPointers: Il2CppCodeGenModuleMethodPointers;
  scriptData: Il2CppScriptData;
  fieldData: Il2CppFieldData;
  typeAddresses?: number[];
  integrityHash?: string;
  referencedAssemblies?: string[];
  name: string;
};

type Il2CppFieldDefinition = {
  fieldIndex?: number;
  nameIndex: number;
  typeIndex: number;
  customAttributeIndex?: number;
  token: number;
};

type Il2CppCodeGenModule = {
  moduleName: number;
  methodPointerCount: number;
  methodPointers: number;
  adjustorThunkCount: number;
  adjustorThunks: number;
  invokerIndices: number;
  reversePInvokeWrapperCount: number;
  reversePInvokeWrapperIndices: number;
  rgctxRangesCount: number;
  rgctxRanges: number;
  rgctxsCount: number;
  rgctxs: number;
  debuggerMetadata: number;
  moduleInitializer: number;
  staticConstructorTypeIndices: number;
  metadataRegistration: number;
  codeRegistration: number;
};

type Il2CppCodeGenModuleCollection = {
  [moduleName: string]: Il2CppCodeGenModule;
};

type Il2CppCodeGenModuleMethodPointers = {
  [moduleName: string]: number[];
};

type Il2CppScriptData = {
  [typeName: string]: {
    [methodName: string]: number;
  };
};

type Il2CppFieldData = {
  [typeName: string]: {
    [fieldName: string]: {
      index: number;
      offset: number;
      token: number;
      typeIndex: number;
    };
  };
};

type WebAssemblyDataSection = {
  index: number;
  offset: number;
  data: Uint8Array;
};

export function createIl2CppContext(
  buffer: ArrayBuffer,
  metadata: Il2CppMetadata,
  referencedAssemblies?: string[],
): Result<Il2CppContext, Il2CppContextCreationError> {
  const dataSections: WebAssemblyDataSection[] = [];
  const reader = new BinaryReader(buffer);
  reader.seek(8);
  while (reader.offset < buffer.byteLength) {
    const id = reader.readULEB128();
    const len = reader.readULEB128();
    if (id !== 11) {
      // Skip until we reach data section
      reader.seek(reader.offset + len);
      continue;
    }
    const count = reader.readULEB128();
    for (let i = 0; i < count; i++) {
      const index = reader.readULEB128();
      reader.seek(reader.offset + 1);
      const offset = reader.readULEB128();
      reader.seek(reader.offset + 1);
      const data = reader.readUint8Array(reader.readULEB128());
      dataSections.push({
        index,
        offset,
        data,
      });
    }
    break;
  }
  const last = dataSections[dataSections.length - 1];
  const bssStart = last.offset + last.data.length;
  // Initialized memory buffer
  const memoryBuffer = new ArrayBuffer(buffer.byteLength);
  const memoryReader = new BinaryReader(memoryBuffer);
  const memoryWriter = new BinaryWriter(memoryBuffer);
  dataSections.forEach((dataSection) => {
    memoryWriter.seek(dataSection.offset);
    memoryWriter.writeBytes(dataSection.data);
  });
  // Plus search
  const sectionHelper = getSectionHelper(
    buffer.byteLength,
    memoryBuffer,
    bssStart,
    metadata.methodDefs.length,
    metadata.originalImageDefCount,
  );
  const codeRegistration = sectionHelper.findCodeRegistration();
  const pCodeRegistration = readCodeRegistration(
    memoryReader,
    codeRegistration,
  );
  const pCodeGenModules = readCodeGenModules(
    memoryReader,
    pCodeRegistration.codeGenModules,
    pCodeRegistration.codeGenModulesCount,
  );
  const codeGenModules: Il2CppCodeGenModuleCollection = {};
  const codeGenModuleMethodPointers: Il2CppCodeGenModuleMethodPointers = {};
  let metadataRegistration = 0;
  for (let i = 0; i < pCodeGenModules.length; i++) {
    const pCodeGenModule = readCodeGenModule(memoryReader, pCodeGenModules[i]);
    if (!metadataRegistration && pCodeGenModule.metadataRegistration)
      metadataRegistration = pCodeGenModule.metadataRegistration;
    memoryReader.seek(pCodeGenModule.moduleName);
    const moduleName = memoryReader.readNullTerminatedUTF8String();
    if (!referencedAssemblies?.includes(moduleName)) continue;
    codeGenModules[moduleName] = pCodeGenModule;
    const methodPointers = readCodeGenModuleMethodPointers(
      memoryReader,
      pCodeGenModule.methodPointers,
      pCodeGenModule.methodPointerCount,
    );
    codeGenModuleMethodPointers[moduleName] = methodPointers;
  }
  const scriptData: Il2CppScriptData = {};
  const fieldData: Il2CppFieldData = {};
  const fallbackMetadataRegistration = findMetadataRegistration(
    memoryReader,
    metadata,
  );
  let activeMetadataRegistration =
    fallbackMetadataRegistration || metadataRegistration;
  let fieldOffsets = activeMetadataRegistration
    ? readFieldOffsets(memoryReader, activeMetadataRegistration, metadata.version)
    : [];
  if (
    !fallbackMetadataRegistration &&
    metadataRegistration &&
    !hasUsableFieldOffsets(fieldOffsets, metadata.typeDefs)
  ) {
    activeMetadataRegistration = metadataRegistration;
  }
  const computedFieldOffsets = computeManagedFieldOffsets(
    memoryReader,
    activeMetadataRegistration,
    metadata,
  );
  const typeAddresses = readTypeAddresses(
    memoryReader,
    activeMetadataRegistration,
  );
  const metadataReader = new BinaryReader(metadata.buffer);
  const stringOffset = getSectionOffset(metadata.header, "string", "strings");
  for (let j = 0; j < metadata.imageDefs.length; j++) {
    let imageDef = metadata.imageDefs[j];
    let imageName = getStringFromIndex(
      metadataReader,
      stringOffset,
      imageDef.nameIndex,
    );
    let typeEnd = imageDef.typeStart + imageDef.typeCount;
    for (let k = imageDef.typeStart; k < typeEnd; k++) {
      let typeDef = metadata.typeDefs.find((def) => def.typeIndex === k);
      if (!typeDef) continue;
      let typeName = getStringFromIndex(
        metadataReader,
        stringOffset,
        typeDef.nameIndex,
      );
      const namespaceName = getStringFromIndex(
        metadataReader,
        stringOffset,
        typeDef.namespaceIndex,
      );
      const fullTypeName =
        namespaceName === "" ? typeName : namespaceName + "." + typeName;
      let methodEnd = typeDef.methodStart + typeDef.method_count;
      const ptrs = codeGenModuleMethodPointers[imageName];
      for (let l = typeDef.methodStart; l < methodEnd; l++) {
        if (!ptrs) break;
        let methodDef = metadata.methodDefs.find(
          (def) => def.methodIndex === l,
        );
        if (!methodDef) continue;
        let methodName = getStringFromIndex(
          metadataReader,
          stringOffset,
          methodDef.nameIndex,
        );
        let methodToken = methodDef.token;
        let methodPointerIndex = methodToken & 0x00ffffff;
        const ptr = ptrs[methodPointerIndex - 1];
        if (ptr === undefined) continue;
        if (!scriptData[fullTypeName]) {
          scriptData[fullTypeName] = {}; // Create an empty object if it doesn't exist
        }
        if (scriptData[fullTypeName][methodName] !== undefined) {
          const ptrRef = scriptData[fullTypeName][methodName];
          delete scriptData[fullTypeName][methodName];
          scriptData[fullTypeName][methodName + "_" + ptrRef] = ptrRef;
          methodName = `${methodName}_${ptr}`;
        }
        scriptData[fullTypeName][methodName] = ptr;
      }
      if (!fieldData[fullTypeName]) fieldData[fullTypeName] = {};
      for (
        let fieldOrdinal = 0;
        fieldOrdinal < typeDef.field_count;
        fieldOrdinal++
      ) {
        const fieldIndex = typeDef.fieldStart + fieldOrdinal;
        const fieldDef = metadata.fieldDefs.find(
          (def) => def.fieldIndex === fieldIndex,
        );
        if (!fieldDef) continue;
        const fieldName = getStringFromIndex(
          metadataReader,
          stringOffset,
          fieldDef.nameIndex,
        );
        const runtimeOffset = getFieldOffset(
          memoryReader,
          fieldOffsets,
          typeDef.typeIndex ?? -1,
          fieldOrdinal,
          fieldIndex,
          metadata.version,
        );
        fieldData[fullTypeName][fieldName] = {
          index: fieldIndex,
          offset:
            runtimeOffset >= 0
              ? runtimeOffset
              : computedFieldOffsets.get(fieldIndex) ?? -1,
          token: fieldDef.token,
          typeIndex: fieldDef.typeIndex,
        };
      }
    }
  }
  return ok({
    codeGenModules,
    codeGenModuleMethodPointers,
    scriptData,
    fieldData,
    typeAddresses,
    integrityHash: metadata.integrityHash,
    referencedAssemblies,
    name: "il2cpp",
  });
}

export async function createMetadata(
  buffer: ArrayBuffer,
  referencedAssemblies?: string[],
  unityVersion?: string,
): Promise<Result<Il2CppMetadata, MetadataParsingError>> {
  const reader = new BinaryReader(buffer);
  const sanity = reader.readUint32();
  if (sanity !== 0xfab11baf)
    return err(
      new MetadataParsingError(
        "Metadata file supplied is not a valid metadata file.",
      ),
    );
  const version = reader.readUint32();
  if (version < 0 || version > 1000)
    return err(
      new MetadataParsingError(
        "Metadata file supplied is not a valid metadata file.",
      ),
    );
  const actualVersion = getActualMetadataVersion(version, unityVersion);
  if (actualVersion < 23 || actualVersion > 106)
    return err(
      new MetadataParsingError(
        `Metadata file supplied is not a supported version [${version}].`,
      ),
    );
  reader.seek(0);
  const header = readHeader(reader, actualVersion);
  const indexSizes = getMetadataIndexSizes(header, actualVersion);
  const stringOffset = getSectionOffset(header, "string", "strings");
  const imageDefs = readImageDefinitions(
    reader,
    getSectionOffset(header, "images"),
    getSectionSize(header, "images"),
    indexSizes,
    actualVersion,
  );
  const referencedImageDefs = [];
  var i = 0,
    len = imageDefs.length;
  while (i < len) {
    const imageDef = imageDefs[i];
    const imageName = getStringFromIndex(
      reader,
      stringOffset,
      imageDef.nameIndex,
    );
    if (referencedAssemblies?.includes(imageName))
      referencedImageDefs.push(imageDef);
    i++;
  }
  let typeDefs = readTypeDefinitions(
    reader,
    getSectionOffset(header, "typeDefinitions"),
    getSectionSize(header, "typeDefinitions"),
    referencedImageDefs,
    indexSizes,
    actualVersion,
  );
  const fieldDefs = readFieldDefinitions(
    reader,
    getSectionOffset(header, "fields"),
    getSectionSize(header, "fields"),
    indexSizes,
    actualVersion,
  );
  const methodDefs = readMethodDefinitions(
    reader,
    getSectionOffset(header, "methods"),
    getSectionSize(header, "methods"),
    indexSizes,
    actualVersion,
  );
  const referencedMethodDefs = [];
  (i = 0), (len = methodDefs.length);
  while (i < len) {
    const methodDef = methodDefs[i];
    if (
      typeDefs.findIndex((t) => t.typeIndex === methodDef.declaringType) !== -1
    )
      referencedMethodDefs.push(methodDef);
    i++;
  }
  const integrityHash = bufToHex(
    await window.crypto.subtle.digest("SHA-256", buffer),
  );
  return ok({
    buffer,
    header,
    imageDefs: referencedImageDefs,
    typeDefs,
    fieldDefs,
    methodDefs,
    originalImageDefCount: imageDefs.length,
    originalTypeDefCount:
      getSectionCount(header, "typeDefinitions") ||
      getSectionSize(header, "typeDefinitions") /
        getTypeDefinitionSize(indexSizes, actualVersion),
    originalFieldDefCount: fieldDefs.length,
    originalMethodDefCount: methodDefs.length,
    version: actualVersion,
    name: "metadata",
    referencedAssemblies,
    integrityHash,
  });
}

type MetadataIndexSizes = {
  typeIndex: number;
  typeDefinitionIndex: number;
  genericContainerIndex: number;
  parameterIndex: number;
  fieldIndex: number;
  methodIndex: number;
  eventIndex: number;
  propertyIndex: number;
  nestedTypeIndex: number;
  interfaceOffsetIndex: number;
};

function getActualMetadataVersion(version: number, unityVersion?: string) {
  const unity = parseUnityVersion(unityVersion);
  if (version === 24) {
    if (gteUnity(unity, 2020, 1, 11)) return 24.4;
    if (gteUnity(unity, 2020, 1, 0)) return 24.3;
    if (gteUnity(unity, 2019, 4, 21)) return 24.5;
    if (gteUnity(unity, 2019, 4, 15)) return 24.4;
    if (gteUnity(unity, 2019, 3, 7)) return 24.3;
    if (gteUnity(unity, 2019, 1, 0)) return 24.2;
    if (gteUnity(unity, 2018, 4, 34)) return 24.15;
    if (gteUnity(unity, 2018, 3, 0)) return 24.1;
  }
  if (version === 27) {
    if (gteUnity(unity, 2021, 1, 0)) return 27.2;
    if (gteUnity(unity, 2020, 2, 4)) return 27.1;
  }
  if (version === 29) {
    if (gteUnity(unity, 2022, 1, 0)) return 29.1;
  }
  if (version === 31) {
    if (gteUnity(unity, 2022, 3, 33)) return 31.1;
  }
  return version;
}

function parseUnityVersion(unityVersion?: string) {
  const match = unityVersion?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function gteUnity(
  unity: ReturnType<typeof parseUnityVersion>,
  major: number,
  minor = 0,
  patch = 0,
) {
  if (!unity) return false;
  if (unity.major !== major) return unity.major > major;
  if (unity.minor !== minor) return unity.minor > minor;
  return unity.patch >= patch;
}

function getIndexSize(count = 0) {
  if (count <= 0xff) return 1;
  if (count <= 0xffff) return 2;
  return 4;
}

function getMetadataIndexSizes(
  header: Il2CppGlobalMetadataHeader,
  version: number,
): MetadataIndexSizes {
  if (version < 38) {
    return {
      typeIndex: 4,
      typeDefinitionIndex: 4,
      genericContainerIndex: 4,
      parameterIndex: 4,
      fieldIndex: 4,
      methodIndex: 4,
      eventIndex: 4,
      propertyIndex: 4,
      nestedTypeIndex: 4,
      interfaceOffsetIndex: 4,
    };
  }

  const interfaceOffsetsSize = getSectionSize(header, "interfaceOffsets");
  const interfaceOffsetsCount = getSectionCount(header, "interfaceOffsets");
  const typeIndex =
    interfaceOffsetsCount > 0
      ? Math.max(
          1,
          Math.min(4, interfaceOffsetsSize / interfaceOffsetsCount - 4),
        )
      : 4;

  return {
    typeIndex,
    typeDefinitionIndex: getIndexSize(
      getSectionCount(header, "typeDefinitions"),
    ),
    genericContainerIndex: getIndexSize(
      getSectionCount(header, "genericContainers"),
    ),
    parameterIndex:
      version >= 39 ? getIndexSize(getSectionCount(header, "parameters")) : 4,
    fieldIndex:
      version >= 106 ? getIndexSize(getSectionCount(header, "fields")) : 4,
    methodIndex:
      version >= 105 ? getIndexSize(getSectionCount(header, "methods")) : 4,
    eventIndex:
      version >= 104 ? getIndexSize(getSectionCount(header, "events")) : 4,
    propertyIndex:
      version >= 104 ? getIndexSize(getSectionCount(header, "properties")) : 4,
    nestedTypeIndex:
      version >= 104 ? getIndexSize(getSectionCount(header, "nestedTypes")) : 4,
    interfaceOffsetIndex:
      version >= 104 ? getIndexSize(interfaceOffsetsCount) : 4,
  };
}

function getSectionOffset(
  header: Il2CppGlobalMetadataHeader,
  legacyName: string,
  modernName = legacyName,
) {
  return header[`${modernName}Offset`] ?? header[`${legacyName}Offset`] ?? 0;
}

function getSectionSize(
  header: Il2CppGlobalMetadataHeader,
  legacyName: string,
  modernName = legacyName,
) {
  return header[`${modernName}Size`] ?? header[`${legacyName}Size`] ?? 0;
}

function getSectionCount(
  header: Il2CppGlobalMetadataHeader,
  legacyName: string,
  modernName = legacyName,
) {
  return header[`${modernName}Count`] ?? header[`${legacyName}Count`] ?? 0;
}

function getStringFromIndex(
  reader: BinaryReader,
  base: number,
  offset: number,
) {
  reader.seek(base + offset);
  return reader.readNullTerminatedUTF8String();
}

function isReferencedType(
  imageDefinitions: Il2CppImageDefinition[],
  typeDefinitionsOffset: number,
  readerOffset: number,
  typeDefStructSize: number,
) {
  for (const imageDef of imageDefinitions) {
    let typeStart =
      imageDef.typeStart * typeDefStructSize + typeDefinitionsOffset;
    let typeCount = imageDef.typeCount * typeDefStructSize;
    let typeEnd = typeStart + typeCount;
    if (readerOffset >= typeStart && readerOffset < typeEnd) {
      return true;
    }
  }

  return false;
}

function readHeader(
  reader: BinaryReader,
  version: number,
): Il2CppGlobalMetadataHeader {
  if (version >= 38) {
    const header: Il2CppGlobalMetadataHeader = {
      sanity: reader.readUint32(),
      version: reader.readInt32(),
    };
    const sections = [
      "stringLiterals",
      "stringLiteralData",
      "strings",
      "events",
      "properties",
      "methods",
      "parameterDefaultValues",
      "fieldDefaultValues",
      "fieldAndParameterDefaultValueData",
      "fieldMarshaledSizes",
      "parameters",
      "fields",
      "genericParameters",
      "genericParameterConstraints",
      "genericContainers",
      "nestedTypes",
      "interfaces",
      "vtableMethods",
      "interfaceOffsets",
      "typeDefinitions",
      ...(version >= 104 ? ["typeInlineArrays"] : []),
      "images",
      "assemblies",
      "fieldRefs",
      "referencedAssemblies",
      "attributeData",
      "attributeDataRange",
      "unresolvedVirtualCallParameterTypes",
      "unresolvedVirtualCallParameterRanges",
      "windowsRuntimeTypeNames",
      "windowsRuntimeStrings",
      "exportedTypeDefinitions",
    ];
    for (const section of sections) {
      header[`${section}Offset`] = reader.readInt32();
      header[`${section}Size`] = reader.readInt32();
      header[`${section}Count`] = reader.readInt32();
    }
    return header;
  }

  return {
    sanity: reader.readUint32(),
    version: reader.readInt32(),
    stringLiteralOffset: reader.readUint32(),
    stringLiteralSize: reader.readInt32(),
    stringLiteralDataOffset: reader.readUint32(),
    stringLiteralDataSize: reader.readInt32(),
    stringOffset: reader.readUint32(),
    stringSize: reader.readInt32(),
    eventsOffset: reader.readUint32(),
    eventsSize: reader.readInt32(),
    propertiesOffset: reader.readUint32(),
    propertiesSize: reader.readInt32(),
    methodsOffset: reader.readUint32(),
    methodsSize: reader.readInt32(),
    parameterDefaultValuesOffset: reader.readUint32(),
    parameterDefaultValuesSize: reader.readInt32(),
    fieldDefaultValuesOffset: reader.readUint32(),
    fieldDefaultValuesSize: reader.readInt32(),
    fieldAndParameterDefaultValueDataOffset: reader.readUint32(),
    fieldAndParameterDefaultValueDataSize: reader.readInt32(),
    fieldMarshaledSizesOffset: reader.readInt32(),
    fieldMarshaledSizesSize: reader.readInt32(),
    parametersOffset: reader.readUint32(),
    parametersSize: reader.readInt32(),
    fieldsOffset: reader.readUint32(),
    fieldsSize: reader.readInt32(),
    genericParametersOffset: reader.readUint32(),
    genericParametersSize: reader.readInt32(),
    genericParameterConstraintsOffset: reader.readUint32(),
    genericParameterConstraintsSize: reader.readInt32(),
    genericContainersOffset: reader.readUint32(),
    genericContainersSize: reader.readInt32(),
    nestedTypesOffset: reader.readUint32(),
    nestedTypesSize: reader.readInt32(),
    interfacesOffset: reader.readUint32(),
    interfacesSize: reader.readInt32(),
    vtableMethodsOffset: reader.readUint32(),
    vtableMethodsSize: reader.readInt32(),
    interfaceOffsetsOffset: reader.readInt32(),
    interfaceOffsetsSize: reader.readInt32(),
    typeDefinitionsOffset: reader.readUint32(),
    typeDefinitionsSize: reader.readInt32(),
    ...(version <= 24.15
      ? {
          rgctxEntriesOffset: reader.readUint32(),
          rgctxEntriesSize: reader.readInt32(),
        }
      : {}),
    imagesOffset: reader.readUint32(),
    imagesSize: reader.readInt32(),
    assembliesOffset: reader.readUint32(),
    assembliesSize: reader.readInt32(),
    ...(version < 27
      ? {
          metadataUsageListsOffset: reader.readUint32(),
          metadataUsageListsSize: reader.readInt32(),
          metadataUsagePairsOffset: reader.readUint32(),
          metadataUsagePairsSize: reader.readInt32(),
        }
      : {}),
    fieldRefsOffset: reader.readUint32(),
    fieldRefsSize: reader.readInt32(),
    referencedAssembliesOffset: reader.readInt32(),
    referencedAssembliesSize: reader.readInt32(),
    ...(version < 29
      ? {
          attributesInfoOffset: reader.readUint32(),
          attributesInfoSize: reader.readInt32(),
          attributeTypesOffset: reader.readUint32(),
          attributeTypesSize: reader.readInt32(),
        }
      : {
          attributeDataOffset: reader.readUint32(),
          attributeDataSize: reader.readInt32(),
          attributeDataRangeOffset: reader.readUint32(),
          attributeDataRangeSize: reader.readInt32(),
        }),
    unresolvedVirtualCallParameterTypesOffset: reader.readInt32(),
    unresolvedVirtualCallParameterTypesSize: reader.readInt32(),
    unresolvedVirtualCallParameterRangesOffset: reader.readInt32(),
    unresolvedVirtualCallParameterRangesSize: reader.readInt32(),
    windowsRuntimeTypeNamesOffset: reader.readInt32(),
    windowsRuntimeTypeNamesSize: reader.readInt32(),
    ...(version >= 27
      ? {
          windowsRuntimeStringsOffset: reader.readInt32(),
          windowsRuntimeStringsSize: reader.readInt32(),
        }
      : {}),
    ...(version >= 24
      ? {
          exportedTypeDefinitionsOffset: reader.readInt32(),
          exportedTypeDefinitionsSize: reader.readInt32(),
        }
      : {}),
  };
}

function readImageDefinitions(
  reader: BinaryReader,
  offset: number,
  size: number,
  indexSizes: MetadataIndexSizes,
  version: number,
): Il2CppImageDefinition[] {
  reader.seek(offset);
  const imageDefinitions = [];
  const imagesEnd = offset + size;
  while (reader.offset < imagesEnd) {
    imageDefinitions.push({
      nameIndex: reader.readUint32(),
      assemblyIndex: reader.readInt32(),
      typeStart: reader.readIndex(indexSizes.typeDefinitionIndex),
      typeCount: reader.readUint32(),
      exportedTypeStart:
        version >= 24 ? reader.readIndex(indexSizes.typeDefinitionIndex) : 0,
      exportedTypeCount: version >= 24 ? reader.readUint32() : 0,
      entryPointIndex: reader.readInt32(),
      token: version >= 19 ? reader.readUint32() : 0,
      customAttributeStart: version >= 24.1 ? reader.readInt32() : 0,
      customAttributeCount: version >= 24.1 ? reader.readUint32() : 0,
    });
  }
  return imageDefinitions;
}

function readTypeDefinitions(
  reader: BinaryReader,
  offset: number,
  size: number,
  imageDefinitions: Il2CppImageDefinition[],
  indexSizes: MetadataIndexSizes,
  version: number,
): Il2CppTypeDefinition[] {
  reader.seek(offset);
  const typeDefinitions = [];
  const typesEnd = offset + size;
  let i = 0;
  const typeDefStructSize = getTypeDefinitionSize(indexSizes, version);
  while (reader.offset < typesEnd) {
    const typeDef = {
      typeIndex: i,
      nameIndex: reader.readUint32(),
      namespaceIndex: reader.readUint32(),
      ...(version <= 24 ? { customAttributeIndex: reader.readInt32() } : {}),
      byvalTypeIndex: reader.readIndex(indexSizes.typeIndex),
      ...(version < 27 ? { byrefTypeIndex: reader.readInt32() } : {}),
      declaringTypeIndex: reader.readIndex(indexSizes.typeIndex),
      parentIndex: reader.readIndex(indexSizes.typeIndex),
      elementTypeIndex:
        version < 35 ? reader.readIndex(indexSizes.typeIndex) : -1,
      ...(version <= 24.15
        ? {
            rgctxStartIndex: reader.readInt32(),
            rgctxCount: reader.readInt32(),
          }
        : {}),
      genericContainerIndex: reader.readIndex(indexSizes.genericContainerIndex),
      flags: reader.readUint32(),
      fieldStart: reader.readIndex(indexSizes.fieldIndex),
      methodStart: reader.readIndex(indexSizes.methodIndex),
      eventStart: reader.readIndex(indexSizes.eventIndex),
      propertyStart: reader.readIndex(indexSizes.propertyIndex),
      nestedTypesStart: reader.readIndex(indexSizes.nestedTypeIndex),
      interfacesStart: reader.readInt32(),
      vtableStart: reader.readInt32(),
      interfaceOffsetsStart: reader.readIndex(indexSizes.interfaceOffsetIndex),
      method_count: reader.readUint16(),
      property_count: reader.readUint16(),
      field_count: reader.readUint16(),
      event_count: reader.readUint16(),
      nested_type_count: reader.readUint16(),
      vtable_count: reader.readUint16(),
      interfaces_count: reader.readUint16(),
      interface_offsets_count: reader.readUint16(),
      bitfield: reader.readUint32(),
      token: reader.readUint32(),
    };
    i++;
    if (
      !isReferencedType(
        imageDefinitions,
        offset,
        reader.offset - 1,
        typeDefStructSize,
      )
    )
      continue;
    typeDefinitions.push(typeDef);
  }
  return typeDefinitions;
}

function readMethodDefinitions(
  reader: BinaryReader,
  offset: number,
  size: number,
  indexSizes: MetadataIndexSizes,
  version: number,
): Il2CppMethodDefinition[] {
  reader.seek(offset);
  const methodDefinitions = [];
  const methodsEnd = offset + size;
  let i = 0;
  while (reader.offset < methodsEnd) {
    methodDefinitions.push({
      methodIndex: i,
      nameIndex: reader.readUint32(),
      declaringType: reader.readIndex(indexSizes.typeDefinitionIndex),
      returnType: reader.readIndex(indexSizes.typeIndex),
      ...(version >= 31 ? { returnParameterToken: reader.readUint32() } : {}),
      parameterStart: reader.readIndex(indexSizes.parameterIndex),
      ...(version <= 24 ? { customAttributeIndex: reader.readInt32() } : {}),
      genericContainerIndex: reader.readIndex(indexSizes.genericContainerIndex),
      ...(version <= 24.15
        ? {
            legacyMethodIndex: reader.readInt32(),
            invokerIndex: reader.readInt32(),
            delegateWrapperIndex: reader.readInt32(),
            rgctxStartIndex: reader.readInt32(),
            rgctxCount: reader.readInt32(),
          }
        : {}),
      token: reader.readUint32(),
      flags: reader.readUint16(),
      iflags: reader.readUint16(),
      slot: reader.readUint16(),
      parameterCount: reader.readUint16(),
    });
    i++;
  }
  return methodDefinitions;
}

function readFieldDefinitions(
  reader: BinaryReader,
  offset: number,
  size: number,
  indexSizes: MetadataIndexSizes,
  version: number,
): Il2CppFieldDefinition[] {
  reader.seek(offset);
  const fieldDefinitions = [];
  const fieldsEnd = offset + size;
  let i = 0;
  while (reader.offset < fieldsEnd) {
    fieldDefinitions.push({
      fieldIndex: i,
      nameIndex: reader.readInt32(),
      typeIndex: reader.readIndex(indexSizes.typeIndex),
      ...(version <= 24 ? { customAttributeIndex: reader.readInt32() } : {}),
      token: reader.readUint32(),
    });
    i++;
  }
  return fieldDefinitions;
}

function readMetadataRegistration(reader: BinaryReader, offset: number) {
  reader.seek(offset);
  return {
    genericClassesCount: reader.readUint32(),
    genericClasses: reader.readUint32(),
    genericInstsCount: reader.readUint32(),
    genericInsts: reader.readUint32(),
    genericMethodTableCount: reader.readUint32(),
    genericMethodTable: reader.readUint32(),
    numTypes: reader.readUint32(),
    typeAddressListAddress: reader.readUint32(),
    methodSpecsCount: reader.readUint32(),
    methodSpecs: reader.readUint32(),
    fieldOffsetsCount: reader.readUint32(),
    fieldOffsetListAddress: reader.readUint32(),
    typeDefinitionsSizesCount: reader.readUint32(),
    typeDefinitionsSizes: reader.readUint32(),
    metadataUsagesCount: reader.readUint32(),
    metadataUsages: reader.readUint32(),
  };
}

function readFieldOffsets(
  reader: BinaryReader,
  metadataRegistrationOffset: number,
  version: number,
) {
  if (!isReadableAddress(reader, metadataRegistrationOffset, 64)) return [];
  const metadataRegistration = readMetadataRegistration(
    reader,
    metadataRegistrationOffset,
  );
  const fieldOffsets: number[] = [];
  if (
    !metadataRegistration.fieldOffsetListAddress ||
    !metadataRegistration.fieldOffsetsCount ||
    !isReadableAddress(
      reader,
      metadataRegistration.fieldOffsetListAddress,
      metadataRegistration.fieldOffsetsCount * 4,
    )
  ) {
    return fieldOffsets;
  }
  reader.seek(metadataRegistration.fieldOffsetListAddress);
  for (let i = 0; i < metadataRegistration.fieldOffsetsCount; i++) {
    fieldOffsets.push(reader.readUint32());
  }
  return fieldOffsets;
}

function readTypeAddresses(
  reader: BinaryReader,
  metadataRegistrationOffset: number,
) {
  if (!isReadableAddress(reader, metadataRegistrationOffset, 64)) return [];
  const metadataRegistration = readMetadataRegistration(
    reader,
    metadataRegistrationOffset,
  );
  const typeAddresses: number[] = [];
  if (
    !metadataRegistration.typeAddressListAddress ||
    !metadataRegistration.numTypes ||
    !isReadableAddress(
      reader,
      metadataRegistration.typeAddressListAddress,
      metadataRegistration.numTypes * 4,
    )
  ) {
    return typeAddresses;
  }
  reader.seek(metadataRegistration.typeAddressListAddress);
  for (let i = 0; i < metadataRegistration.numTypes; i++) {
    typeAddresses.push(reader.readUint32());
  }
  return typeAddresses;
}

function hasUsableFieldOffsets(
  fieldOffsets: number[],
  typeDefs: Il2CppTypeDefinition[],
) {
  return typeDefs.some((typeDef) => {
    const typeIndex = typeDef.typeIndex ?? -1;
    return typeIndex >= 0 && !!fieldOffsets[typeIndex];
  });
}

function findMetadataRegistration(
  reader: BinaryReader,
  metadata: Il2CppMetadata,
) {
  const typeDefCount = metadata.originalTypeDefCount;
  if (!typeDefCount) return 0;

  const view = new DataView(reader.buffer);
  const maxOffset = reader.buffer.byteLength - 64;
  for (let offset = 0; offset <= maxOffset; offset += 4) {
    const fieldOffsetsCount = view.getUint32(offset + 40, true);
    const fieldOffsetsAddress = view.getUint32(offset + 44, true);
    const typeDefinitionsSizesCount = view.getUint32(offset + 48, true);
    const typeDefinitionsSizesAddress = view.getUint32(offset + 52, true);

    if (
      fieldOffsetsCount !== typeDefCount ||
      typeDefinitionsSizesCount !== typeDefCount ||
      !isReadableAddress(reader, fieldOffsetsAddress, fieldOffsetsCount * 4) ||
      !isReadableAddress(
        reader,
        typeDefinitionsSizesAddress,
        typeDefinitionsSizesCount * 4,
      )
    ) {
      continue;
    }

    let validReferencedTypeOffsets = 0;
    for (const typeDef of metadata.typeDefs.slice(0, 64)) {
      const typeIndex = typeDef.typeIndex ?? -1;
      if (typeIndex < 0 || typeIndex >= fieldOffsetsCount) continue;
      const pointer = view.getUint32(fieldOffsetsAddress + typeIndex * 4, true);
      if (
        isReadableAddress(reader, pointer, Math.max(4, typeDef.field_count * 4))
      ) {
        validReferencedTypeOffsets++;
      }
    }
    if (validReferencedTypeOffsets > 0) return offset;
  }

  return 0;
}

function isReadableAddress(reader: BinaryReader, address: number, size = 1) {
  return (
    Number.isFinite(address) &&
    address >= 0 &&
    size >= 0 &&
    address + size <= reader.buffer.byteLength
  );
}

function computeManagedFieldOffsets(
  reader: BinaryReader,
  metadataRegistrationOffset: number,
  metadata: Il2CppMetadata,
) {
  const offsets = new Map<number, number>();
  if (!isReadableAddress(reader, metadataRegistrationOffset, 64))
    return offsets;

  const registration = readMetadataRegistration(
    reader,
    metadataRegistrationOffset,
  );
  if (
    !registration.typeAddressListAddress ||
    !registration.numTypes ||
    !isReadableAddress(
      reader,
      registration.typeAddressListAddress,
      registration.numTypes * 4,
    )
  ) {
    return offsets;
  }

  const typeDefsByIndex = new Map<number, Il2CppTypeDefinition>();
  for (const typeDef of metadata.typeDefs) {
    if (typeDef.typeIndex !== undefined)
      typeDefsByIndex.set(typeDef.typeIndex, typeDef);
  }

  const classSizes = new Map<number, number>();
  const valueTypeLayouts = new Map<number, { size: number; align: number }>();

  const readType = (typeIndex: number) => {
    if (typeIndex < 0 || typeIndex >= registration.numTypes) return undefined;
    const typePointerOffset =
      registration.typeAddressListAddress + typeIndex * 4;
    if (!isReadableAddress(reader, typePointerOffset, 4)) return undefined;
    const view = new DataView(reader.buffer);
    const typePointer = view.getUint32(typePointerOffset, true);
    if (!isReadableAddress(reader, typePointer, 8)) return undefined;
    const data = view.getUint32(typePointer, true);
    const bits = view.getUint32(typePointer + 4, true);
    return {
      data,
      attrs: bits & 0xffff,
      type: (bits >> 16) & 0xff,
    };
  };

  const getFieldLayout = (
    typeIndex: number,
    visiting = new Set<number>(),
  ): { size: number; align: number } => {
    const type = readType(typeIndex);
    if (!type) return { size: 4, align: 4 };

    switch (type.type) {
      case 0x02: // BOOLEAN
      case 0x04: // I1
      case 0x05: // U1
        return { size: 1, align: 1 };
      case 0x03: // CHAR
      case 0x06: // I2
      case 0x07: // U2
        return { size: 2, align: 2 };
      case 0x08: // I4
      case 0x09: // U4
      case 0x0c: // R4
      case 0x18: // I
      case 0x19: // U
        return { size: 4, align: 4 };
      case 0x0a: // I8
      case 0x0b: // U8
      case 0x0d: // R8
        return { size: 8, align: 4 };
      case 0x11: // VALUETYPE
        return getValueTypeLayout(type.data, visiting);
      case 0x0e: // STRING
      case 0x0f: // PTR
      case 0x10: // BYREF
      case 0x12: // CLASS
      case 0x14: // ARRAY
      case 0x15: // GENERICINST
      case 0x1c: // OBJECT
      case 0x1d: // SZARRAY
      default:
        return { size: 4, align: 4 };
    }
  };

  const getValueTypeLayout = (
    typeDefIndex: number,
    visiting = new Set<number>(),
  ): { size: number; align: number } => {
    const cached = valueTypeLayouts.get(typeDefIndex);
    if (cached) return cached;
    if (visiting.has(typeDefIndex)) return { size: 4, align: 4 };

    const typeDef = typeDefsByIndex.get(typeDefIndex);
    if (!typeDef) return { size: 4, align: 4 };

    visiting.add(typeDefIndex);
    let cursor = 0;
    let maxAlign = 1;
    for (let i = 0; i < typeDef.field_count; i++) {
      const fieldIndex = typeDef.fieldStart + i;
      const fieldDef = metadata.fieldDefs.find(
        (field) => field.fieldIndex === fieldIndex,
      );
      if (!fieldDef) continue;
      const fieldType = readType(fieldDef.typeIndex);
      if (fieldType && isStaticField(fieldType.attrs)) continue;
      const layout = getFieldLayout(fieldDef.typeIndex, visiting);
      maxAlign = Math.max(maxAlign, layout.align);
      cursor = alignTo(cursor, layout.align);
      cursor += layout.size;
    }
    visiting.delete(typeDefIndex);

    const layout = {
      size: Math.max(alignTo(cursor, maxAlign), 1),
      align: maxAlign,
    };
    valueTypeLayouts.set(typeDefIndex, layout);
    return layout;
  };

  const computeClassSize = (
    typeDef: Il2CppTypeDefinition,
    visiting = new Set<number>(),
  ): number => {
    const typeDefIndex = typeDef.typeIndex ?? -1;
    if (typeDefIndex < 0) return 0x10;
    const cached = classSizes.get(typeDefIndex);
    if (cached !== undefined) return cached;
    if (visiting.has(typeDefIndex)) return 0x10;

    visiting.add(typeDefIndex);
    let cursor = 0x10;
    const parentType = readType(typeDef.parentIndex);
    if (parentType && parentType.type === 0x12) {
      const parentDef = typeDefsByIndex.get(parentType.data);
      if (parentDef)
        cursor = Math.max(cursor, computeClassSize(parentDef, visiting));
    }

    for (let i = 0; i < typeDef.field_count; i++) {
      const fieldIndex = typeDef.fieldStart + i;
      const fieldDef = metadata.fieldDefs.find(
        (field) => field.fieldIndex === fieldIndex,
      );
      if (!fieldDef) continue;
      const fieldType = readType(fieldDef.typeIndex);
      if (fieldType && isStaticField(fieldType.attrs)) {
        offsets.set(fieldIndex, -1);
        continue;
      }
      const layout = getFieldLayout(fieldDef.typeIndex, visiting);
      cursor = alignTo(cursor, layout.align);
      offsets.set(fieldIndex, cursor);
      cursor += layout.size;
    }

    visiting.delete(typeDefIndex);
    classSizes.set(typeDefIndex, cursor);
    return cursor;
  };

  for (const typeDef of metadata.typeDefs) {
    computeClassSize(typeDef);
  }
  return offsets;
}

function isStaticField(attrs: number) {
  return (attrs & 0x0010) !== 0 || (attrs & 0x0040) !== 0;
}

function alignTo(value: number, align: number) {
  if (align <= 1) return value;
  return Math.ceil(value / align) * align;
}

function getFieldOffset(
  reader: BinaryReader,
  fieldOffsets: number[],
  typeIndex: number,
  fieldOrdinal: number,
  fieldIndex: number,
  version: number,
) {
  try {
    if (version > 21) {
      const offsetsPointer = fieldOffsets[typeIndex];
      if (!offsetsPointer) return -1;
      reader.seek(offsetsPointer + fieldOrdinal * 4);
      return reader.readInt32();
    }
    return fieldOffsets[fieldIndex] ?? -1;
  } catch {
    return -1;
  }
}

function getTypeDefinitionSize(
  indexSizes: MetadataIndexSizes,
  version: number,
) {
  return (
    8 +
    (version <= 24 ? 4 : 0) +
    indexSizes.typeIndex +
    (version < 27 ? 4 : 0) +
    indexSizes.typeIndex +
    indexSizes.typeIndex +
    (version < 35 ? indexSizes.typeIndex : 0) +
    (version <= 24.15 ? 8 : 0) +
    indexSizes.genericContainerIndex +
    4 +
    indexSizes.fieldIndex +
    indexSizes.methodIndex +
    indexSizes.eventIndex +
    indexSizes.propertyIndex +
    indexSizes.nestedTypeIndex +
    4 +
    4 +
    indexSizes.interfaceOffsetIndex +
    16 +
    8
  );
}

function readCodeRegistration(reader: BinaryReader, offset: number) {
  reader.seek(offset);
  return {
    reversePInvokeWrapperCount: reader.readUint32(),
    reversePInvokeWrappers: reader.readUint32(),
    genericMethodPointersCount: reader.readUint32(),
    genericMethodPointers: reader.readUint32(),
    genericAdjustorThunks: reader.readUint32(),
    invokerPointersCount: reader.readUint32(),
    invokerPointers: reader.readUint32(),
    unresolvedVirtualCallCount: reader.readUint32(),
    unresolvedVirtualCallPointers: reader.readUint32(),
    interopDataCount: reader.readUint32(),
    interopData: reader.readUint32(),
    windowsRuntimeFactoryCount: reader.readUint32(),
    windowsRuntimeFactoryTable: reader.readUint32(),
    codeGenModulesCount: reader.readUint32(),
    codeGenModules: reader.readUint32(),
  };
}

function readCodeGenModules(
  reader: BinaryReader,
  offset: number,
  size: number,
) {
  reader.seek(offset);
  const modules = [];
  for (let i = 0; i < size; i++) {
    modules.push(reader.readUint32());
  }
  return modules;
}

function readCodeGenModule(
  reader: BinaryReader,
  offset: number,
): Il2CppCodeGenModule {
  reader.seek(offset);
  return {
    moduleName: reader.readUint32(),
    methodPointerCount: reader.readInt32(),
    methodPointers: reader.readUint32(),
    adjustorThunkCount: reader.readInt32(),
    adjustorThunks: reader.readUint32(),
    invokerIndices: reader.readUint32(),
    reversePInvokeWrapperCount: reader.readUint32(),
    reversePInvokeWrapperIndices: reader.readUint32(),
    rgctxRangesCount: reader.readInt32(),
    rgctxRanges: reader.readUint32(),
    rgctxsCount: reader.readInt32(),
    rgctxs: reader.readUint32(),
    debuggerMetadata: reader.readUint32(),
    moduleInitializer: reader.readUint32(),
    staticConstructorTypeIndices: reader.readUint32(),
    metadataRegistration: reader.readUint32(),
    codeRegistration: reader.readUint32(),
  };
}

function readCodeGenModuleMethodPointers(
  reader: BinaryReader,
  offset: number,
  size: number,
) {
  reader.seek(offset);
  const methodPointers = [];
  for (let i = 0; i < size; i++) {
    methodPointers.push(reader.readUint32());
  }
  return methodPointers;
}

function getSectionHelper(
  length: number,
  memoryBuffer: ArrayBuffer,
  bssStart: number,
  methodCount: number,
  imageCount: number,
) {
  const exec = {
    offset: 0,
    offsetEnd: methodCount,
    address: 0,
    addressEnd: methodCount,
  };
  const data = {
    offset: 1024,
    offsetEnd: length,
    address: 1024,
    addressEnd: length,
  };
  const bss = {
    offset: bssStart,
    offsetEnd: BigInt(9223372036854775807),
    address: bssStart,
    addressEnd: BigInt(9223372036854775807),
  };
  const sectionHelper = new SectionHelper(memoryBuffer, imageCount);
  sectionHelper.setExecSection(exec);
  sectionHelper.setDataSection(data);
  sectionHelper.setBssSection(bss);
  return sectionHelper;
}

class SectionHelper {
  private exec: any[] = [];
  private data: any[] = [];
  private bss: any[] = [];
  private memoryReader: BinaryReader;
  private imageCount: number;

  private static featureBytes = new Uint8Array([
    0x6d, 0x73, 0x63, 0x6f, 0x72, 0x6c, 0x69, 0x62, 0x2e, 0x64, 0x6c, 0x6c,
    0x00,
  ]);

  constructor(memoryBuffer: any, imageCount: number) {
    this.memoryReader = new BinaryReader(memoryBuffer);
    this.imageCount = imageCount;
  }

  public setExecSection(exec: any) {
    this.exec.push(exec);
  }

  public setDataSection(data: any) {
    this.data.push(data);
  }

  public setBssSection(bss: any) {
    this.bss.push(bss);
  }

  public findCodeRegistration(): number {
    let codeRegistration = this.findCodeRegistrationData();
    return codeRegistration;
  }

  private findCodeRegistrationData(): number {
    return this.findCodeRegistration2019(this.data);
  }

  private findCodeRegistration2019(secs: any[]): number {
    for (let i = 0; i < secs.length; i++) {
      const sec = secs[i];
      this.memoryReader.seek(sec.offset);
      const buff = this.memoryReader.readUint8Array(sec.offsetEnd - sec.offset);
      const matches = patternSearch(buff, SectionHelper.featureBytes);
      for (let j = 0; j < matches.length; j++) {
        const dllva = matches[j] + sec.address;
        const refvas = this.findReference(dllva);
        for (let k = 0; k < refvas.length; k++) {
          const refva = refvas[k];
          const refva2s = this.findReference(refva);
          for (let l = 0; l < refva2s.length; l++) {
            const refva2 = refva2s[l];
            for (let m = this.imageCount - 1; m >= 0; m--) {
              const refva3s = this.findReference(refva2 - m * 4);
              for (let n = 0; n < refva3s.length; n++) {
                const refva3 = refva3s[n];
                this.memoryReader.seek(refva3 - 4);
                if (this.memoryReader.readInt32() === this.imageCount) {
                  return refva3 - 4 * 14;
                }
              }
            }
          }
        }
      }
    }
    return 0;
  }

  private findReference(addr: number): number[] {
    const references: number[] = [];
    for (let i = 0; i < this.data.length; i++) {
      const dataSec = this.data[i];
      var position = dataSec.offset;
      const end =
        Math.min(dataSec.offsetEnd, this.memoryReader.buffer.byteLength) - 4;
      while (position < end) {
        this.memoryReader.seek(position);
        if (this.memoryReader.readUint32() === addr) {
          references.push(position - dataSec.offset + dataSec.address);
        }
        position += 4;
      }
    }
    return references;
  }
}
