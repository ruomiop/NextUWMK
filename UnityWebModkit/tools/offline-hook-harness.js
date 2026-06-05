const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");

const projectRoot = path.resolve(__dirname, "..");
const defaultAssetRoot = path.resolve(projectRoot, "..");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) {
    args.set(key, "true");
  } else {
    args.set(key, next);
    i += 1;
  }
}

const assetRoot = path.resolve(args.get("asset-root") || defaultAssetRoot);
const dataFile = path.resolve(
  args.get("data") || path.join(assetRoot, "WebGL.data.acc67798.unityweb"),
);
const wasmFile = path.resolve(
  args.get("wasm") || path.join(assetRoot, "WebGL.wasm.code.acc67798.unityweb"),
);
const typeName = args.get("type") || "PlayerController";
const methodName = args.get("method") || "Update";

const referencedAssemblies = (args.get("assemblies") || [
  "1v1.dll",
  "ACTk.Runtime.dll",
  "GameAssembly.dll",
  "System.Runtime.InteropServices.dll",
  "mscorlib.dll",
  "PhotonRealtime.dll",
  "PhotonUnityNetworking.dll",
  "PhotonUnityNetworking.Utilities.dll",
  "Assembly-CSharp.dll",
  "UnityEngine.CoreModule.dll",
  "UnityEngine.PhysicsModule.dll",
  "StompyRobot.SRDebugger.dll",
  "UnityEngine.IMGUIModule.dll",
  "Photon3Unity3D.dll",
  "Unity.TextMeshPro.dll",
  "FishNet.Runtime.dll",
  "UnityEngine.AnimationModule.dll",
].join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function readNullTerminatedUtf8(buffer, offset) {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  return {
    value: buffer.subarray(offset, end).toString("utf8"),
    next: end + 1,
  };
}

function readUnityWebData(file) {
  const buffer = fs.readFileSync(file);
  let cursor = 0;
  const signature = readNullTerminatedUtf8(buffer, cursor);
  cursor = signature.next;
  const headLen = buffer.readUInt32LE(cursor);
  cursor += 4;

  const nodeHeaders = [];
  while (cursor < headLen) {
    const offset = buffer.readUInt32LE(cursor);
    const size = buffer.readUInt32LE(cursor + 4);
    const nameLength = buffer.readUInt32LE(cursor + 8);
    cursor += 12;
    const name = buffer.subarray(cursor, cursor + nameLength).toString("utf8");
    cursor += nameLength;
    nodeHeaders.push({ offset, size, name });
  }

  const wanted = new Set([
    "data.unity3d",
    "Il2CppData/Metadata/global-metadata.dat",
    "global-metadata.dat",
  ]);
  const nodes = nodeHeaders
    .filter((node) => wanted.has(node.name))
    .map((node) => ({
      ...node,
      data: toArrayBuffer(buffer.subarray(node.offset, node.offset + node.size)),
    }));

  let unityVersion;
  const dataUnity3d = nodes.find((node) => node.name === "data.unity3d");
  if (dataUnity3d) {
    const dataBuffer = Buffer.from(dataUnity3d.data);
    unityVersion = readNullTerminatedUtf8(dataBuffer, 18).value;
  }

  return {
    signature: signature.value,
    headLen,
    nodes,
    unityVersion,
    getNode(name) {
      return this.nodes.find((node) => node.name === name);
    },
  };
}

function loadModkitBundle() {
  const distFile = fs
    .readdirSync(path.join(projectRoot, "dist"))
    .find((name) => /^unity-web-modkit\..+\.js$/.test(name));
  if (!distFile) throw new Error("No dist/unity-web-modkit.*.js found. Run npm run build first.");

  function OfflineXMLHttpRequest() {}
  OfflineXMLHttpRequest.prototype.open = function () {};
  OfflineXMLHttpRequest.prototype.send = function () {};

  function createEmptyIndexedDbRequest(result) {
    const request = { result };
    setTimeout(() => {
      if (request.onsuccess) request.onsuccess({ target: request });
    }, 0);
    return request;
  }

  function createErroredIndexedDbRequest() {
    const request = { error: new Error("offline harness indexedDB is disabled") };
    setTimeout(() => {
      if (request.onerror) request.onerror({ target: request });
    }, 0);
    return request;
  }

  const sandbox = {
    console,
    WebAssembly,
    ArrayBuffer,
    Uint8Array,
    DataView,
    TextDecoder,
    TextEncoder,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      throw new Error("offline harness fetch is not implemented");
    },
    XMLHttpRequest: OfflineXMLHttpRequest,
    location: { href: "http://127.0.0.1/offline-hook-harness" },
    document: { readyState: "complete", scripts: [] },
    indexedDB: {
      databases: async () => [],
      open: () => createErroredIndexedDbRequest(),
      deleteDatabase: () => {
        return createEmptyIndexedDbRequest(undefined);
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.unsafeWindow = sandbox;

  const code = fs.readFileSync(path.join(projectRoot, "dist", distFile), "utf8");
  vm.runInNewContext(code, sandbox, { filename: distFile });
  if (!sandbox.UnityWebModkit?.Runtime) {
    throw new Error("UnityWebModkit.Runtime was not exported by dist bundle.");
  }
  return { uwm: sandbox.UnityWebModkit, distFile };
}

function waitFor(predicate, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function readUlebFromInstruction(instruction) {
  let result = 0;
  let shift = 0;
  for (let i = 1; i < instruction.length; i += 1) {
    const byte = instruction[i];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return result >>> 0;
}

(async () => {
  const webData = readUnityWebData(dataFile);
  const wasmBuffer = toArrayBuffer(fs.readFileSync(wasmFile));
  const { uwm, distFile } = loadModkitBundle();

  uwm.Logger.setDiagnosticsEnabled(true);
  const runtime = uwm.Runtime;
  const plugin = runtime.createPlugin({
    name: "OfflineHookHarness",
    version: "1.0.0",
    referencedAssemblies,
    diagnostics: true,
  });
  if (args.get("probe-updates") === "true") {
    plugin.probeUpdateHooks(
      {
        typePattern: /.*/,
        maxHooks: Number(args.get("max-hooks") || 250),
        logEvery: 120,
        sharedBodyFallback: args.get("shared-body") !== "false",
      },
      () => undefined,
    );
  } else if (args.get("probe-type") === "true") {
    const probeOptions = {
      typeName,
      methodPattern: args.get("method-pattern"),
      maxHooks: Number(args.get("max-hooks") || 200),
      logEvery: 120,
      sharedBodyFallback: args.get("shared-body") !== "false",
    };
    if (args.has("include-returns")) {
      probeOptions.includeReturns = args.get("include-returns") === "true";
    }
    plugin.probeTypeHooks(
      probeOptions,
      () => undefined,
    );
  } else {
    const baseHookInfo = {
      typeName,
      methodName,
      params: ["i32", "i32"],
    };
    if (args.has("shared-body")) {
      baseHookInfo.sharedBodyFallback = args.get("shared-body") !== "false";
    }
    plugin.hookPrefix(baseHookInfo, () => true);
    if (args.get("duplicate-body") === "true") {
      const duplicateHookInfo = {
        typeName: "SimpleEditableBuilding",
        methodName: "Update",
        params: ["i32", "i32"],
      };
      if (args.has("shared-body")) {
        duplicateHookInfo.sharedBodyFallback =
          args.get("shared-body") !== "false";
      }
      plugin.hookPrefix(duplicateHookInfo, () => true);
    }
  }

  runtime.onUnityWebData(webData);
  const metadataReady = await waitFor(() => runtime.metadata.methodCount > 0);
  if (!metadataReady) throw new Error("Timed out waiting for metadata parse.");

  runtime.searchWasmBinary(wasmBuffer);
  const tableIndex = runtime.getTableIndex(typeName, methodName);
  const tableSlot = runtime.getTableSlot(tableIndex);
  const invokerTableIndex = runtime.getInvokerTableIndex(typeName, methodName);
  const invokerTableSlot = runtime.getTableSlot(invokerTableIndex);
  const offlineTableLength = Math.max(
    1,
    tableSlot === undefined ? 0 : tableSlot + 1,
    invokerTableSlot === undefined ? 0 : invokerTableSlot + 1,
  );
  const offlineTable = new WebAssembly.Table({
    element: "anyfunc",
    initial: offlineTableLength,
  });
  if (tableSlot !== undefined) {
    offlineTable.set(
      tableSlot,
      runtime.makeWasmFunc(["i32", "i32"], [], () => undefined),
    );
  }
  if (invokerTableSlot !== undefined) {
    offlineTable.set(
      invokerTableSlot,
      runtime.makeWasmFunc(["i32", "i32"], [], () => undefined),
    );
  }

  let instantiateCalls = 0;
  let compileError;
  runtime.instantiate = async (bufferSource) => {
    instantiateCalls += 1;
    try {
      await WebAssembly.compile(bufferSource);
    } catch (err) {
      compileError = err && err.message ? err.message : String(err);
      throw err;
    }
    return {
      module: {},
      instance: {
        exports: {
          table: offlineTable,
        },
      },
      __offlinePatchedByteLength: bufferSource.byteLength,
    };
  };

  let handleError;
  try {
    await runtime.handleBuffer(wasmBuffer, {});
  } catch (err) {
    handleError = err && err.message ? err.message : String(err);
  }
  const internalIndex =
    tableIndex >= 0 && runtime.internalMappings
      ? runtime.getInternalIndex(tableIndex)
      : undefined;
  const invokerInternalIndex =
    invokerTableIndex >= 0 && runtime.internalMappings
      ? runtime.getInternalIndex(invokerTableIndex)
      : undefined;
  const tableWindow = runtime.internalMappings
    ? Array.from({ length: 9 }, (_, index) => {
        const slot = tableIndex - 4 + index;
        return {
          slot,
          internalIndex:
            slot > 0 && runtime.internalMappings[0]?.elements
              ? runtime.internalMappings[0].elements[slot - 1]
              : undefined,
        };
      })
    : [];
  const directCallers =
    internalIndex === undefined || !runtime.internalWasmCode
      ? []
      : runtime.internalWasmCode
          .filter((func) =>
            (func.instructions || []).some(
              (instruction) =>
                instruction[0] === 0x10 &&
                readUlebFromInstruction(instruction) === internalIndex + 1,
            ),
          )
          .slice(0, 50)
          .map((func) => ({
            preservedIndex: func.preservedIndex,
            globalIndex: runtime.toGlobalFunctionIndex(func.preservedIndex),
            instructionCount: func.instructions?.length || 0,
          }));
  const nearbyTypes =
    tableWindow.length === 0 || !runtime.internalWasmFunctions
      ? []
      : tableWindow.map((item) => ({
          ...item,
          type:
            item.internalIndex !== undefined
              ? runtime.getWasmFunctionTypeByGlobalIndex(item.internalIndex + 1)
              : undefined,
          aliases:
            item.internalIndex !== undefined
              ? runtime
                  .listMethods()
                  .filter((method) => {
                    const methodTableIndex = runtime.getTableIndex(
                      method.typeName,
                      method.name,
                    );
                    return (
                      methodTableIndex > 0 &&
                      runtime.getInternalIndex(methodTableIndex) === item.internalIndex
                    );
                  })
                  .slice(0, 12)
                  .map((method) => `${method.typeName}.${method.name}`)
              : [],
        }));

  const summary = {
    distFile,
    dataFile,
    wasmFile,
    webData: {
      signature: webData.signature,
      unityVersion: webData.unityVersion,
      nodes: webData.nodes.map((node) => ({
        name: node.name,
        offset: node.offset,
        size: node.size,
      })),
    },
    metadata: runtime.metadata,
    target: {
      typeName,
      methodName,
      tableIndex,
      tableSlot,
      internalIndex,
      bodyGlobalIndex: internalIndex === undefined ? undefined : internalIndex + 1,
      invokerTableIndex,
      invokerTableSlot,
      invokerInternalIndex,
      invokerType:
        invokerInternalIndex === undefined
          ? undefined
          : runtime.getWasmFunctionTypeByGlobalIndex(invokerInternalIndex + 1),
      directCallers,
      nearbyTypes,
    },
    instantiateCalls,
    compileError,
    handleError,
  };

  console.log("[offline-hook-harness] summary");
  console.log(JSON.stringify(summary, null, 2));
})().catch((err) => {
  console.error("[offline-hook-harness] failed");
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
