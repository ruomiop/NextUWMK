import { Logger } from "../logger";
import { UnresolvedMetadataError } from "../errors";
import {
  createIl2CppContext,
  createMetadata,
  Il2CppContext,
  Il2CppMetadata,
} from "../il2cpp";
import { WebData } from "../web-data";
import { probeUnityWebDataFromCache, watchUnityWebData } from "../preloader";
import {
  bufToHex,
  concatenateUint8Arrays,
  makeId,
  patternSearch,
  uint8ArrayStartsWith,
  waitFor,
  writeUint8ArrayAtOffset,
} from "../utils";
import {
  BufferReader,
  OP_CALL,
  SECTION_CODE,
  SECTION_ELEMENT,
  SECTION_FUNCTION,
  SECTION_IMPORT,
  SECTION_TYPE,
  VarUint32ToArray,
  WailParser,
  WailVariable,
} from "../wail";
import { BinaryReader, BinaryWriter } from "../utils/binary";
import { dataTypeSizes } from "../extras";

const STORAGE_DB_VERSION = 5;
const METADATA_CACHE_VERSION = 2;
const IL2CPP_CONTEXT_CACHE_VERSION = 6;
const IL2CPP_FUNCTION_CACHE_NAME = "il2cpp-functions";
const WASM_SECTION_EXPORT = 7;
const WASM_SECTION_TAG = 13;

function getPageWindow(): any {
  return (globalThis as any).unsafeWindow || window;
}

declare const FinalizationRegistry:
  | {
      new <T>(cleanupCallback: (heldValue: T) => void): {
        register(target: object, heldValue: T, unregisterToken?: object): void;
        unregister(unregisterToken: object): boolean;
      };
    }
  | undefined;

export class Runtime {
  public tableName: string | undefined;
  public lastPlugin: ModkitPlugin | undefined;
  private logger: Logger;
  private plugins: ModkitPlugin[] = [];
  private startedInitializing = false;
  private allReferencedAssemblies: string[] = [];
  private globalMetadata: Il2CppMetadata | null | undefined;
  private il2CppContext: Il2CppContext | undefined;
  private resolvedIl2CppFunctions: Record<string, number> = {};
  private candidateIl2CppFunctions: Record<string, number[]> = {};
  private fieldOffsetOverrides: Record<string, Record<string, number>> = {};
  private webDataLoaded = false;
  private webDataProbeStarted = false;
  private webDataProbeInFlight = false;
  private webDataProbeStartedAt = 0;
  private unityCandidateSeen = false;
  private instantiateStreaming: any;
  private instantiate: any;
  private internalMappings: any;
  private internalWasmTypes: any;
  private internalWasmFunctions: any;
  private internalWasmCode: any;
  private wasmExports: any;
  private wasmTable?: WebAssembly.Table;
  private wasmModule: any;
  private wasmMemory?: WebAssembly.Memory;
  private wasmCacheKey = "";
  private wasmImportFunctionCount = 0;
  private bodyHookPatchedTargets = new Map<number, Hook[]>();
  private bodyHookAliasCache?: Map<number, string[]>;
  private bodyHookDispatchLogged = new Set<number>();
  private stringNewEncoding: "utf8" | "utf16" = "utf8";
  private allocationRegistry?: {
    register(target: object, heldValue: number, unregisterToken?: object): void;
    unregister(unregisterToken: object): boolean;
  };
  private stackAllocations = new Map<number, number>();

  public constructor() {
    this.logger = new Logger("UnityWebModkit");
    ValueWrapper.bindRuntime(this);
    if (typeof FinalizationRegistry !== "undefined") {
      this.allocationRegistry = new FinalizationRegistry<number>((ptr) => {
        try {
          this.free(ptr);
        } catch {
          // Finalizers run asynchronously and cannot safely report into game code.
        }
      });
    }
  }

  public get metadata() {
    return {
      version: this.globalMetadata?.version,
      rawVersion: this.globalMetadata?.header.version,
      referencedAssemblies: this.globalMetadata?.referencedAssemblies || [],
      imageCount: this.globalMetadata?.originalImageDefCount || 0,
      methodCount: this.globalMetadata?.originalMethodDefCount || 0,
      fieldCount: this.globalMetadata?.originalFieldDefCount || 0,
    };
  }

  public createPlugin(opts: ModkitPluginOptions): ModkitPlugin {
    const diagnostics = resolveDiagnosticsOption(opts);
    if (diagnostics !== undefined) {
      Logger.setDiagnosticsEnabled(diagnostics);
    }
    if (!this.startedInitializing) this.initialize();
    this.diag("createPlugin", {
      name: opts.name,
      referencedAssemblies: opts.referencedAssemblies?.length || 0,
      globalName: opts.globalName,
      diagnostics: Logger.getDiagnosticsEnabled(),
    });
    const plugin = new ModkitPlugin(
      opts.name,
      opts.version,
      opts.referencedAssemblies,
      opts.preferIndirectHooks,
      this,
    );
    this.plugins.push(plugin);
    this.lastPlugin = plugin;
    this.exposePluginGlobals(plugin, opts.globalName);
    return plugin;
  }

  private exposePluginGlobals(
    plugin: ModkitPlugin,
    globalName?: string | string[],
  ) {
    const page = getPageWindow();
    const targets = [page, window, globalThis].filter(
      (target, index, list) => target && list.indexOf(target) === index,
    );
    const names = Array.isArray(globalName)
      ? globalName
      : globalName
      ? [globalName]
      : [];
    for (const name of names) {
      if (!name) continue;
      for (const target of targets) {
        try {
          Object.defineProperty(target, name, {
            value: plugin,
            writable: true,
            configurable: true,
          });
        } catch {
          try {
            target[name] = plugin;
          } catch {
            // Some browser script worlds expose read-only globals.
          }
        }
      }
    }
  }

  private diag(message: string, data?: any) {
    if (data === undefined) {
      this.logger.info("[DIAG] %s", message);
      return;
    }
    this.logger.info("[DIAG] %s %o", message, data);
  }

  private async initialize(): Promise<void> {
    if (typeof window === "undefined") {
      console.log(
        "\x1b[37m[UnityWebModkit]\x1b[0m \x1b[33m[WARN]\x1b[0m Not running in a browser environment! Nothing will be executed.",
      );
      return;
    }
    const page = getPageWindow();
    this.startedInitializing = true;
    this.diag("initialize", {
      href: page.location?.href,
      readyState: page.document?.readyState,
      hasPageWebData: Boolean(page.__UnityWebModkitWebData),
    });
    this.hookWasmInstantiate();
    watchUnityWebData(
      (webData) => this.onUnityWebData(webData),
      () => {
        this.unityCandidateSeen = true;
        this.startWebDataProbe();
      },
    );
    this.startWebDataProbe();
    if (page.__UnityWebModkitWebData) {
      this.onUnityWebData(page.__UnityWebModkitWebData);
    }
  }

  private startWebDataProbe() {
    if (this.webDataLoaded || this.webDataProbeInFlight) return;
    this.webDataProbeStarted = true;
    if (!this.webDataProbeStartedAt) this.webDataProbeStartedAt = Date.now();
    this.webDataProbeInFlight = true;
    this.diag("web-data probe start", {
      elapsed: Date.now() - this.webDataProbeStartedAt,
    });
    probeUnityWebDataFromCache()
      .then((webData) => {
        if (webData) {
          this.diag("web-data probe hit", {
            nodes: webData.nodes.length,
            unityVersion: webData.unityVersion,
          });
          this.onUnityWebData(webData);
          return;
        }
        this.diag("web-data probe miss");
        this.scheduleWebDataProbeRetry();
      })
      .catch((err) => {
        this.logger.warn("Unable to probe Unity web data cache: %o", err);
        this.scheduleWebDataProbeRetry();
      })
      .finally(() => {
        this.webDataProbeInFlight = false;
      });
  }

  private scheduleWebDataProbeRetry() {
    if (this.webDataLoaded) return;
    if (this.unityCandidateSeen) {
      this.diag("web-data probe retry skipped: waiting for Unity XHR");
      return;
    }
    const page = getPageWindow();
    const elapsed = Date.now() - this.webDataProbeStartedAt;
    if (elapsed > 30000) return;
    page.setTimeout(() => this.startWebDataProbe(), elapsed < 5000 ? 100 : 500);
  }

  private onUnityWebData(webData: WebData) {
    if (this.webDataLoaded) return;
    const page = getPageWindow();
    this.webDataLoaded = true;
    this.diag("web-data received", {
      nodes: webData.nodes.map((node) => ({
        name: node.name,
        size: node.size,
        hasData: Boolean(node.data),
      })),
      unityVersion: webData.unityVersion,
    });
    this.logger.debug("Parsed web data into %d node(s)", webData.nodes.length);
    webData.unityVersion
      ? this.logger.info("Running under Unity %s", webData.unityVersion)
      : this.logger.warn("Unable to determine Unity version from web data!");
    this.readGlobalMetadataFromStorage(webData)
      .then(() => {
        this.diag("metadata loaded from cache", this.metadata);
      })
      .catch(() => {
        this.diag("metadata cache miss; parsing from web data");
      page.indexedDB.deleteDatabase("UnityWebModkit");
      this.loadGlobalMetadata(webData);
      });
  }

  private async loadGlobalMetadata(webData: WebData) {
    const metadataNode = webData.getNode(
      "Il2CppData/Metadata/global-metadata.dat",
    );
    if (!metadataNode || !metadataNode.data) {
      this.logger.error(
        new UnresolvedMetadataError(
          "Unable to find global-metadata.dat! The game may be encrypted, corrupt or unsupported.",
        ).print(),
      );
      return;
    }
    this.diag("metadata parse start", {
      size: metadataNode.data.byteLength,
      referencedAssemblies: this.plugins.flatMap(
        (plugin) => plugin.referencedAssemblies,
      ),
    });
    this.allReferencedAssemblies = this.plugins.flatMap(
      (plugin) => plugin.referencedAssemblies,
    );
    const globalMetadata = await createMetadata(
      metadataNode.data,
      this.allReferencedAssemblies,
      webData.unityVersion,
    );
    if (globalMetadata.isErr()) {
      this.logger.error(globalMetadata.error.print());
      return;
    }
    this.globalMetadata = globalMetadata.value;
    this.diag("metadata parse complete", this.metadata);
    this.saveGlobalMetadata();
  }

  private saveGlobalMetadata() {
    const request = getPageWindow().indexedDB.open(
      "UnityWebModkit",
      STORAGE_DB_VERSION,
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      const objectStore = db.objectStoreNames.contains("storage")
        ? request.transaction!.objectStore("storage")
        : db.createObjectStore("storage", { keyPath: "name" });
      if (!objectStore.indexNames.contains("name")) {
        objectStore.createIndex("name", "name", { unique: true });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.transaction("storage", "readwrite")
        .objectStore("storage")
        .put({
          ...this.globalMetadata,
          cacheVersion: METADATA_CACHE_VERSION,
        });
    };
  }

  private saveIl2CppContext() {
    const request = getPageWindow().indexedDB.open(
      "UnityWebModkit",
      STORAGE_DB_VERSION,
    );
    request.onsuccess = () => {
      const db = request.result;
      const storageObjectStore = db
        .transaction("storage", "readwrite")
        .objectStore("storage");
      storageObjectStore.put({
        ...this.il2CppContext,
        cacheVersion: IL2CPP_CONTEXT_CACHE_VERSION,
      });
    };
  }

  private saveIl2CppFunctionCache() {
    if (!this.wasmCacheKey) return;
    const request = getPageWindow().indexedDB.open(
      "UnityWebModkit",
      STORAGE_DB_VERSION,
    );
    request.onsuccess = () => {
      const db = request.result;
      const storageObjectStore = db
        .transaction("storage", "readwrite")
        .objectStore("storage");
      storageObjectStore.put({
        name: IL2CPP_FUNCTION_CACHE_NAME,
        wasmCacheKey: this.wasmCacheKey,
        metadataHash: this.globalMetadata?.integrityHash,
        resolvedIl2CppFunctions: this.resolvedIl2CppFunctions,
        stringNewEncoding: this.stringNewEncoding,
      });
    };
  }

  private readIl2CppFunctionCache(): Promise<{
    resolvedIl2CppFunctions: Record<string, number>;
    stringNewEncoding?: "utf8" | "utf16";
  }> {
    return new Promise<{
      resolvedIl2CppFunctions: Record<string, number>;
      stringNewEncoding?: "utf8" | "utf16";
    }>((resolve, reject) => {
      if (!this.wasmCacheKey) {
        reject();
        return;
      }
      const page = getPageWindow();
      page.indexedDB.databases().then(async (databases: IDBDatabaseInfo[]) => {
        const uwmStore = databases.findIndex(
          (d) => d.name === "UnityWebModkit",
        );
        if (uwmStore == -1) {
          reject();
          return;
        }
        const request = page.indexedDB.open(
          "UnityWebModkit",
          STORAGE_DB_VERSION,
        );
        request.onsuccess = () => {
          const transaction = request.result.transaction(["storage"]);
          const objectStore = transaction.objectStore("storage");
          const cacheRequest = objectStore.get(IL2CPP_FUNCTION_CACHE_NAME);
          cacheRequest.onsuccess = () => {
            const cache = cacheRequest.result;
            if (
              !cache ||
              cache.wasmCacheKey !== this.wasmCacheKey ||
              cache.metadataHash !== this.globalMetadata?.integrityHash ||
              !cache.resolvedIl2CppFunctions ||
              !cache.resolvedIl2CppFunctions["il2cpp_string_new"] ||
              !cache.resolvedIl2CppFunctions["il2cpp_object_new"]
            ) {
              reject();
              return;
            }
            resolve({
              resolvedIl2CppFunctions: cache.resolvedIl2CppFunctions,
              stringNewEncoding:
                cache.stringNewEncoding === "utf16" ? "utf16" : "utf8",
            });
          };
          cacheRequest.onerror = () => reject();
        };
        request.onerror = () => reject();
      });
    });
  }

  private readGlobalMetadataFromStorage(webData: WebData): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const page = getPageWindow();
      page.indexedDB.databases().then(async (databases: IDBDatabaseInfo[]) => {
        const uwmStore = databases.findIndex(
          (d) => d.name === "UnityWebModkit",
        );
        if (uwmStore == -1) {
          reject();
          return;
        }
        const request = page.indexedDB.open(
          "UnityWebModkit",
          STORAGE_DB_VERSION,
        );
        request.onsuccess = () => {
          const transaction = request.result.transaction(["storage"]);
          const objectStore = transaction.objectStore("storage");
          const metadataRequest = objectStore.get("metadata");
          metadataRequest.onsuccess = async () => {
            const metadataNode = webData.getNode(
              "Il2CppData/Metadata/global-metadata.dat",
            );
            if (!metadataNode || !metadataNode.data) {
              reject();
              return;
            }
            this.allReferencedAssemblies = this.plugins.flatMap(
              (plugin) => plugin.referencedAssemblies,
            );
            const globalMetadata = metadataRequest.result;
            if (
              !globalMetadata ||
              globalMetadata.cacheVersion !== METADATA_CACHE_VERSION ||
              !globalMetadata.originalTypeDefCount ||
              !this.hasMetadataRuntimeIndexes(globalMetadata)
            ) {
              reject();
              return;
            }
            if (
              JSON.stringify(this.allReferencedAssemblies.sort()) !==
              JSON.stringify(globalMetadata.referencedAssemblies.sort())
            ) {
              reject();
              return;
            }
            const currentHash = bufToHex(
              await page.crypto.subtle.digest("SHA-256", metadataNode.data),
            );
            if (currentHash !== globalMetadata.integrityHash) {
              reject();
              return;
            }
            this.globalMetadata = globalMetadata;
            resolve();
          };
        };
      });
    });
  }

  private readIl2CppContextFromStorage(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const page = getPageWindow();
      page.indexedDB.databases().then(async (databases: IDBDatabaseInfo[]) => {
        const uwmStore = databases.findIndex(
          (d) => d.name === "UnityWebModkit",
        );
        if (uwmStore == -1) {
          reject();
          return;
        }
        const request = page.indexedDB.open(
          "UnityWebModkit",
          STORAGE_DB_VERSION,
        );
        request.onsuccess = () => {
          const transaction = request.result.transaction(["storage"]);
          const objectStore = transaction.objectStore("storage");
          const il2CppRequest = objectStore.get("il2cpp");
          il2CppRequest.onsuccess = async () => {
            const context = il2CppRequest.result;
            if (
              !context ||
              context.cacheVersion !== IL2CPP_CONTEXT_CACHE_VERSION ||
              !context.fieldData ||
              !context.scriptData ||
              !this.hasUsableFieldData(context.fieldData) ||
              context.integrityHash !== this.globalMetadata?.integrityHash ||
              JSON.stringify((context.referencedAssemblies || []).sort()) !==
                JSON.stringify((this.allReferencedAssemblies || []).sort())
            ) {
              reject();
              return;
            }
            this.il2CppContext = context;
            resolve();
          };
        };
      });
    });
  }

  private hasUsableFieldData(fieldData: Il2CppContext["fieldData"]) {
    return Object.values(fieldData).some((fields) =>
      Object.values(fields).some((field) => field.offset >= 0),
    );
  }

  private hasMetadataRuntimeIndexes(metadata: Il2CppMetadata) {
    return (
      Array.isArray(metadata.typeDefs) &&
      Array.isArray(metadata.methodDefs) &&
      Array.isArray(metadata.fieldDefs) &&
      metadata.typeDefs.some((def) => def.typeIndex !== undefined) &&
      metadata.methodDefs.some((def) => def.methodIndex !== undefined) &&
      metadata.fieldDefs.some((def) => def.fieldIndex !== undefined)
    );
  }

  private hookWasmInstantiate() {
    const page = getPageWindow();
    this.diag("hook wasm instantiate", {
      hasInstantiate: typeof page.WebAssembly?.instantiate === "function",
      hasInstantiateStreaming:
        typeof page.WebAssembly?.instantiateStreaming === "function",
    });
    this.instantiateStreaming = page.WebAssembly.instantiateStreaming;
    page.WebAssembly.instantiateStreaming =
      this.onWebAssemblyInstantiateStreaming.bind(this);
    this.instantiate = page.WebAssembly.instantiate;
    page.WebAssembly.instantiate = this.onWebAssemblyInstantiate.bind(
      this,
    ) as any;
  }

  private async onWebAssemblyInstantiateStreaming(
    source: Response | PromiseLike<Response>,
    importObject?: WebAssembly.Imports | undefined,
  ): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
    if (!(await this.shouldHandleWasmInstantiate())) {
      this.diag("instantiateStreaming passthrough");
      return this.instantiateStreaming(source, importObject);
    }
    this.diag("instantiateStreaming intercepted");
    // Wait for the Il2Cpp metadata to be resolved before continuing
    const metadataReady = await waitFor(() => this.globalMetadata, 15000);
    if (!metadataReady) {
      this.logger.warn(
        "Timed out waiting for global-metadata.dat; continuing without UnityWebModkit patches.",
      );
      this.diag("instantiateStreaming metadata timeout");
      return this.instantiateStreaming(source, importObject);
    }
    if (this.globalMetadata?.imageDefs.length === 0)
      return this.instantiateStreaming(source, importObject);
    let bufferSource: ArrayBuffer;
    const page = getPageWindow();
    if (source && typeof (source as any).then === "function") {
      bufferSource = await (source as PromiseLike<Response>).then(
        (res: Response) => res.arrayBuffer(),
      );
    } else if (source instanceof page.Response) {
      bufferSource = await (source as Response).arrayBuffer();
    } else {
      this.logger.error(
        "TypeError: Got an unexpected object type as the first argument to WebAssembly.instantiateStreaming",
      );
      return Promise.reject();
    }
    return this.handleBuffer(bufferSource, importObject);
  }

  private async onWebAssemblyInstantiate(
    source: BufferSource | WebAssembly.Module,
    importObject?: WebAssembly.Imports | undefined,
  ): Promise<WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance> {
    if (!(await this.shouldHandleWasmInstantiate())) {
      this.diag("instantiate passthrough");
      return this.instantiate(source, importObject);
    }
    this.diag("instantiate intercepted", {
      sourceType: source instanceof getPageWindow().WebAssembly.Module
        ? "module"
        : ArrayBuffer.isView(source)
        ? "view"
        : source instanceof ArrayBuffer
        ? "arraybuffer"
        : typeof source,
    });
    const metadataReady = await waitFor(() => this.globalMetadata, 15000);
    if (!metadataReady) {
      this.logger.warn(
        "Timed out waiting for global-metadata.dat; continuing without UnityWebModkit patches.",
      );
      this.diag("instantiate metadata timeout");
      return this.instantiate(source, importObject);
    }
    if (this.globalMetadata?.imageDefs.length === 0)
      return this.instantiate(source, importObject);
    const page = getPageWindow();
    if (source instanceof page.WebAssembly.Module) {
      return this.instantiate(source, importObject);
    }
    let bufferSource: ArrayBuffer;
    if (source instanceof page.ArrayBuffer || source instanceof ArrayBuffer) {
      bufferSource = source as ArrayBuffer;
    } else if (ArrayBuffer.isView(source)) {
      bufferSource = source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength,
      );
    } else {
      this.logger.error(
        "TypeError: Got an unexpected object type as the first argument to WebAssembly.instantiate",
      );
      return Promise.reject();
    }
    return this.handleBuffer(bufferSource, importObject);
  }

  private async shouldHandleWasmInstantiate(): Promise<boolean> {
    const page = getPageWindow();
    if (this.globalMetadata) {
      this.diag("wasm should-handle: metadata ready");
      return true;
    }
    if (page.__UnityWebModkitUnityCandidateSeen) {
      this.startWebDataProbe();
      const result = await this.waitForGlobalMetadata(30000, 30000);
      this.diag("wasm should-handle: candidate seen", { result });
      return result;
    }
    if (!this.isLikelyUnityFrame()) {
      this.diag("wasm should-handle: not likely unity");
      return false;
    }
    page.__UnityWebModkitUnityCandidateSeen = true;
    this.startWebDataProbe();
    const result = await this.waitForGlobalMetadata(30000, 30000);
    this.diag("wasm should-handle: likely unity", { result });
    return result;
  }

  private async waitForGlobalMetadata(
    timeoutMs: number,
    noWebDataTimeoutMs: number,
  ): Promise<boolean> {
    const page = getPageWindow();
    const startedAt = Date.now();
    while (!this.globalMetadata && Date.now() - startedAt < timeoutMs) {
      if (!this.webDataLoaded && Date.now() - startedAt >= noWebDataTimeoutMs) {
        this.diag("wait metadata stop: no web data", {
          elapsed: Date.now() - startedAt,
          timeoutMs,
          noWebDataTimeoutMs,
        });
        return false;
      }
      await new Promise((resolve) => page.setTimeout(resolve, 25));
    }
    this.diag("wait metadata complete", {
      result: Boolean(this.globalMetadata),
      elapsed: Date.now() - startedAt,
      webDataLoaded: this.webDataLoaded,
    });
    return Boolean(this.globalMetadata);
  }

  private isLikelyUnityFrame(): boolean {
    const page = getPageWindow();
    const href = String(page.location?.href || "").toLowerCase();
    const scripts = Array.from(
      page.document?.scripts || [],
    ) as HTMLScriptElement[];
    return (
      typeof page.createUnityInstance === "function" ||
      href.includes("unity") ||
      href.includes("webgl") ||
      href.includes("/build/") ||
      href.includes("game-files") ||
      scripts.some((script) => {
        const src = String(script.src || "").toLowerCase();
        return (
          src.includes(".loader.js") ||
          src.includes("unityloader") ||
          src.includes("unity")
        );
      })
    );
  }

  private handleBuffer(
    bufferSource: ArrayBuffer,
    importObject?: WebAssembly.Imports | undefined,
  ): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
    return new Promise<WebAssembly.WebAssemblyInstantiatedSource>(
      async (resolve, reject) => {
        if (!importObject) importObject = {};
        this.diag("handleBuffer start", {
          byteLength: bufferSource.byteLength,
          metadata: this.metadata,
        });
        this.bodyHookPatchedTargets.clear();
        this.bodyHookAliasCache = undefined;
        this.bodyHookDispatchLogged.clear();
        await this.readIl2CppContextFromStorage().catch(() => undefined);
        this.diag("il2cpp context after cache", {
          hasContext: Boolean(this.il2CppContext),
          typeAddresses: this.il2CppContext?.typeAddresses?.length || 0,
        });
        if (!this.il2CppContext || !this.hasWasmStructure()) {
          this.searchWasmBinary(bufferSource);
        }
        if (!this.il2CppContext) {
          this.diag("il2cpp context unavailable");
          reject(new Error("Unable to create or load IL2CPP context"));
          return;
        }
        this.diag("il2cpp context ready", {
          referencedAssemblies: this.il2CppContext.referencedAssemblies?.length || 0,
          typeAddresses: this.il2CppContext.typeAddresses?.length || 0,
          fieldTypes: Object.keys(this.il2CppContext.fieldData || {}).length,
          methodTypes: Object.keys(this.il2CppContext.scriptData || {}).length,
        });
        for (const plugin of this.plugins) {
          plugin.expandPendingUpdateProbes();
        }
        this.applyImportHooks(importObject);

        if (this.shouldUseIndirectOnlyHooks()) {
          this.logger.message("Chainloader initialized");
          this.logger.info("%d plugin(s) to load", this.plugins.length);
          this.instantiate(bufferSource, importObject).then((source: any) => {
            this.rememberWasmExports(source, importObject);
            const tableName =
              this.tableName || this.resolveTableName(source.instance.exports);
            for (const plugin of this.plugins) {
              this.logger.info("Loading [%s %s]", plugin.name, plugin.version);
              plugin.expandPendingUpdateProbes();
              for (const hook of plugin.hooks) {
                hook.tableIndex = this.getTableIndex(
                  hook.typeName,
                  hook.methodName,
                );
                if (!this.isValidTableIndex(hook.tableIndex)) {
                  this.logger.warn(
                    "Skipping hook %s.%s: unable to resolve table index",
                    hook.typeName,
                    hook.methodName,
                  );
                  hook.enabled = false;
                  hook.applied = true;
                  continue;
                }
                if (!this.applyIndirectHook(source, hook, tableName)) {
                  this.logger.warn(
                    "Hook %s.%s was not applied",
                    hook.typeName,
                    hook.methodName,
                  );
                }
              }
            }
            this.logger.message("Chainloader startup complete");
            resolve(source);
            this.schedulePluginLoadedCallbacks();
          }, reject);
          return;
        }

        const bufferUint8Array = new Uint8Array(bufferSource);
        this.wasmCacheKey = this.makeWasmCacheKey(bufferSource);
        const cachedIl2CppFunctionCache =
          await this.readIl2CppFunctionCache().catch(() => undefined);
        this.diag("il2cpp function cache", {
          hit: Boolean(cachedIl2CppFunctionCache),
          wasmCacheKey: this.wasmCacheKey,
        });
        const hasPendingMethodProbes = this.plugins.some(
          (plugin) => plugin.hasPendingMethodProbes,
        );
        const hasHooks =
          hasPendingMethodProbes ||
          this.plugins.some((plugin) => plugin.hooks.length > 0);
        const hasBytecodePatches = this.plugins.some(
          (plugin) => plugin.bytecodePatches.length > 0,
        );
        if (!cachedIl2CppFunctionCache || hasHooks || hasBytecodePatches) {
          this.resetWasmStructureCache();
          const wailPreparser = new WailParser(bufferUint8Array);
          wailPreparser._optionalSectionFlags |= 1 << SECTION_CODE;
          wailPreparser._optionalSectionFlags |= 1 << SECTION_ELEMENT;
          wailPreparser._optionalSectionFlags |= 1 << SECTION_FUNCTION;
          wailPreparser._optionalSectionFlags |= 1 << SECTION_IMPORT;
          wailPreparser._optionalSectionFlags |= 1 << SECTION_TYPE;
          wailPreparser.parse();
          this.wasmImportFunctionCount =
            (wailPreparser as any)._importFuncCount || 0;
          this.syncWasmStructureFromRuntime();
          for (const plugin of this.plugins) {
            plugin.expandPendingMethodProbes();
          }
        }
        if (cachedIl2CppFunctionCache) {
          this.resolvedIl2CppFunctions =
            cachedIl2CppFunctionCache.resolvedIl2CppFunctions;
          this.stringNewEncoding =
            cachedIl2CppFunctionCache.stringNewEncoding || "utf8";
          this.candidateIl2CppFunctions = {};
          this.logger.info(
            "Loaded IL2CPP function resolver cache: string_new=%d (%s) object_new=%d",
            this.resolvedIl2CppFunctions["il2cpp_string_new"],
            this.stringNewEncoding,
            this.resolvedIl2CppFunctions["il2cpp_object_new"],
          );
        } else {
          this.resolveIl2CppFunctions(importObject);
          this.saveIl2CppFunctionCache();
        }
        if (
          cachedIl2CppFunctionCache &&
          Object.keys(this.candidateIl2CppFunctions).length === 0 &&
          !hasHooks &&
          !hasBytecodePatches
        ) {
          const patchedBuffer = this.patchWasmExports(
            bufferUint8Array,
            this.resolvedIl2CppFunctions,
          );
          this.logger.info(
            hasHooks
              ? "Using cached IL2CPP export-only patch path with runtime table hooks"
              : "Using cached IL2CPP export-only patch path",
          );
          this.logger.message("Chainloader initialized");
          this.logger.info("%d plugin(s) to load", this.plugins.length);
          this.instantiate(patchedBuffer, importObject).then(
            (source: WebAssembly.WebAssemblyInstantiatedSource) => {
              this.rememberWasmExports(source, importObject);
              const tableName: string =
                this.tableName ||
                this.resolveTableName((source as any).instance.exports);
              for (const plugin of this.plugins) {
                this.logger.info(
                  "Loading [%s %s]",
                  plugin.name,
                  plugin.version,
                );
                for (const hook of plugin.hooks) {
                  hook.tableIndex = this.getTableIndex(
                    hook.typeName,
                    hook.methodName,
                  );
                  if (!this.isValidTableIndex(hook.tableIndex)) {
                    this.logger.warn(
                      "Skipping hook %s.%s: unable to resolve table index",
                      hook.typeName,
                      hook.methodName,
                    );
                    hook.enabled = false;
                    hook.applied = true;
                    continue;
                  }
                  if (!this.applyIndirectHook(source, hook, tableName)) {
                    this.logger.warn(
                      "Hook %s.%s was not applied",
                      hook.typeName,
                      hook.methodName,
                    );
                  }
                }
              }
              this.logger.message("Chainloader startup complete");
              resolve(source);
              this.schedulePluginLoadedCallbacks();
            },
            reject,
          );
          return;
        }
        const wail = new WailParser(bufferUint8Array);
        this.exportIl2CppFunctions(wail);
        this.logger.message("Chainloader initialized");
        this.logger.info("%d plugin(s) to load", this.plugins.length);
        const replacementFuncIndexes: WailVariable[] = [];
        const oldFuncIndexes: WailVariable[] = [];
        const patchedHooks: Hook[] = [];
        const runtimeTableFallbackHooks: Hook[] = [];
        const hookRewriteCounts: number[] = [];
        var i = 0,
          pluginLen = this.plugins.length;
        while (i < pluginLen) {
          const usePlugin = this.plugins[i];
          this.logger.info(
            "Loading [%s %s]",
            usePlugin.name,
            usePlugin.version,
          );
          usePlugin.expandPendingUpdateProbes();
          usePlugin.expandPendingMethodProbes();
          this.applyBytecodePatches(wail, usePlugin);
          var j = 0,
            hookLen = usePlugin.hooks.length;
          while (j < hookLen) {
            const useHook = usePlugin.hooks[j];
            useHook.tableIndex = this.getTableIndex(
              useHook.typeName,
              useHook.methodName,
            );
            if (!this.isValidTableIndex(useHook.tableIndex)) {
              this.logger.warn(
                "Skipping hook %s.%s: unable to resolve table index",
                useHook.typeName,
                useHook.methodName,
              );
              useHook.enabled = false;
              useHook.applied = true;
              ++j;
              continue;
            }
            useHook.index = this.getInternalIndex(useHook.tableIndex);
            if (!this.isValidInternalIndex(useHook.index)) {
              this.logger.warn(
                "Skipping hook %s.%s: unable to resolve internal function index",
                useHook.typeName,
                useHook.methodName,
              );
              useHook.enabled = false;
              useHook.applied = true;
              ++j;
              continue;
            }
            const injectName =
              useHook.typeName + "xx" + useHook.methodName + makeId(8);
            const originalExportName = "__uwm_original_" + injectName;
            let injectFunc = null;
            if (!useHook.kind) {
              injectFunc = (...args: number[]) => {
                useHook.callCount = (useHook.callCount || 0) + 1;
                useHook.lastArgs = Array.from(args);
                const originalFunction =
                  this.getWasmExportFunction(originalExportName);
                if (!originalFunction) {
                  throw new Error(
                    `Unable to locate original hook export ${originalExportName}`,
                  );
                }
                if (!useHook.enabled) {
                  if (useHook.returnType) {
                    return originalFunction(...args);
                  }
                  originalFunction(...args);
                  return;
                }
                const wrappedArgs: ValueWrapper[] = args.map(
                  (arg) => new ValueWrapper(arg),
                );
                const result = useHook.callback(...wrappedArgs);
                // Unwrap arguments in case they were changed in the callback function
                args = wrappedArgs.map((arg) => arg.val());
                if (result === undefined || result === true) {
                  if (useHook.returnType) {
                    return originalFunction(...args);
                  }
                  originalFunction(...args);
                }
              };
            } else {
              injectFunc = (...args: number[]) => {
                useHook.callCount = (useHook.callCount || 0) + 1;
                useHook.lastArgs = Array.from(args);
                const originalFunction =
                  this.getWasmExportFunction(originalExportName);
                if (!originalFunction) {
                  throw new Error(
                    `Unable to locate original hook export ${originalExportName}`,
                  );
                }
                let originalResult = originalFunction(...args);
                if (!useHook.enabled)
                  return useHook.returnType ? originalResult : undefined;
                if (originalResult !== undefined)
                  originalResult = new ValueWrapper(originalResult);
                const wrappedArgs = args.map((arg) => new ValueWrapper(arg));
                useHook.callback(originalResult, ...wrappedArgs);
                return originalResult?.val();
              };
            }
            const importModuleName = "env";
            if (!importObject[importModuleName])
              importObject[importModuleName] = {};
            (importObject[importModuleName] as any)[injectName] = injectFunc;
            const injectType = this.internalWasmTypes.findIndex(
              (type: any) =>
                JSON.stringify(type.params) ===
                  JSON.stringify(useHook.params) &&
                type.returnType === useHook.returnType,
            );
            if (injectType < 0) {
              this.logger.warn(
                "Skipping hook %s.%s: unable to resolve wasm signature",
                useHook.typeName,
                useHook.methodName,
              );
              useHook.enabled = false;
              useHook.applied = true;
              ++j;
              continue;
            }
            if (
              this.applyBodyEntryHook(
                wail,
                useHook,
                importObject,
              )
            ) {
              ++j;
              continue;
            }
            if (useHook.runtimeTableFallbackOnly) {
              runtimeTableFallbackHooks.push(useHook);
              ++j;
              continue;
            }
            if (useHook.skipDirectFallback) {
              useHook.enabled = false;
              useHook.applied = true;
              this.diag("hook.direct skipped by hook option", {
                typeName: useHook.typeName,
                methodName: useHook.methodName,
                tableIndex: useHook.tableIndex,
                internalIndex: useHook.index,
              });
              ++j;
              continue;
            }
            const replacementFuncIndex = wail.addImportEntry({
              moduleStr: "env",
              fieldStr: injectName,
              kind: "func",
              type: injectType,
            });
            useHook.callCount = useHook.callCount || 0;
            useHook.lastArgs = useHook.lastArgs || [];
            replacementFuncIndexes.push(replacementFuncIndex);
            const oldFuncIndex = wail.getFunctionIndex(useHook.index);
            oldFuncIndexes.push(oldFuncIndex);
            wail.addExportEntry(oldFuncIndex, {
              fieldStr: originalExportName,
              kind: "func",
            });
            useHook.originalExportName = originalExportName;
            useHook.oldFuncIndex = oldFuncIndex.i32();
            useHook.replacementFuncIndex = replacementFuncIndex.i32();
            patchedHooks.push(useHook);
            hookRewriteCounts.push(0);
            this.diag("hook.direct prepared", {
              typeName: useHook.typeName,
              methodName: useHook.methodName,
              tableIndex: useHook.tableIndex,
              internalIndex: useHook.index,
              oldFuncIndex: oldFuncIndex.i32(),
              replacementFuncIndex: replacementFuncIndex.i32(),
              injectType,
              params: useHook.params,
              returnType: useHook.returnType,
            });
            ++j;
          }
          ++i;
        }
        wail.addInstructionParser(OP_CALL, (instrBytes: any) => {
          const mappedOldFuncIndexes = oldFuncIndexes.map((item) => item.i32());
          const reader = new BufferReader(instrBytes);
          const opcode = reader.readUint8();
          const callTarget = reader.readVarUint32();
          if (mappedOldFuncIndexes.includes(callTarget)) {
            const workingIndex = mappedOldFuncIndexes.indexOf(callTarget);
            const workingHook = patchedHooks[workingIndex];
            if (workingHook) workingHook.applied = true;
            hookRewriteCounts[workingIndex] =
              (hookRewriteCounts[workingIndex] || 0) + 1;
            return new Uint8Array([
              opcode,
              ...VarUint32ToArray(replacementFuncIndexes[workingIndex].i32()),
            ]);
          }
          return instrBytes;
        });
        wail.parse();
        patchedHooks.forEach((hook, index) => {
          this.diag("hook.direct rewrite summary", {
            typeName: hook.typeName,
            methodName: hook.methodName,
            tableIndex: hook.tableIndex,
            internalIndex: hook.index,
            oldFuncIndex: oldFuncIndexes[index]?.i32(),
            replacementFuncIndex: replacementFuncIndexes[index]?.i32(),
            rewriteCount: hookRewriteCounts[index] || 0,
          });
        });
        this.instantiate(wail.write(), importObject).then(
          (instantiatedSource: WebAssembly.WebAssemblyInstantiatedSource) => {
            this.rememberWasmExports(instantiatedSource, importObject);
            const tableName: string =
              this.tableName ||
              this.resolveTableName(
                (instantiatedSource as any).instance.exports,
              );
            const unappliedHooks = this.getUnappliedHooks();
            const fallbackHooks = [
              ...new Set([
                ...runtimeTableFallbackHooks,
                ...unappliedHooks,
              ]),
            ];
            fallbackHooks.forEach((hook) => {
              const methodTableApplied = this.applyIndirectHook(
                instantiatedSource,
                hook,
                tableName,
              );
              const invokerApplied = hook.tryInvokerFallback
                ? this.applyInvokerHook(instantiatedSource, hook, tableName)
                : false;
              if (!methodTableApplied && !invokerApplied) {
                this.logger.warn(
                  "Hook %s.%s was not applied",
                  hook.typeName,
                  hook.methodName,
                );
              }
            });
            this.logger.message("Chainloader startup complete");
            resolve(instantiatedSource);
            this.schedulePluginLoadedCallbacks();
          },
        );
      },
    );
  }

  private schedulePluginLoadedCallbacks() {
    const page = getPageWindow();
    this.diag("schedule onLoaded callbacks", { plugins: this.plugins.length });
    const runCallbacks = () => {
      this.diag("run onLoaded callbacks", { plugins: this.plugins.length });
      for (const plugin of this.plugins) {
        if (plugin.onLoaded) plugin.onLoaded();
      }
      this.schedulePluginReadyCallbacks();
    };
    const timeout =
      typeof page.setTimeout === "function"
        ? page.setTimeout.bind(page)
        : setTimeout;
    timeout(runCallbacks, 0);
  }

  private schedulePluginReadyCallbacks() {
    const page = getPageWindow();
    const timeout =
      typeof page.setTimeout === "function"
        ? page.setTimeout.bind(page)
        : setTimeout;
    this.diag("schedule onReady callbacks", { plugins: this.plugins.length });
    this.waitForUnityRuntimeReady().then(() => {
      timeout(() => {
        this.diag("run onReady callbacks", { plugins: this.plugins.length });
        for (const plugin of this.plugins) {
          if (plugin.onReady) plugin.onReady();
        }
      }, 1000);
    });
  }

  private async waitForUnityRuntimeReady() {
    const page = getPageWindow();
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30000) {
      const instance = this.getPageUnityInstanceCandidate();
      const module = instance?.Module;
      if (module && (module.calledRun || module.asm)) {
        this.diag("unity runtime ready", {
          elapsed: Date.now() - startedAt,
          calledRun: Boolean(module.calledRun),
          hasAsm: Boolean(module.asm),
        });
        return;
      }
      await new Promise((resolve) => page.setTimeout(resolve, 50));
    }
    this.diag("unity runtime ready timeout");
  }

  private getPageUnityInstanceCandidate() {
    const page = getPageWindow();
    const globalGame = typeof page.game !== "undefined" ? page.game : undefined;
    const candidate =
      page.__UnityWebModkitUnityInstance ||
      page.unityInstance ||
      page.gameInstance ||
      page.unityGame ||
      page.game ||
      globalGame;
    return candidate?.instance || candidate;
  }

  private applyBytecodePatches(wail: WailParser, plugin: ModkitPlugin) {
    for (const patch of plugin.bytecodePatches) {
      if (!patch.enabled || patch.applied) continue;
      patch.tableIndex = this.getTableIndex(patch.typeName, patch.methodName);
      if (!this.isValidTableIndex(patch.tableIndex)) {
        this.logger.warn(
          "Skipping bytecode patch %s.%s: unable to resolve table index",
          patch.typeName,
          patch.methodName,
        );
        patch.enabled = false;
        patch.applied = true;
        continue;
      }
      patch.index = this.getInternalIndex(patch.tableIndex);
      if (!this.isValidInternalIndex(patch.index)) {
        this.logger.warn(
          "Skipping bytecode patch %s.%s: unable to resolve internal function index",
          patch.typeName,
          patch.methodName,
        );
        patch.enabled = false;
        patch.applied = true;
        continue;
      }

      const bytecode =
        patch.kind === "nop"
          ? this.createNopMethodBytecode(patch)
          : this.normalizeBytecodePatch(patch.bytecode || []);
      const funcIndex = wail.getFunctionIndex(patch.index);
      wail.editCodeEntry(funcIndex, {
        locals: [],
        code: bytecode,
      });
      patch.applied = true;
      this.logger.info(
        "Patched bytecode for %s.%s at function index %d",
        patch.typeName,
        patch.methodName,
        patch.index,
      );
    }
  }

  private applyImportHooks(importObject: WebAssembly.Imports) {
    const hooks = this.plugins.flatMap((plugin) => plugin.importHooks);
    if (hooks.length === 0) return;

    for (const hook of hooks) {
      if (!hook.enabled) continue;
      const modules = hook.moduleName
        ? [hook.moduleName]
        : Object.keys(importObject || {});
      for (const moduleName of modules) {
        const imports = (importObject as any)[moduleName];
        if (!imports || typeof imports !== "object") continue;
        for (const importName of Object.keys(imports)) {
          if (!this.matchesImportHook(hook, moduleName, importName)) continue;
          const original = imports[importName];
          if (typeof original !== "function") continue;
          if ((original as any).__unityWebModkitImportHook) continue;

          const wrapped = (...args: number[]) => {
            if (!hook.enabled) return original(...args);
            const wrappedArgs = args.map((arg) => new ValueWrapper(arg));
            const result = hook.callback(...wrappedArgs);
            args = wrappedArgs.map((arg) => arg.val());
            if (typeof result === "number") return result;
            if (result === false) return 0;
            return original(...args);
          };
          (wrapped as any).__unityWebModkitImportHook = true;
          imports[importName] = wrapped;
          hook.applied = true;
          this.logger.info("Hooked wasm import %s.%s", moduleName, importName);
        }
      }

      if (!hook.applied) {
        this.logger.warn(
          "Skipping wasm import hook %s.%s: import not found",
          hook.moduleName || "*",
          hook.importName || hook.pattern || "*",
        );
      }
    }
  }

  private matchesImportHook(
    hook: ImportHook,
    moduleName: string,
    importName: string,
  ) {
    if (hook.moduleName && hook.moduleName !== moduleName) return false;
    if (hook.importName && hook.importName === importName) return true;
    if (hook.importNames?.includes(importName)) return true;
    if (hook.pattern && new RegExp(hook.pattern).test(importName)) return true;
    return !hook.importName && !hook.importNames && !hook.pattern;
  }

  private normalizeBytecodePatch(bytecode: number[]) {
    const normalized = Array.from(bytecode);
    if (normalized[normalized.length - 1] !== 0x0b) normalized.push(0x0b);
    return normalized;
  }

  private createNopMethodBytecode(patch: BytecodePatch) {
    const typeInfo =
      patch.index !== undefined
        ? this.getWasmFunctionTypeByGlobalIndex(patch.index)
        : undefined;
    const returnType = patch.returnType || typeInfo?.returnType;
    switch (returnType) {
      case undefined:
        return [0x0b];
      case "i32":
        return [0x41, 0x00, 0x0b];
      case "i64":
        return [0x42, 0x00, 0x0b];
      case "f32":
        return [0x43, 0x00, 0x00, 0x00, 0x00, 0x0b];
      case "f64":
        return [0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b];
      default:
        throw new Error(
          `Unsupported nopMethod return type "${returnType}" for ${patch.typeName}.${patch.methodName}`,
        );
    }
  }

  private applyIndirectHook(
    instantiatedSource: WebAssembly.WebAssemblyInstantiatedSource,
    hook: Hook,
    tableName: string,
  ) {
    if (!this.isValidTableIndex(hook.tableIndex)) {
      this.diag("hook.indirect skipped invalid table index", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        tableIndex: hook.tableIndex,
      });
      return false;
    }
    const exportedTable = (instantiatedSource as any).instance.exports[tableName];
    const table = this.isWasmTable(exportedTable)
      ? exportedTable
      : this.wasmTable || this.getWasmTable();
    const tableSource = table === exportedTable
      ? "exports"
      : table === this.wasmTable
        ? "runtime-cache"
        : "runtime-probe";
    if (
      !table ||
      typeof table.get !== "function" ||
      typeof table.set !== "function"
    ) {
      this.diag("hook.indirect skipped missing table", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        tableName,
        tableSource,
        hasCachedTable: Boolean(this.wasmTable),
        exports: Object.keys((instantiatedSource as any).instance.exports || {}),
      });
      return false;
    }

    const expectedOriginalFunc = hook.originalExportName
      ? this.getWasmExportFunction(hook.originalExportName)
      : undefined;
    const slot = this.resolveHookTableSlot(table, hook, expectedOriginalFunc);
    if (slot === undefined) {
      this.diag("hook.indirect skipped unresolved table slot", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        tableName,
        tableSource,
        tableIndex: hook.tableIndex,
        internalIndex: hook.index,
        oldFuncIndex: hook.oldFuncIndex,
        originalExportName: hook.originalExportName,
        hasOriginalExport: Boolean(expectedOriginalFunc),
        tableLength: table.length,
      });
      return false;
    }
    const originalFunc = table.get(slot);
    if (typeof originalFunc !== "function") {
      this.diag("hook.indirect skipped non-function slot", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        tableName,
        tableSource,
        tableIndex: hook.tableIndex,
        tableSlot: slot,
        tableLength: table.length,
        valueType: typeof originalFunc,
      });
      return false;
    }
    hook.callCount = hook.callCount || 0;
    hook.lastArgs = hook.lastArgs || [];

    const runtimeType = this.isValidInternalIndex(hook.index)
      ? this.getWasmFunctionTypeByGlobalIndex((hook.index as number) + 1)
      : undefined;
    const effectiveParams = Array.isArray(runtimeType?.params)
      ? runtimeType.params
      : hook.params;
    const effectiveReturnType = runtimeType?.returnType || hook.returnType;
    const hookResults = effectiveReturnType ? [effectiveReturnType] : [];
    const jsImpl = !hook.kind
      ? (...args: number[]) => {
          hook.callCount = (hook.callCount || 0) + 1;
          hook.lastArgs = Array.from(args);
          if (!hook.enabled) {
            return effectiveReturnType
              ? originalFunc(...args)
              : originalFunc(...args);
          }
          const wrappedArgs = args.map((arg) => new ValueWrapper(arg));
          const result = hook.callback(...wrappedArgs);
          args = wrappedArgs.map((arg) => arg.val());
          if (result === undefined || result === true) {
            return effectiveReturnType
              ? originalFunc(...args)
              : originalFunc(...args);
          }
          return effectiveReturnType ? 0 : undefined;
        }
      : (...args: number[]) => {
          hook.callCount = (hook.callCount || 0) + 1;
          hook.lastArgs = Array.from(args);
          let originalResult = originalFunc(...args);
          if (!hook.enabled)
            return effectiveReturnType ? originalResult : undefined;
          if (originalResult !== undefined)
            originalResult = new ValueWrapper(originalResult);
          const wrappedArgs = args.map((arg) => new ValueWrapper(arg));
          hook.callback(originalResult, ...wrappedArgs);
          return originalResult?.val();
        };

    try {
      table.set(
        slot,
        this.makeWasmFunc(effectiveParams, hookResults, jsImpl),
      );
    } catch (err) {
      this.diag("hook.indirect table.set failed", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        tableName,
        tableSource,
        tableIndex: hook.tableIndex,
        tableSlot: slot,
        params: effectiveParams,
        results: hookResults,
        runtimeType,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    hook.tableSlot = slot;
    hook.applied = true;
    this.diag("hook.indirect applied", {
      typeName: hook.typeName,
      methodName: hook.methodName,
      tableName,
      tableSource,
      tableIndex: hook.tableIndex,
      tableSlot: slot,
      tableLength: table.length,
      oldFuncIndex: hook.oldFuncIndex,
      originalExportName: hook.originalExportName,
      params: effectiveParams,
      results: hookResults,
      runtimeType,
      matchedOriginalExport: Boolean(expectedOriginalFunc) &&
        originalFunc === expectedOriginalFunc,
    });
    return true;
  }

  private applyInvokerHook(
    instantiatedSource: WebAssembly.WebAssemblyInstantiatedSource,
    hook: Hook,
    tableName: string,
  ) {
    const invokerTableIndex = this.getInvokerTableIndex(
      hook.typeName,
      hook.methodName,
    );
    if (!this.isValidTableIndex(invokerTableIndex)) {
      this.diag("hook.invoker skipped missing invoker", {
        typeName: hook.typeName,
        methodName: hook.methodName,
      });
      return false;
    }
    const invokerInternalIndex = this.getInternalIndex(invokerTableIndex);
    const invokerType = this.getWasmFunctionTypeByGlobalIndex(
      invokerInternalIndex + 1,
    );
    if (
      !invokerType ||
      !invokerType.params?.every((param: string) => param === "i32")
    ) {
      this.diag("hook.invoker skipped unsupported signature", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        invokerTableIndex,
        invokerInternalIndex,
        invokerType,
      });
      return false;
    }

    const originalTableIndex = hook.tableIndex;
    const originalTableSlot = hook.tableSlot;
    const originalParams = hook.params;
    const originalReturnType = hook.returnType;
    hook.tableIndex = invokerTableIndex;
    hook.tableSlot = undefined;
    hook.params = invokerType.params;
    hook.returnType = invokerType.returnType;
    const applied = this.applyIndirectHook(instantiatedSource, hook, tableName);
    if (applied) {
      hook.invokerFallbackApplied = true;
      hook.invokerTableIndex = invokerTableIndex;
      hook.invokerInternalIndex = invokerInternalIndex;
      this.diag("hook.invoker applied", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        invokerTableIndex,
        invokerInternalIndex,
        invokerType,
      });
      return true;
    }
    hook.tableIndex = originalTableIndex;
    hook.tableSlot = originalTableSlot;
    hook.params = originalParams;
    hook.returnType = originalReturnType;
    return false;
  }

  private applyBodyEntryHook(
    wail: WailParser,
    hook: Hook,
    importObject: any,
  ) {
    if (hook.kind !== 0 || hook.returnType) return false;
    if (!hook.params.every((param) => param === "i32")) return false;

    const targets = this.getBodyHookTargets(hook);
    if (targets.length === 0) {
      this.diag("hook.body skipped no target", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        tableIndex: hook.tableIndex,
        internalIndex: hook.index,
        reason: "missing",
      });
      return false;
    }
    const aliases = this.getBodyHookAliases(hook);
    if (aliases.length > 1) {
      hook.sharedBodyAliasCount = aliases.length;
      if (!hook.sharedBodyFallback) {
        hook.enabled = false;
        hook.applied = true;
        this.logger.warn(
          "Hook %s.%s was not applied because it resolves to a shared IL2CPP body (%d aliases). Use probe hooks or pass sharedBodyFallback: true only when shared dispatch is intended.",
          hook.typeName,
          hook.methodName,
          aliases.length,
        );
        this.diag("hook.body skipped shared target", {
          typeName: hook.typeName,
          methodName: hook.methodName,
          tableIndex: hook.tableIndex,
          internalIndex: hook.index,
          aliasCount: aliases.length,
          aliases: aliases.slice(0, 16),
        });
        return true;
      }
      this.diag("hook.body shared target; applying shared fallback", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        tableIndex: hook.tableIndex,
        internalIndex: hook.index,
        aliasCount: aliases.length,
        aliases: aliases.slice(0, 16),
      });
    }
    const existingTargets = targets.filter((target) =>
      this.bodyHookPatchedTargets.has(target.globalIndex)
    );
    const newTargets = targets.filter(
      (target) => !this.bodyHookPatchedTargets.has(target.globalIndex),
    );
    if (existingTargets.length > 0) {
      this.registerBodyHookTargets(
        hook,
        existingTargets.map((target) => target.globalIndex),
      );
    }
    if (newTargets.length === 0) {
      const joinedTargets = existingTargets.map((target) => target.globalIndex);
      hook.callCount = hook.callCount || 0;
      hook.lastArgs = hook.lastArgs || [];
      hook.bodyPatched = true;
      hook.bodyPatchTargets = joinedTargets;
      hook.applied = true;
      this.diag("hook.body joined existing target", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        tableIndex: hook.tableIndex,
        internalIndex: hook.index,
        targets: joinedTargets,
        params: hook.params,
      });
      return true;
    }

    const importModuleName = "env";
    if (!importObject[importModuleName]) importObject[importModuleName] = {};
    const injectName =
      hook.typeName + "xx" + hook.methodName + "Body" + makeId(8);
    const patchedTargets: number[] = [];
    const bodyDispatch = (
      ...args: number[]
    ) => {
      const dispatchHooks = [
        ...new Set(
          patchedTargets.flatMap(
            (target) => this.bodyHookPatchedTargets.get(target) || [],
          ),
        ),
      ] as Hook[];
      const activeHooks = dispatchHooks.length > 0 ? dispatchHooks : [hook];
      for (const target of patchedTargets) {
        if (this.bodyHookDispatchLogged.has(target)) continue;
        this.bodyHookDispatchLogged.add(target);
        this.diag("hook.body dispatch", {
          target,
          hookCount: activeHooks.length,
          hooks: activeHooks
            .slice(0, 24)
            .map((item) => `${item.typeName}.${item.methodName}`),
          args,
        });
      }
      const wrappedArgs = args.map((arg) => new ValueWrapper(arg));
      for (const activeHook of activeHooks) {
        activeHook.callCount = (activeHook.callCount || 0) + 1;
        activeHook.lastArgs = Array.from(args);
        if (!activeHook.enabled) continue;
        activeHook.callback(...wrappedArgs);
      }
    };

    for (const target of newTargets) {
      const targetInjectName = injectName + "_" + target.globalIndex;
      (importObject[importModuleName] as any)[targetInjectName] = bodyDispatch;
      const bodyPrefixFuncIndex = wail.addImportEntry({
        moduleStr: importModuleName,
        fieldStr: targetInjectName,
        kind: "func",
        type: target.funcType,
      });
      const cloneFuncIndex = wail.addFunctionEntry({
        type: target.funcType,
      });
      wail.addCodeEntry(cloneFuncIndex, {
        locals: target.locals,
        code: this.cloneFunctionInstructions(wail, target.instructions),
      });

      const targetFuncIndex = wail.getFunctionIndex(target.globalIndex);
      const code: any[] = [
        ...this.makeLocalGetInstructions(target.params.length),
        OP_CALL,
        bodyPrefixFuncIndex.varUint32(),
        ...this.makeLocalGetInstructions(target.params.length),
        OP_CALL,
        cloneFuncIndex.varUint32(),
        0x0b,
      ];
      wail.editCodeEntry(targetFuncIndex, {
        locals: [],
        code,
      });
      this.registerBodyHookTargets(hook, [target.globalIndex]);
      patchedTargets.push(target.globalIndex);
    }

    const allPatchedTargets = [
      ...existingTargets.map((target) => target.globalIndex),
      ...patchedTargets,
    ];
    hook.callCount = hook.callCount || 0;
    hook.lastArgs = hook.lastArgs || [];
    hook.bodyPatched = true;
    hook.bodyPatchTargets = allPatchedTargets;
    hook.applied = true;
    this.diag("hook.body applied", {
      typeName: hook.typeName,
      methodName: hook.methodName,
      tableIndex: hook.tableIndex,
      internalIndex: hook.index,
      targets: allPatchedTargets,
      params: hook.params,
      targetTypes: allPatchedTargets.map((target) => {
        const match = targets.find((item) => item.globalIndex === target);
        return match
          ? {
              target,
              params: match.params,
              returnType: match.returnType,
              signatureMode: match.signatureMode,
            }
          : { target };
      }),
    });
    return true;
  }

  private registerBodyHookTargets(hook: Hook, targets: number[]) {
    for (const target of targets) {
      const hooks = this.bodyHookPatchedTargets.get(target) || [];
      if (!hooks.includes(hook)) hooks.push(hook);
      this.bodyHookPatchedTargets.set(target, hooks);
      this.diag("hook.body registered", {
        target,
        hookCount: hooks.length,
        hooks: hooks
          .slice(0, 24)
          .map((item) => `${item.typeName}.${item.methodName}`),
      });
    }
  }

  private getBodyHookTargets(hook: Hook) {
    const candidates = [
      hook.index,
      hook.index === undefined ? undefined : hook.index + 1,
    ]
      .filter((index): index is number => this.isValidInternalIndex(index))
      .filter((index, offset, indexes) => indexes.indexOf(index) === offset);
    const targets: BodyHookTarget[] = candidates
      .map((globalIndex): BodyHookTarget | undefined => {
        const functionSectionIndex =
          globalIndex - this.wasmImportFunctionCount;
        if (functionSectionIndex < 0) return undefined;
        const code = this.internalWasmCode?.[functionSectionIndex];
        const functionInfo = this.internalWasmFunctions?.[functionSectionIndex];
        const type = this.internalWasmTypes?.[functionInfo?.funcType];
        if (!code || !functionInfo || !type) return undefined;
        const params = Array.from(type.params || []).map((param) =>
          String(param),
        );
        const returnType = type.returnType || undefined;
        if (!params.every((param) => param === "i32")) return undefined;
        return {
          globalIndex,
          funcType: functionInfo.funcType,
          locals: code.locals || [],
          instructions: code.instructions || [],
          params,
          returnType,
          signatureMode:
            JSON.stringify(params) === JSON.stringify(hook.params) &&
            returnType === (hook.returnType || undefined)
              ? "exact"
              : "physical",
        };
      })
      .filter((target): target is BodyHookTarget => Boolean(target));
    const exactTargets = targets.filter(
      (target) => target.signatureMode === "exact",
    );
    if (exactTargets.length > 0) return exactTargets;
    return targets.filter((target) => !target.returnType);
  }

  private getBodyHookAliases(hook: Hook) {
    if (!this.isValidInternalIndex(hook.index)) return [];
    if (!this.bodyHookAliasCache) {
      const aliases = new Map<number, string[]>();
      for (const method of this.listMethods()) {
        const tableIndex = this.getTableIndex(method.typeName, method.name);
        if (!this.isValidTableIndex(tableIndex)) continue;
        const internalIndex = this.getInternalIndex(tableIndex);
        const methods = aliases.get(internalIndex) || [];
        methods.push(`${method.typeName}.${method.name}`);
        aliases.set(internalIndex, methods);
      }
      this.bodyHookAliasCache = aliases;
    }
    return this.bodyHookAliasCache.get(hook.index) || [];
  }

  private makeLocalGetInstructions(count: number) {
    const code: any[] = [];
    for (let i = 0; i < count; i++) {
      code.push(0x20, VarUint32ToArray(i));
    }
    return code;
  }

  private cloneFunctionInstructions(
    wail: WailParser,
    instructions: Uint8Array[],
  ) {
    const code: any[] = [];
    for (const instruction of instructions) {
      if (instruction[0] !== OP_CALL) {
        code.push(...Array.from(instruction));
        continue;
      }
      const target = this.readUlebFromInstruction(instruction);
      code.push(OP_CALL, wail.getFunctionIndex(target).varUint32());
    }
    return code;
  }

  private resolveHookTableSlot(
    table: WebAssembly.Table,
    hook: Hook,
    expectedOriginalFunc?: Function,
  ) {
    if (!this.isValidTableIndex(hook.tableIndex)) return undefined;
    const candidates = [
      hook.tableIndex - 1,
      hook.tableIndex,
      hook.tableSlot,
    ].filter((slot): slot is number => typeof slot === "number").filter(
      (slot, index, slots) =>
        Number.isInteger(slot) &&
        slot >= 0 &&
        slot < table.length &&
        slots.indexOf(slot) === index,
    );
    for (const slot of candidates) {
      let value: any;
      try {
        value = table.get(slot);
      } catch (err) {
        this.diag("hook.indirect table.get failed", {
          typeName: hook.typeName,
          methodName: hook.methodName,
          tableIndex: hook.tableIndex,
          tableSlot: slot,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      this.diag("hook.indirect table candidate", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        tableIndex: hook.tableIndex,
        tableSlot: slot,
        tableLength: table.length,
        valueType: typeof value,
        matchesOriginalExport: Boolean(expectedOriginalFunc) &&
          value === expectedOriginalFunc,
      });
      const slotInternalIndex = this.getInternalIndexForTableSlot(slot);
      if (
        hook.index !== undefined &&
        slotInternalIndex !== undefined &&
        slotInternalIndex === hook.index
      ) {
        this.diag("hook.indirect matched internal index candidate", {
          typeName: hook.typeName,
          methodName: hook.methodName,
          tableIndex: hook.tableIndex,
          tableSlot: slot,
          internalIndex: hook.index,
        });
        return slot;
      }
      if (expectedOriginalFunc && value === expectedOriginalFunc) {
        this.diag("hook.indirect matched original export candidate", {
          typeName: hook.typeName,
          methodName: hook.methodName,
          tableIndex: hook.tableIndex,
          tableSlot: slot,
          oldFuncIndex: hook.oldFuncIndex,
          originalExportName: hook.originalExportName,
        });
        return slot;
      }
      if (!expectedOriginalFunc && typeof value === "function") return slot;
    }

    if (expectedOriginalFunc) {
      for (let slot = 0; slot < table.length; ++slot) {
        let value: any;
        try {
          value = table.get(slot);
        } catch {
          continue;
        }
        if (value !== expectedOriginalFunc) continue;
        this.diag("hook.indirect matched original export scan", {
          typeName: hook.typeName,
          methodName: hook.methodName,
          tableIndex: hook.tableIndex,
          tableSlot: slot,
          tableLength: table.length,
          oldFuncIndex: hook.oldFuncIndex,
          originalExportName: hook.originalExportName,
        });
        return slot;
      }
      this.diag("hook.indirect original export not found in table", {
        typeName: hook.typeName,
        methodName: hook.methodName,
        tableIndex: hook.tableIndex,
        internalIndex: hook.index,
        oldFuncIndex: hook.oldFuncIndex,
        originalExportName: hook.originalExportName,
        tableLength: table.length,
      });
    }
    return undefined;
  }

  private makeWasmFunc(
    params: string[],
    results: string[],
    jsImpl: (...args: number[]) => number | undefined,
  ) {
    const wasmType = (type: string) => {
      switch (type) {
        case "i32":
          return 0x7f;
        case "i64":
          return 0x7e;
        case "f32":
          return 0x7d;
        case "f64":
          return 0x7c;
        default:
          throw new Error(`Unsupported wasm function type ${type}`);
      }
    };

    const paramTypes = params.map(wasmType);
    const resultTypes = results.map(wasmType);
    const typeVec = [
      0x60,
      paramTypes.length,
      ...paramTypes,
      resultTypes.length,
      ...resultTypes,
    ];
    const typeSection = [0x01, typeVec.length + 1, 0x01, ...typeVec];
    const importEntry = [0x01, 0x65, 0x01, 0x66, 0x00, 0x00];
    const importSection = [0x02, importEntry.length + 1, 0x01, ...importEntry];
    const exportEntry = [0x01, 0x67, 0x00, 0x00];
    const exportSection = [0x07, exportEntry.length + 1, 0x01, ...exportEntry];
    const bytes = new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      ...typeSection,
      ...importSection,
      ...exportSection,
    ]);
    const page = getPageWindow();
    const mod = new page.WebAssembly.Module(bytes);
    const inst = new page.WebAssembly.Instance(mod, { e: { f: jsImpl } });
    return inst.exports.g;
  }

  private searchWasmBinary(bufferSource: ArrayBuffer) {
    if (!this.globalMetadata) return;
    const il2CppContext = createIl2CppContext(
      bufferSource,
      this.globalMetadata,
      this.allReferencedAssemblies,
    );
    if (il2CppContext.isErr()) {
      this.logger.error(il2CppContext.error.print());
      return;
    }
    this.il2CppContext = il2CppContext.value;
    this.saveIl2CppContext();
  }

  private resetWasmStructureCache() {
    this.internalMappings = undefined;
    this.internalWasmTypes = undefined;
    this.internalWasmFunctions = undefined;
    this.internalWasmCode = undefined;

    const pageRuntime = getPageWindow()?.UnityWebModkit?.Runtime;
    if (pageRuntime) {
      pageRuntime.internalMappings = undefined;
      pageRuntime.internalWasmTypes = undefined;
      pageRuntime.internalWasmFunctions = undefined;
      pageRuntime.internalWasmCode = undefined;
    }
  }

  private syncWasmStructureFromRuntime() {
    const pageRuntime = getPageWindow()?.UnityWebModkit?.Runtime;
    if (pageRuntime && pageRuntime !== this) {
      this.internalMappings = pageRuntime.internalMappings;
      this.internalWasmTypes = pageRuntime.internalWasmTypes;
      this.internalWasmFunctions = pageRuntime.internalWasmFunctions;
      this.internalWasmCode = pageRuntime.internalWasmCode;
    }
    this.diag("wasm structure cache", {
      mappings: this.internalMappings?.[0]?.elements?.length || 0,
      types: this.internalWasmTypes?.length || 0,
      functions: this.internalWasmFunctions?.length || 0,
      code: this.internalWasmCode?.length || 0,
      imports: this.wasmImportFunctionCount,
    });
  }

  private hasWasmStructure() {
    return Boolean(
      this.internalMappings?.[0]?.elements?.length &&
        this.internalWasmTypes?.length &&
        this.internalWasmFunctions?.length &&
        this.internalWasmCode?.length,
    );
  }

  private makeWasmCacheKey(bufferSource: ArrayBuffer) {
    const bytes = new Uint8Array(bufferSource);
    let hash = 2166136261;
    const mix = (value: number) => {
      hash ^= value;
      hash = Math.imul(hash, 16777619) >>> 0;
    };
    mix(bytes.length & 0xff);
    mix((bytes.length >>> 8) & 0xff);
    mix((bytes.length >>> 16) & 0xff);
    mix((bytes.length >>> 24) & 0xff);
    const sampleWindow = Math.min(4096, bytes.length);
    for (let i = 0; i < sampleWindow; i++) mix(bytes[i]);
    const tailStart = Math.max(sampleWindow, bytes.length - sampleWindow);
    for (let i = tailStart; i < bytes.length; i++) mix(bytes[i]);
    return `${this.globalMetadata?.integrityHash || "no-metadata"}:${
      bytes.length
    }:${hash.toString(16)}`;
  }

  private resolveIl2CppFunctions(importObject: WebAssembly.Imports) {
    this.resolvedIl2CppFunctions = {};

    const il2CppStringNew = this.findIl2CppStringNewLen();
    if (il2CppStringNew) {
      this.resolvedIl2CppFunctions["il2cpp_string_new"] = il2CppStringNew;
      this.stringNewEncoding = "utf8";
      this.logger.info(
        "Resolved il2cpp_string_new_len statically at function index %d",
        il2CppStringNew,
      );
    } else {
      const il2CppStringNewUtf16 = this.findIl2CppStringNewUtf16Len();
      if (il2CppStringNewUtf16) {
        this.resolvedIl2CppFunctions["il2cpp_string_new"] =
          il2CppStringNewUtf16;
        this.stringNewEncoding = "utf16";
        this.logger.info(
          "Resolved il2cpp_string_new_utf16_len statically at function index %d",
          il2CppStringNewUtf16,
        );
      } else {
        this.candidateIl2CppFunctions["il2cpp_string_new"] =
          this.findIl2CppStringNewCandidates()
            .slice(0, 32)
            .map((func: any) =>
              this.toGlobalFunctionIndex(func.preservedIndex),
            );
        this.logger.warn(
          "Unable to statically resolve il2cpp_string_new_len; exporting %d runtime candidate(s)",
          this.candidateIl2CppFunctions["il2cpp_string_new"].length,
        );
      }
    }

    const il2CppObjectNew = this.findIl2CppObjectNew();
    if (il2CppObjectNew) {
      this.resolvedIl2CppFunctions["il2cpp_object_new"] = il2CppObjectNew;
      this.logger.info(
        "Resolved il2cpp_object_new statically at function index %d",
        il2CppObjectNew,
      );
    } else {
      this.candidateIl2CppFunctions["il2cpp_object_new"] =
        this.findIl2CppObjectNewCandidates()
          .slice(0, 32)
          .map((func: any) => this.toGlobalFunctionIndex(func.preservedIndex));
      this.logger.warn(
        "Unable to statically resolve il2cpp_object_new; exporting %d runtime candidate(s)",
        this.candidateIl2CppFunctions["il2cpp_object_new"].length,
      );
    }
  }

  private findWasmFunction(opts: {
    name: string;
    params: string[];
    returnType?: string;
    startsWith?: number[][];
    containsAll?: number[][];
    rejectStartsWith?: number[][];
  }) {
    const candidates = this.findWasmFunctionCandidates(opts);
    if (candidates.length > 1) {
      this.logger.warn(
        "Multiple candidates found for %s, using the smallest body",
        opts.name,
      );
    }
    return candidates[0];
  }

  private findIl2CppStringNewLen() {
    const strlen = this.findWasmFunction({
      name: "strlen",
      params: ["i32"],
      returnType: "i32",
      containsAll: [
        [65, 129, 130, 132, 8],
        [65, 128, 129, 130, 132, 120],
      ],
    });
    if (!strlen) return undefined;

    const strlenIndex = this.toGlobalFunctionIndex(strlen.preservedIndex);
    const wrappers = this.findWasmFunctionCandidates({
      params: ["i32"],
      returnType: "i32",
      maxBodyLength: 64,
      containsAll: [[32, 0], [16]],
    });

    for (const wrapper of wrappers) {
      const calls = this.getDirectCallTargets(wrapper);
      const strlenCallIndex = calls.indexOf(strlenIndex);
      if (strlenCallIndex < 0) continue;

      for (const target of calls.slice(strlenCallIndex + 1)) {
        const typeInfo = this.getWasmFunctionTypeByGlobalIndex(target);
        if (
          typeInfo &&
          JSON.stringify(typeInfo.params) === JSON.stringify(["i32", "i32"]) &&
          typeInfo.returnType === "i32"
        ) {
          return target;
        }
      }
    }

    return undefined;
  }

  private findIl2CppStringNewUtf16Len() {
    const candidates = this.findWasmFunctionCandidates({
      params: ["i32", "i32"],
      returnType: "i32",
      maxBodyLength: 128,
      containsAll: [
        // Allocate string object from UTF-16 code-unit length.
        [32, 1, 16],
        // Copy source buffer into string payload at object + 12, length * 2.
        [34, 2, 65, 12, 106, 32, 0, 32, 1, 65, 1, 116, 16],
        // Drop memcpy result and return the allocated string object.
        [26, 32, 2, 11],
      ],
    });

    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        this.logger.warn(
          "Multiple il2cpp_string_new_utf16_len static candidates found: %o",
          candidates.map((func: any) =>
            this.toGlobalFunctionIndex(func.preservedIndex),
          ),
        );
      }
      return undefined;
    }

    return this.toGlobalFunctionIndex(candidates[0].preservedIndex);
  }

  private findIl2CppStringNewCandidates() {
    const oldStyleCandidates = this.findWasmFunctionCandidates({
      params: ["i32", "i32"],
      returnType: "i32",
      startsWith: [[35, 0, 65]],
      maxBodyLength: 2048,
      containsAll: [[32, 0], [32, 1], [16]],
    });
    const utf16Candidates = this.findWasmFunctionCandidates({
      params: ["i32", "i32"],
      returnType: "i32",
      maxBodyLength: 256,
      containsAll: [
        [32, 1, 16],
        [34, 2, 65, 12, 106, 32, 0, 32, 1, 65, 1, 116, 16],
        [26, 32, 2, 11],
      ],
    });
    const seen = new Set<number>();
    return [...oldStyleCandidates, ...utf16Candidates].filter((func: any) => {
      const index = this.toGlobalFunctionIndex(func.preservedIndex);
      if (seen.has(index)) return false;
      seen.add(index);
      return true;
    });
  }

  private findIl2CppObjectNew() {
    const candidates = this.findIl2CppObjectNewCandidates();

    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        this.logger.warn(
          "Multiple il2cpp_object_new static candidates found: %o",
          candidates.map((func: any) =>
            this.toGlobalFunctionIndex(func.preservedIndex),
          ),
        );
      }
      return undefined;
    }

    return this.toGlobalFunctionIndex(candidates[0].preservedIndex);
  }

  private findIl2CppObjectNewCandidates() {
    const legacyCandidates = this.findWasmFunctionCandidates({
      params: ["i32"],
      returnType: "i32",
      maxBodyLength: 512,
      containsAll: [
        // Il2CppClass::flags / allocation fast-path test.
        [32, 0, 45, 0, 189, 1, 65, 32, 113],
        // Load klass->instance_size, then call the allocator.
        [32, 0, 40, 2, 128, 1, 16],
        // Store klass into the new object's first word.
        [32, 1, 32, 0, 54, 2, 0],
        // Store null monitor/sync data into the second word.
        [65, 0, 54, 2, 4],
      ],
    });
    const unity2019Candidates = this.findWasmFunctionCandidates({
      params: ["i32"],
      returnType: "i32",
      maxBodyLength: 512,
      containsAll: [
        // Unity 2019 often computes klass + 0x80, then loads instance_size.
        [32, 0, 65, 128, 1, 106],
        [40, 2, 0, 16],
        // Store klass into the new object's first word. The allocator result is
        // kept by tee_local before the klass store in this codegen shape.
        [34, 1, 32, 0, 54, 2, 0],
        // Store null monitor/sync data into the second word.
        [32, 1, 65, 0, 54, 2, 4],
      ],
    });
    const seen = new Set<number>();
    return [...legacyCandidates, ...unity2019Candidates].filter((func: any) => {
      const index = this.toGlobalFunctionIndex(func.preservedIndex);
      if (seen.has(index)) return false;
      seen.add(index);
      return true;
    });
  }

  private getDirectCallTargets(func: any) {
    return (func.instructions || [])
      .filter((instruction: Uint8Array) => instruction[0] === OP_CALL)
      .map((instruction: Uint8Array) =>
        this.readUlebFromInstruction(instruction),
      );
  }

  private readUlebFromInstruction(instruction: Uint8Array) {
    let result = 0;
    let shift = 0;
    for (let i = 1; i < instruction.length; i++) {
      const byte = instruction[i];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }

  private toGlobalFunctionIndex(functionSectionIndex: number) {
    return functionSectionIndex + this.wasmImportFunctionCount;
  }

  private findWasmFunctionCandidates(opts: {
    params: string[];
    returnType?: string;
    startsWith?: number[][];
    containsAll?: number[][];
    rejectStartsWith?: number[][];
    maxBodyLength?: number;
  }) {
    return (this.internalWasmCode || [])
      .filter((func: any) => {
        const typeInfo = this.getWasmFunctionType(func);
        if (!typeInfo) return false;
        if (JSON.stringify(typeInfo.params) !== JSON.stringify(opts.params))
          return false;
        if (
          (typeInfo.returnType || undefined) !== (opts.returnType || undefined)
        )
          return false;
        const bytes = concatenateUint8Arrays(func.instructions || []);
        if (opts.maxBodyLength && bytes.length > opts.maxBodyLength)
          return false;
        if (
          opts.rejectStartsWith?.some((pattern) =>
            uint8ArrayStartsWith(bytes, pattern),
          )
        ) {
          return false;
        }
        if (
          opts.startsWith &&
          !opts.startsWith.some((pattern) =>
            uint8ArrayStartsWith(bytes, pattern),
          )
        ) {
          return false;
        }
        if (
          opts.containsAll &&
          !opts.containsAll.every(
            (pattern) =>
              patternSearch(bytes, new Uint8Array(pattern)).length > 0,
          )
        ) {
          return false;
        }
        return Boolean(opts.startsWith || opts.containsAll);
      })
      .sort(
        (a: any, b: any) =>
          concatenateUint8Arrays(a.instructions || []).length -
          concatenateUint8Arrays(b.instructions || []).length,
      );
  }

  private getWasmFunctionType(func: any) {
    const functionInfo = this.internalWasmFunctions?.[func.preservedIndex];
    if (!functionInfo) return undefined;
    return this.internalWasmTypes?.[functionInfo.funcType];
  }

  private getWasmFunctionTypeByGlobalIndex(globalIndex: number) {
    const functionSectionIndex = globalIndex - this.wasmImportFunctionCount;
    if (functionSectionIndex < 0) return undefined;
    const functionInfo = this.internalWasmFunctions?.[functionSectionIndex];
    if (!functionInfo) return undefined;
    return this.internalWasmTypes?.[functionInfo.funcType];
  }

  private exportIl2CppFunctions(wail: WailParser) {
    for (const key in this.resolvedIl2CppFunctions) {
      const value = wail.getFunctionIndex(this.resolvedIl2CppFunctions[key]);
      wail.addExportEntry(value, {
        fieldStr: key,
        kind: "func",
      });
    }
    for (const [key, candidates] of Object.entries(
      this.candidateIl2CppFunctions,
    )) {
      candidates.forEach((candidate, index) => {
        const value = wail.getFunctionIndex(candidate);
        wail.addExportEntry(value, {
          fieldStr: `__uwm_candidate_${key}_${index}`,
          kind: "func",
        });
      });
    }
  }

  private patchWasmExports(
    buffer: Uint8Array,
    exports: Record<string, number>,
  ) {
    const entries = Object.entries(exports);
    if (entries.length === 0) return buffer;

    const chunks: Uint8Array[] = [buffer.slice(0, 8)];
    let offset = 8;
    let patchedExportSection = false;
    let insertedExportSection = false;

    const makeExportSection = (existingEntries: WasmExportEntry[] = []) => {
      const namesToReplace = new Set(entries.map(([name]) => name));
      const payloadChunks: Uint8Array[] = [];
      const nextEntries = existingEntries
        .filter((entry) => !namesToReplace.has(entry.name))
        .concat(
          entries.map(([name, index]) => ({
            name,
            kind: 0,
            index,
          })),
        );
      payloadChunks.push(new Uint8Array(VarUint32ToArray(nextEntries.length)));
      for (const entry of nextEntries) {
        const nameBytes = new TextEncoder().encode(entry.name);
        payloadChunks.push(new Uint8Array(VarUint32ToArray(nameBytes.length)));
        payloadChunks.push(nameBytes);
        payloadChunks.push(new Uint8Array([entry.kind]));
        payloadChunks.push(new Uint8Array(VarUint32ToArray(entry.index)));
      }
      const payload = concatenateUint8Arrays(payloadChunks);
      return concatenateUint8Arrays([
        new Uint8Array([7]),
        new Uint8Array(VarUint32ToArray(payload.length)),
        payload,
      ]);
    };

    while (offset < buffer.length) {
      const sectionStart = offset;
      const id = buffer[offset++];
      const payloadLength = this.readWasmVarUint32(buffer, offset);
      offset = payloadLength.offset;
      const payloadStart = offset;
      const payloadEnd = payloadStart + payloadLength.value;
      if (payloadEnd > buffer.length) {
        throw new Error("Invalid wasm section length while patching exports");
      }

      if (
        !patchedExportSection &&
        !insertedExportSection &&
        id > WASM_SECTION_EXPORT &&
        id !== WASM_SECTION_TAG
      ) {
        chunks.push(makeExportSection());
        insertedExportSection = true;
      }

      if (id === WASM_SECTION_EXPORT) {
        chunks.push(
          makeExportSection(this.readWasmExportEntries(buffer, payloadStart)),
        );
        patchedExportSection = true;
      } else {
        chunks.push(buffer.slice(sectionStart, payloadEnd));
      }
      offset = payloadEnd;
    }

    if (!patchedExportSection && !insertedExportSection) {
      chunks.push(makeExportSection());
    }

    return concatenateUint8Arrays(chunks);
  }

  private readWasmExportEntries(buffer: Uint8Array, offset: number) {
    const entries: WasmExportEntry[] = [];
    const count = this.readWasmVarUint32(buffer, offset);
    offset = count.offset;
    for (let i = 0; i < count.value; i++) {
      const nameLength = this.readWasmVarUint32(buffer, offset);
      offset = nameLength.offset;
      const nameEnd = offset + nameLength.value;
      const name = new TextDecoder().decode(buffer.slice(offset, nameEnd));
      offset = nameEnd;
      const kind = buffer[offset++];
      const index = this.readWasmVarUint32(buffer, offset);
      offset = index.offset;
      entries.push({ name, kind, index: index.value });
    }
    return entries;
  }

  private readWasmVarUint32(buffer: Uint8Array, offset: number) {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      if (offset >= buffer.length) {
        throw new Error("Unexpected EOF while reading wasm varuint32");
      }
      const byte = buffer[offset++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
      shift += 7;
    }
    throw new Error("Invalid wasm varuint32");
  }

  public resolveTableName(asm: any) {
    return (
      Object.keys(asm).find((key) => this.isWasmTable(asm[key])) ||
      "Unknown"
    );
  }

  public getWasmTable(module?: any): WebAssembly.Table | undefined {
    const page = getPageWindow();
    const asmCandidates = [
      module?.asm,
      this.wasmExports,
      page?.Module?.asm,
    ].filter(Boolean);

    if (this.wasmTable) return this.wasmTable;

    for (const asm of asmCandidates) {
      const preferred = this.tableName ? asm[this.tableName] : undefined;
      if (this.isWasmTable(preferred)) return preferred;

      const tableName = Object.keys(asm).find(
        (key) => this.isWasmTable(asm[key]),
      );
      if (!tableName) continue;
      const table = asm[tableName];
      if (this.isWasmTable(table)) {
        this.tableName = tableName;
        this.wasmTable = table;
        return table;
      }
    }

    return undefined;
  }

  private isWasmTable(value: any): value is WebAssembly.Table {
    return (
      value &&
      typeof value.get === "function" &&
      typeof value.set === "function" &&
      typeof value.grow === "function" &&
      typeof value.length === "number"
    );
  }

  private findWasmTable(value: any, depth = 0): WebAssembly.Table | undefined {
    if (!value || depth > 2) return undefined;
    if (this.isWasmTable(value)) return value;
    if (typeof value !== "object" && typeof value !== "function") {
      return undefined;
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (this.isWasmTable(child)) {
        this.tableName = key;
        return child;
      }
      const nested = this.findWasmTable(child, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }

  public getUnityInstance(): any {
    // @ts-ignore Support common Unity WebGL loader globals.
    const page = getPageWindow();
    const candidate = this.getPageUnityInstanceCandidate();
    if (!candidate && this.wasmModule) return { Module: this.wasmModule };
    if (!candidate) throw new Error("Unable to locate Unity WebGL instance");
    return this.withWasmModuleFallback(candidate);
  }

  private withWasmModuleFallback(candidate: any) {
    const fallback = this.wasmModule;
    const module = candidate?.Module;
    if (!fallback || !module) return candidate;
    if (module.HEAPU8 && module.asm) return candidate;

    const normalizedModule = Object.create(module);
    Object.defineProperty(normalizedModule, "HEAPU8", {
      configurable: true,
      enumerable: true,
      get() {
        return module.HEAPU8 || fallback.HEAPU8;
      },
    });
    Object.defineProperty(normalizedModule, "asm", {
      configurable: true,
      enumerable: true,
      get() {
        return module.asm || fallback.asm;
      },
    });

    return {
      ...candidate,
      Module: normalizedModule,
    };
  }

  private rememberWasmExports(
    source: WebAssembly.WebAssemblyInstantiatedSource,
    importObject?: WebAssembly.Imports,
  ) {
    this.wasmExports = (source as any)?.instance?.exports;
    this.wasmTable =
      this.findWasmTable(this.wasmExports) ||
      this.findWasmTable(importObject) ||
      this.wasmTable;
    this.diag("wasm exports remembered", {
      exportKeys: Object.keys(this.wasmExports || {}).length,
      hasTable: Boolean(this.wasmTable),
      tableLength: this.wasmTable?.length || 0,
      tableName: this.tableName,
      hasExportedMemory: this.findWasmMemory(this.wasmExports) !== undefined,
      hasImportedMemory: Boolean((importObject as any)?.env?.memory),
    });
    this.wasmMemory =
      this.wasmMemory ||
      ((importObject as any)?.env?.memory as WebAssembly.Memory | undefined) ||
      this.findWasmMemory(this.wasmExports);
    this.wasmModule = this.createWasmModuleFallback();
    this.publishUnityInstanceFallback();
  }

  private findWasmMemory(source: any): WebAssembly.Memory | undefined {
    if (!source || typeof source !== "object") return undefined;
    for (const value of Object.values(source)) {
      if (value instanceof getPageWindow().WebAssembly.Memory) {
        return value as WebAssembly.Memory;
      }
    }
    return undefined;
  }

  private publishUnityInstanceFallback() {
    const page = getPageWindow();
    const candidate = this.getPageUnityInstanceCandidate();
    const instance = candidate
      ? this.withWasmModuleFallback(candidate)
      : { Module: this.wasmModule };
    page.__UnityWebModkitUnityInstance = instance;
    this.diag("unity instance fallback published", {
      hasCandidate: Boolean(candidate),
      hasModule: Boolean(instance?.Module),
      hasHeap: Boolean(instance?.Module?.HEAPU8),
      hasAsm: Boolean(instance?.Module?.asm),
    });
  }

  private createWasmModuleFallback() {
    const runtime = this;
    return {
      get HEAPU8() {
        const pageModule = (getPageWindow() as any)?.Module;
        if (pageModule?.HEAPU8) return pageModule.HEAPU8;
        if (runtime.wasmMemory)
          return new Uint8Array(runtime.wasmMemory.buffer);
        return undefined;
      },
      get asm() {
        return runtime.wasmExports;
      },
    };
  }

  private getWasmExportFunction(name: string) {
    const _game = this.getUnityInstance();
    const candidates = [
      _game?.Module?.asm?.[name],
      this.wasmExports?.[name],
      (getPageWindow() as any)?.Module?.asm?.[name],
    ];
    return candidates.find((candidate) => typeof candidate === "function");
  }

  public createObject(typeInfo: number | ValueWrapper): number {
    const _game = this.getUnityInstance();
    let objectNew = this.getWasmExportFunction("il2cpp_object_new");
    if (!objectNew) {
      const resolved = this.resolveObjectNewAtRuntime(
        typeInfo instanceof ValueWrapper ? typeInfo.val() : typeInfo,
      );
      if (resolved) {
        _game.Module.asm.il2cpp_object_new = resolved;
        objectNew = resolved;
      }
    }
    if (!objectNew) {
      throw new Error("il2cpp_object_new was not resolved for this build");
    }
    return objectNew(
      typeInfo instanceof ValueWrapper ? typeInfo.val() : typeInfo,
    );
  }

  public createMstr(char: string): number {
    const _game = this.getUnityInstance();
    let stringNew = this.getWasmExportFunction("il2cpp_string_new");
    if (!stringNew) {
      const resolved = this.resolveStringNewAtRuntime(char);
      if (resolved) {
        _game.Module.asm.il2cpp_string_new = resolved;
        stringNew = resolved;
      }
    }
    if (!stringNew) {
      throw new Error("il2cpp_string_new was not resolved for this build");
    }
    const encoded = this.encodeStringForIl2Cpp(char, this.stringNewEncoding);
    const terminatorLength = this.stringNewEncoding === "utf16" ? 2 : 1;
    const charAlloc = this.malloc(encoded.length + terminatorLength);
    writeUint8ArrayAtOffset(_game.Module.HEAPU8, encoded, charAlloc);
    _game.Module.HEAPU8[charAlloc + encoded.length] = 0;
    if (terminatorLength === 2) {
      _game.Module.HEAPU8[charAlloc + encoded.length + 1] = 0;
    }
    const result = stringNew(
      charAlloc,
      this.getIl2CppStringLength(char, encoded, this.stringNewEncoding),
    );
    this.free(charAlloc);
    return result;
  }

  private resolveStringNewAtRuntime(sample: string) {
    const _game = this.getUnityInstance();
    const candidates = this.getExportedCandidates("il2cpp_string_new");
    this.logger.debug(
      "Trying %d runtime candidate(s) for il2cpp_string_new",
      candidates.length,
    );
    for (const candidate of candidates) {
      for (const encoding of ["utf8", "utf16"] as const) {
        const encoded = this.encodeStringForIl2Cpp(sample, encoding);
        const terminatorLength = encoding === "utf16" ? 2 : 1;
        const charAlloc = this.malloc(encoded.length + terminatorLength);
        try {
          writeUint8ArrayAtOffset(_game.Module.HEAPU8, encoded, charAlloc);
          _game.Module.HEAPU8[charAlloc + encoded.length] = 0;
          if (terminatorLength === 2) {
            _game.Module.HEAPU8[charAlloc + encoded.length + 1] = 0;
          }
          const result = candidate(
            charAlloc,
            this.getIl2CppStringLength(sample, encoded, encoding),
          );
          if (result > 0 && new ValueWrapper(result).mstr() === sample) {
            this.stringNewEncoding = encoding;
            this.logger.info(
              "Resolved il2cpp_string_new at runtime using %s input",
              encoding,
            );
            return candidate;
          }
        } catch {
          // Try next candidate or encoding.
        } finally {
          this.free(charAlloc);
        }
      }
    }
    return undefined;
  }

  private encodeStringForIl2Cpp(value: string, encoding: "utf8" | "utf16") {
    if (encoding === "utf8") return new TextEncoder().encode(value);
    const encoded = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) {
      const codeUnit = value.charCodeAt(i);
      encoded[i * 2] = codeUnit & 0xff;
      encoded[i * 2 + 1] = codeUnit >>> 8;
    }
    return encoded;
  }

  private getIl2CppStringLength(
    value: string,
    encoded: Uint8Array,
    encoding: "utf8" | "utf16",
  ) {
    return encoding === "utf16" ? value.length : encoded.length;
  }

  private resolveObjectNewAtRuntime(typeInfo: number) {
    if (!typeInfo) return undefined;
    const _game = this.getUnityInstance();
    const candidates = this.getExportedCandidates("il2cpp_object_new");
    this.logger.debug(
      "Trying %d runtime candidate(s) for il2cpp_object_new",
      candidates.length,
    );
    for (const candidate of candidates) {
      try {
        const result = candidate(typeInfo);
        if (result > 0) {
          const klass = new DataView(
            _game.Module.HEAPU8.slice(result, result + 4).buffer,
          ).getUint32(0, true);
          if (klass === typeInfo) {
            this.logger.info("Resolved il2cpp_object_new at runtime");
            return candidate;
          }
        }
      } catch {
        // Try next candidate.
      }
    }
    return undefined;
  }

  private getExportedCandidates(name: string) {
    const asm = this.getUnityInstance().Module.asm;
    return Object.keys({ ...this.wasmExports, ...asm })
      .filter((key) => key.startsWith(`__uwm_candidate_${name}_`))
      .sort((a, b) => {
        const ai = Number(a.split("_").pop());
        const bi = Number(b.split("_").pop());
        return ai - bi;
      })
      .map((key) => asm[key] || this.wasmExports?.[key])
      .filter((value) => typeof value === "function");
  }

  public memory(address: number | ValueWrapper, size: number): Uint8Array {
    const _game = this.getUnityInstance();
    if (address instanceof ValueWrapper) address = address.val();
    return _game.Module.HEAPU8.slice(address, address + size);
  }

  public malloc(size: number): number {
    const module = this.getUnityInstance().Module;
    const malloc = this.getRuntimeFunction(module, ["_malloc", "malloc"]);
    if (malloc) return malloc(size);

    const stackSave = this.getRuntimeFunction(module, ["stackSave"]);
    const stackAlloc = this.getRuntimeFunction(module, ["stackAlloc"]);
    if (stackSave && stackAlloc) {
      const savedStack = stackSave();
      const alignedSize = (size + 15) & ~15;
      const ptr = stackAlloc(alignedSize);
      this.stackAllocations.set(ptr, savedStack);
      return ptr;
    }

    throw new Error("No Unity allocator is available on Module or Module.asm");
  }

  public alloc(size: number): ManagedAllocation {
    const ptr = this.malloc(size);
    const allocation = new ManagedAllocation(ptr, size, this);
    this.allocationRegistry?.register(allocation, ptr, allocation);
    return allocation;
  }

  public free(block: number | ValueWrapper) {
    const ptr = block instanceof ValueWrapper ? block.val() : block;
    const module = this.getUnityInstance().Module;

    if (this.stackAllocations.has(ptr)) {
      const savedStack = this.stackAllocations.get(ptr)!;
      const stackRestore = this.getRuntimeFunction(module, ["stackRestore"]);
      this.stackAllocations.delete(ptr);
      if (stackRestore) stackRestore(savedStack);
      return;
    }

    const free = this.getRuntimeFunction(module, ["_free", "free"]);
    if (free) free(ptr);
  }

  public releaseAllocation(allocation: ManagedAllocation) {
    this.allocationRegistry?.unregister(allocation);
    this.free(allocation.val());
  }

  private getRuntimeFunction(
    module: any,
    names: string[],
  ): ((...args: any[]) => any) | undefined {
    const owners = [this.wasmExports, module?.asm, module];
    for (const owner of owners) {
      if (!owner) continue;
      for (const name of names) {
        if (typeof owner[name] === "function") {
          return owner[name].bind(owner);
        }
      }
    }
    return undefined;
  }

  public getTableIndex(targetClass: string, targetMethod: string): number {
    if (!this.il2CppContext?.scriptData[targetClass]) return -1;
    const result = this.il2CppContext.scriptData[targetClass][targetMethod];
    if (!result) return -1;
    return result;
  }

  public getInvokerTableIndex(targetClass: string, targetMethod: string): number {
    if (!this.il2CppContext?.scriptInvokerData?.[targetClass]) return -1;
    const result = this.il2CppContext.scriptInvokerData[targetClass][targetMethod];
    if (!result) return -1;
    return result;
  }

  public getFieldInfo(targetClass: string, fieldName: string) {
    const override = this.getFieldOffsetOverride(targetClass, fieldName);
    const fieldData = this.il2CppContext?.fieldData;
    if (!fieldData) {
      return override === undefined ? undefined : { offset: override };
    }

    const exactField = fieldData[targetClass]?.[fieldName];
    if (exactField)
      return override === undefined
        ? exactField
        : { ...exactField, offset: override };

    for (const typeName of this.getCandidateTypeNames(targetClass)) {
      const field = fieldData[typeName]?.[fieldName];
      if (field)
        return override === undefined ? field : { ...field, offset: override };
    }

    return override === undefined ? undefined : { offset: override };
  }

  public registerFieldOffsets(offsets: Record<string, Record<string, number>>) {
    for (const [typeName, fields] of Object.entries(offsets)) {
      this.fieldOffsetOverrides[typeName] = {
        ...(this.fieldOffsetOverrides[typeName] || {}),
        ...fields,
      };
    }
  }

  private getFieldOffsetOverride(targetClass: string, fieldName: string) {
    const exact = this.fieldOffsetOverrides[targetClass]?.[fieldName];
    if (exact !== undefined) return exact;
    const shortName = targetClass.split(".").pop() || targetClass;
    for (const [typeName, fields] of Object.entries(
      this.fieldOffsetOverrides,
    )) {
      if (typeName === shortName || typeName.endsWith(`.${shortName}`)) {
        const value = fields[fieldName];
        if (value !== undefined) return value;
      }
    }
    return undefined;
  }

  public listFields(targetClass?: string) {
    const fieldData = this.il2CppContext?.fieldData;
    if (!fieldData) return [];

    const typeNames = targetClass
      ? this.getCandidateTypeNames(targetClass)
      : Object.keys(fieldData);

    return typeNames.flatMap((typeName) =>
      Object.entries(fieldData[typeName] || {}).map(([name, info]) => ({
        typeName,
        name,
        index: info.index,
        offset: this.getFieldOffsetOverride(typeName, name) ?? info.offset,
        token: info.token,
        typeIndex: info.typeIndex,
      })),
    );
  }

  public findFields(pattern: string) {
    const needle = pattern.toLowerCase();
    return this.listFields().filter(
      (field) => {
        const typeName = field.typeName.toLowerCase();
        const name = field.name.toLowerCase();
        return (
          typeName.includes(needle) ||
          name.includes(needle) ||
          `${typeName}.${name}`.includes(needle)
        );
      },
    );
  }

  public listMethods(targetClass?: string) {
    const entries = this.buildMethodEntries();
    if (!targetClass) return entries;
    const candidateTypes = new Set(this.getCandidateMethodTypeNames(targetClass));
    return entries.filter((entry) => candidateTypes.has(entry.typeName));
  }

  public getMethodWasmType(targetClass: string, targetMethod: string) {
    const tableIndex = this.getTableIndex(targetClass, targetMethod);
    if (!this.isValidTableIndex(tableIndex)) return undefined;
    const internalIndex = this.getInternalIndex(tableIndex);
    if (!this.isValidInternalIndex(internalIndex)) return undefined;
    const bodyIndex = internalIndex + 1;
    const bodyType = this.getWasmFunctionTypeByGlobalIndex(bodyIndex);
    const tableType = this.getWasmFunctionTypeByGlobalIndex(internalIndex);
    const type = bodyType || tableType;
    if (!type) return undefined;
    return {
      params: Array.from(type.params || []),
      returnType: type.returnType,
      tableIndex,
      internalIndex: bodyType ? bodyIndex : internalIndex,
    };
  }

  public isWasmStructureReady() {
    return this.hasWasmStructure();
  }

  public findMethods(pattern: string) {
    const needle = pattern.toLowerCase();
    return this.listMethods().filter(
      (method) => {
        const typeName = method.typeName.toLowerCase();
        const name = method.name.toLowerCase();
        return (
          typeName.includes(needle) ||
          name.includes(needle) ||
          `${typeName}.${name}`.includes(needle)
        );
      },
    );
  }

  private buildMethodEntries() {
    if (!this.globalMetadata || !this.il2CppContext) return [];
    const reader = new BinaryReader(this.globalMetadata.buffer);
    const stringOffset = this.getMetadataSectionOffset("string", "strings");
    const entries: Array<{
      typeName: string;
      name: string;
      tableIndex: number;
      methodIndex?: number;
      token: number;
      parameterCount: number;
      parameterStart: number;
      returnType: number;
      genericContainerIndex: number;
    }> = [];

    for (const imageDef of this.globalMetadata.imageDefs) {
      const imageName = this.getMetadataString(
        reader,
        stringOffset,
        imageDef.nameIndex,
      );
      const ptrs = this.il2CppContext.codeGenModuleMethodPointers?.[imageName];
      if (!ptrs) continue;

      const typeEnd = imageDef.typeStart + imageDef.typeCount;
      for (const typeDef of this.globalMetadata.typeDefs) {
        const typeIndex = typeDef.typeIndex;
        if (
          typeIndex === undefined ||
          typeIndex < imageDef.typeStart ||
          typeIndex >= typeEnd
        ) {
          continue;
        }
        const name = this.getMetadataString(reader, stringOffset, typeDef.nameIndex);
        const namespaceName = this.getMetadataString(
          reader,
          stringOffset,
          typeDef.namespaceIndex,
        );
        const typeName = namespaceName ? `${namespaceName}.${name}` : name;
        const typeEntries: typeof entries = [];
        const methodEnd = typeDef.methodStart + typeDef.method_count;
        for (let i = typeDef.methodStart; i < methodEnd; i++) {
          const methodDef = this.globalMetadata.methodDefs.find(
            (def) => def.methodIndex === i,
          );
          if (!methodDef) continue;
          let methodName = this.getMetadataString(
            reader,
            stringOffset,
            methodDef.nameIndex,
          );
          const methodPointerIndex = methodDef.token & 0x00ffffff;
          const tableIndex = ptrs[methodPointerIndex - 1];
          if (tableIndex === undefined) continue;
          const existing = typeEntries.find((entry) => entry.name === methodName);
          if (existing) {
            existing.name = `${existing.name}_${existing.tableIndex}`;
            methodName = `${methodName}_${tableIndex}`;
          }
          typeEntries.push({
            typeName,
            name: methodName,
            tableIndex,
            methodIndex: methodDef.methodIndex,
            token: methodDef.token,
            parameterCount: methodDef.parameterCount,
            parameterStart: methodDef.parameterStart,
            returnType: methodDef.returnType,
            genericContainerIndex: methodDef.genericContainerIndex,
          });
        }
        entries.push(...typeEntries);
      }
    }
    return entries;
  }

  public findTypes(pattern: string) {
    if (!this.globalMetadata) return [];
    const needle = pattern.toLowerCase();
    const stringOffset = this.getMetadataSectionOffset("string", "strings");
    const reader = new BinaryReader(this.globalMetadata.buffer);
    const results: Array<{
      typeName: string;
      assemblyName: string;
      imageName: string;
      typeIndex?: number;
      runtimeTypeIndex?: number;
    }> = [];

    for (const imageDef of this.globalMetadata.imageDefs) {
      const imageName = this.getMetadataString(
        reader,
        stringOffset,
        imageDef.nameIndex,
      );
      const assemblyName = imageName.replace(/\.dll$/i, "");
      const typeEnd = imageDef.typeStart + imageDef.typeCount;
      for (const typeDef of this.globalMetadata.typeDefs) {
        const typeIndex = typeDef.typeIndex;
        if (
          typeIndex === undefined ||
          typeIndex < imageDef.typeStart ||
          typeIndex >= typeEnd
        ) {
          continue;
        }
        const name = this.getMetadataString(
          reader,
          stringOffset,
          typeDef.nameIndex,
        );
        const namespaceName = this.getMetadataString(
          reader,
          stringOffset,
          typeDef.namespaceIndex,
        );
        const typeName = namespaceName ? `${namespaceName}.${name}` : name;
        const shortName = typeName.split(".").pop() || typeName;
        if (
          typeName.toLowerCase().includes(needle) ||
          shortName.toLowerCase() === needle ||
          `${typeName}, ${assemblyName}`.toLowerCase().includes(needle)
        ) {
          results.push({
            typeName,
            assemblyName,
            imageName,
            typeIndex,
            runtimeTypeIndex: typeDef.byvalTypeIndex,
          });
        }
      }
    }
    return results;
  }

  public getRuntimeTypeNameCandidates(targetClass: string): string[] {
    const seen = new Set<string>();
    const candidates: string[] = [];
    const add = (value: string | undefined) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      candidates.push(value);
    };

    add(targetClass);
    for (const type of this.findTypes(targetClass)) {
      add(type.typeName);
      add(`${type.typeName}, ${type.assemblyName}`);
      add(`${type.typeName}, ${type.imageName}`);
    }
    return candidates;
  }

  public getRuntimeTypeAddress(typeIndex: number | undefined) {
    if (typeIndex === undefined || typeIndex < 0) return undefined;
    const runtimeTypeIndex =
      this.globalMetadata?.typeDefs.find((typeDef) => typeDef.typeIndex === typeIndex)
        ?.byvalTypeIndex ?? typeIndex;
    const address = this.il2CppContext?.typeAddresses?.[runtimeTypeIndex];
    return address && address > 0 ? address : undefined;
  }

  private getMetadataSectionOffset(
    legacyName: string,
    modernName = legacyName,
  ) {
    const header = this.globalMetadata?.header;
    if (!header) return 0;
    return header[`${modernName}Offset`] ?? header[`${legacyName}Offset`] ?? 0;
  }

  private getMetadataString(
    reader: BinaryReader,
    base: number,
    offset: number,
  ) {
    reader.seek(base + offset);
    return reader.readNullTerminatedUTF8String();
  }

  private getCandidateTypeNames(targetClass: string): string[] {
    const fieldData = this.il2CppContext?.fieldData;
    if (!fieldData) return [];

    const seen = new Set<string>();
    const candidates: string[] = [];
    const add = (typeName: string | undefined) => {
      if (!typeName || seen.has(typeName) || !fieldData[typeName]) return;
      seen.add(typeName);
      candidates.push(typeName);
    };

    add(targetClass);
    const shortName = targetClass.split(".").pop() || targetClass;
    for (const typeName of Object.keys(fieldData)) {
      if (typeName === shortName || typeName.endsWith(`.${shortName}`)) {
        add(typeName);
      }
    }
    return candidates;
  }

  private getCandidateMethodTypeNames(targetClass: string): string[] {
    const scriptData = this.il2CppContext?.scriptData;
    if (!scriptData) return [];

    const seen = new Set<string>();
    const candidates: string[] = [];
    const add = (typeName: string | undefined) => {
      if (!typeName || seen.has(typeName) || !scriptData[typeName]) return;
      seen.add(typeName);
      candidates.push(typeName);
    };

    add(targetClass);
    const shortName = targetClass.split(".").pop() || targetClass;
    for (const typeName of Object.keys(scriptData)) {
      if (typeName === shortName || typeName.endsWith(`.${shortName}`)) {
        add(typeName);
      }
    }
    return candidates;
  }

  private getInternalIndex(tableIndex: number): number {
    if (!this.internalMappings?.[0]?.elements) return -1;
    return this.internalMappings[0].elements[tableIndex - 1];
  }

  private getInternalIndexForTableSlot(slot: number): number | undefined {
    if (!this.internalMappings?.[0]?.elements) return undefined;
    return this.internalMappings[0].elements[slot];
  }

  public getTableSlot(
    tableIndex: number | undefined,
    table?: WebAssembly.Table,
  ): number | undefined {
    if (!this.isValidTableIndex(tableIndex)) return undefined;
    const slot = tableIndex - 1;
    if (table && (slot < 0 || slot >= table.length)) return undefined;
    return slot;
  }

  private isValidTableIndex(
    tableIndex: number | undefined,
  ): tableIndex is number {
    return (
      typeof tableIndex === "number" &&
      Number.isFinite(tableIndex) &&
      tableIndex > 0
    );
  }

  private isValidInternalIndex(index: number | undefined): index is number {
    return typeof index === "number" && Number.isFinite(index) && index >= 0;
  }

  private getHookByIndex(index: number): Hook | null {
    let totalHooksCount = 0;

    for (const plugin of this.plugins) {
      const hooksCount = plugin.hooks.length;

      // Check if the index is within the current plugin's hooks range
      if (index < totalHooksCount + hooksCount) {
        const hookIndex = index - totalHooksCount;
        return plugin.hooks[hookIndex];
      }

      totalHooksCount += hooksCount;
    }

    // If the index is out of range, return null
    return null;
  }

  private getUnappliedHooks(): Hook[] {
    return this.plugins
      .flatMap((plugin) => plugin.hooks)
      .filter((hook) => !hook.applied);
  }

  private shouldUseIndirectOnlyHooks() {
    return (
      this.plugins.length > 0 &&
      this.plugins.every((plugin) => plugin.preferIndirectHooks) &&
      !this.plugins.some((plugin) => plugin.hasPendingMethodProbes)
    );
  }
}

type Hook = {
  index?: number;
  tableIndex?: number;
  tableSlot?: number;
  oldFuncIndex?: number;
  replacementFuncIndex?: number;
  originalExportName?: string;
  bodyPatched?: boolean;
  bodyPatchTargets?: number[];
  skipDirectFallback?: boolean;
  sharedBodyFallback?: boolean;
  sharedBodyAliasCount?: number;
  runtimeTableFallbackOnly?: boolean;
  tryInvokerFallback?: boolean;
  invokerFallbackApplied?: boolean;
  invokerTableIndex?: number;
  invokerInternalIndex?: number;
  callCount?: number;
  lastArgs?: number[];
  typeName: string;
  methodName: string;
  params: string[];
  returnType?: string;
  applied: boolean;
  enabled: boolean;
  kind: number;
  callback: PrefixCallback | PostfixCallback;
};

type BodyHookTarget = {
  globalIndex: number;
  funcType: number;
  locals: string[];
  instructions: Uint8Array[];
  params: string[];
  returnType?: string;
  signatureMode: "exact" | "physical";
};

type ImportHook = {
  moduleName?: string;
  importName?: string;
  importNames?: string[];
  pattern?: string;
  applied: boolean;
  enabled: boolean;
  callback: ImportHookCallback;
};

export type BytecodePatch = {
  index?: number;
  tableIndex?: number;
  typeName: string;
  methodName: string;
  bytecode?: number[];
  returnType?: string;
  applied: boolean;
  enabled: boolean;
  kind: "patch" | "nop";
};

type WasmExportEntry = {
  name: string;
  kind: number;
  index: number;
};

export type HookInfo = {
  typeName: string;
  methodName: string;
  params: string[];
  returnType?: string;
  directFallback?: boolean;
  runtimeTableFallback?: boolean;
  invokerFallback?: boolean;
  sharedBodyFallback?: boolean;
  allowSharedBody?: boolean;
};

export type UpdateProbeOptions = {
  methodNames?: string[];
  typePattern?: string | RegExp;
  methodPattern?: string | RegExp;
  params?: string[];
  maxHooks?: number;
  logEvery?: number;
  directFallback?: boolean;
  sharedBodyFallback?: boolean;
};

export type MethodProbeOptions = {
  typeName?: string;
  typePattern?: string | RegExp;
  methodPattern?: string | RegExp;
  methodNames?: string[];
  maxHooks?: number;
  logEvery?: number;
  directFallback?: boolean;
  sharedBodyFallback?: boolean;
  includeReturns?: boolean;
};

export type MethodProbeHit = {
  typeName: string;
  methodName: string;
  hook: any;
  callCount: number;
  args: ValueWrapper[];
};

export type UpdateProbeHit = MethodProbeHit;

type MethodProbeCallback = (hit: MethodProbeHit) => void;
type UpdateProbeCallback = MethodProbeCallback;

type PendingUpdateProbe = {
  options: UpdateProbeOptions;
  callback?: UpdateProbeCallback;
  hooks: Hook[];
};

type PendingMethodProbe = {
  options: MethodProbeOptions;
  callback?: MethodProbeCallback;
  hooks: Hook[];
};

export type ImportHookInfo = {
  moduleName?: string;
  importName?: string;
  importNames?: string[];
  pattern?: string;
};

export type MethodTarget =
  | string
  | {
      typeName: string;
      methodName: string;
      returnType?: string;
    };

type PrefixCallback = ((...args: any) => boolean) | (() => void);
type PostfixCallback = (...args: any) => void;
type ImportHookCallback = (...args: any) => boolean | number | void;

type ModkitPluginOptions = {
  name: string;
  version?: string;
  referencedAssemblies?: string[];
  preferIndirectHooks?: boolean;
  globalName?: string | string[];
  diagnostics?: boolean;
  showDiagnostics?: boolean;
  diag?: boolean;
};

function resolveDiagnosticsOption(opts: ModkitPluginOptions) {
  if (opts.diagnostics !== undefined) return opts.diagnostics;
  if (opts.showDiagnostics !== undefined) return opts.showDiagnostics;
  if (opts.diag !== undefined) return opts.diag;
  return undefined;
}

class ModkitPlugin {
  public readonly name: string;
  public readonly version: string;
  public readonly logger: Logger;
  public readonly preferIndirectHooks: boolean;
  public onLoaded: (() => void) | undefined = undefined;
  public onReady: (() => void) | undefined = undefined;
  private _referencedAssemblies: string[] = [];
  private _hooks: Hook[] = [];
  private _importHooks: ImportHook[] = [];
  private _bytecodePatches: BytecodePatch[] = [];
  private _pendingUpdateProbes: PendingUpdateProbe[] = [];
  private _pendingMethodProbes: PendingMethodProbe[] = [];
  private _runtime: Runtime;
  public readonly objects: ObjectQueryApi;

  constructor(
    name: string,
    version: string | undefined,
    referencedAssemblies: string[] | undefined,
    preferIndirectHooks: boolean | undefined,
    runtime: Runtime,
  ) {
    this.name = name;
    this.version = version || "1.0.0";
    this.logger = new Logger(name);
    this.preferIndirectHooks = preferIndirectHooks === true;
    this._referencedAssemblies = referencedAssemblies || [];
    this._runtime = runtime;
    this.objects = new ObjectQueryApi(this);
  }

  public get hooks() {
    return this._hooks;
  }

  public get importHooks() {
    return this._importHooks;
  }

  public get bytecodePatches() {
    return this._bytecodePatches;
  }

  public get hasPendingMethodProbes() {
    return this._pendingMethodProbes.length > 0;
  }

  public get referencedAssemblies() {
    return this._referencedAssemblies;
  }

  public get metadata() {
    return this._runtime.metadata;
  }

  public diag(message: string, data?: any) {
    if (data === undefined) {
      this.logger.info("[DIAG] %s", message);
      return;
    }
    this.logger.info("[DIAG] %s %o", message, data);
  }

  public setDiagnosticsEnabled(enabled: boolean) {
    Logger.setDiagnosticsEnabled(enabled);
  }

  public getDiagnosticsEnabled() {
    return Logger.getDiagnosticsEnabled();
  }

  public hookPrefix(target: HookInfo, callback: PrefixCallback): Hook {
    return this.hook(target, callback, 0);
  }

  public hookPostfix(target: HookInfo, callback: PostfixCallback): Hook {
    return this.hook(target, callback, 1);
  }

  public probeUpdateHooks(
    options: UpdateProbeOptions = {},
    callback?: UpdateProbeCallback,
  ): Hook[] {
    const hooks: Hook[] = [];
    if (this.listMethods().length === 0) {
      this._pendingUpdateProbes.push({ options, callback, hooks });
      this.logger.info("[PROBE] queued update hook probe until metadata is ready");
      return hooks;
    }
    this.installUpdateProbeHooks(options, callback, hooks);
    return hooks;
  }

  public probeTypeHooks(
    options: MethodProbeOptions = {},
    callback?: MethodProbeCallback,
  ): Hook[] {
    const hooks: Hook[] = [];
    if (
      this.listMethods().length === 0 ||
      !this._runtime.isWasmStructureReady()
    ) {
      this._pendingMethodProbes.push({ options, callback, hooks });
      this.logger.info("[PROBE] queued method hook probe until wasm metadata is ready");
      return hooks;
    }
    this.installMethodProbeHooks(options, callback, hooks);
    return hooks;
  }

  public probeMethodHooks(
    options: MethodProbeOptions = {},
    callback?: MethodProbeCallback,
  ): Hook[] {
    return this.probeTypeHooks(options, callback);
  }

  public expandPendingUpdateProbes() {
    const probes = this._pendingUpdateProbes.splice(0);
    for (const probe of probes) {
      this.installUpdateProbeHooks(
        probe.options,
        probe.callback,
        probe.hooks,
      );
    }
  }

  public expandPendingMethodProbes() {
    const probes = this._pendingMethodProbes.splice(0);
    for (const probe of probes) {
      this.installMethodProbeHooks(
        probe.options,
        probe.callback,
        probe.hooks,
      );
    }
  }

  private installUpdateProbeHooks(
    options: UpdateProbeOptions,
    callback: UpdateProbeCallback | undefined,
    hooks: Hook[],
  ) {
    const methodNames = new Set(
      (options.methodNames || ["Update", "FixedUpdate", "LateUpdate"]).map(
        (name) => name.toLowerCase(),
      ),
    );
    const params = options.params || ["i32", "i32"];
    const maxHooks = options.maxHooks ?? 80;
    const logEvery = Math.max(1, options.logEvery ?? 60);
    const typeMatches = this.makeProbeMatcher(
      options.typePattern ||
        /player|controller|movement|move|weapon|gun|character|combat|network|local|input|camera/i,
    );
    const methodMatches = this.makeProbeMatcher(options.methodPattern);

    const candidates = this.listMethods()
      .filter((method: any) => {
        const baseName = this.getProbeBaseMethodName(method.name);
        if (!methodNames.has(baseName.toLowerCase())) return false;
        if (!typeMatches(method.typeName)) return false;
        if (methodMatches && !methodMatches(method.name)) return false;
        return true;
      })
      .slice(0, maxHooks);

    for (const method of candidates) {
      let hook: Hook;
      hook = this.hookPrefix(
        {
          typeName: method.typeName,
          methodName: method.name,
          params,
          sharedBodyFallback: options.sharedBodyFallback !== false,
        },
        (...args: any[]) => {
          const wrappedArgs = args.map((arg) =>
            arg instanceof ValueWrapper ? arg : new ValueWrapper(arg),
          );
          const callCount = hook.callCount || 0;
          if (callback) {
            callback({
              typeName: method.typeName,
              methodName: method.name,
              hook,
              callCount,
              args: wrappedArgs,
            });
            return;
          }
          if (callCount <= 5 || callCount % logEvery === 0) {
            this.logger.info(
              "[PROBE] %s.%s hit #%d %o",
              method.typeName,
              method.name,
              callCount,
              wrappedArgs.map((arg) => arg.val()),
            );
          }
        },
      );
      hook.skipDirectFallback = options.directFallback !== true;
      hooks.push(hook);
    }

    this.logger.info(
      "[PROBE] installed %d update hook(s) %o",
      hooks.length,
      candidates.map((method: any) => `${method.typeName}.${method.name}`),
    );
  }

  private installMethodProbeHooks(
    options: MethodProbeOptions,
    callback: MethodProbeCallback | undefined,
    hooks: Hook[],
  ) {
    const maxHooks = options.maxHooks ?? 120;
    const logEvery = Math.max(1, options.logEvery ?? 60);
    const typeMatches = this.makeProbeMatcher(
      options.typePattern || options.typeName,
    );
    const methodMatches = this.makeProbeMatcher(options.methodPattern);
    const methodNames = options.methodNames
      ? new Set(options.methodNames.map((name) => name.toLowerCase()))
      : undefined;
    const includeReturns = options.includeReturns !== false;

    const allMethods = this.listMethods();
    const matchedMethods = allMethods.filter((method: any) => {
        if (typeMatches && !typeMatches(method.typeName)) return false;
        if (methodMatches && !methodMatches(method.name)) return false;
        if (
          methodNames &&
          !methodNames.has(this.getProbeBaseMethodName(method.name).toLowerCase()) &&
          !methodNames.has(method.name.toLowerCase())
        ) {
          return false;
        }
        return true;
      });
    const typedMethods = matchedMethods.map((method: any) => {
        const wasmType = this._runtime.getMethodWasmType(
          method.typeName,
          method.name,
        );
        return { method, wasmType };
      });
    const supportedMethods = typedMethods.filter(({ wasmType }: any) => {
        if (!wasmType) return false;
        if (!wasmType.params?.every((param: string) => param === "i32")) {
          return false;
        }
        if (!includeReturns && wasmType.returnType) return false;
        return true;
      });
    const candidates = supportedMethods
      .slice(0, maxHooks);

    this.diag("probe.method candidates", {
      typeName: options.typeName,
      typePattern: options.typePattern,
      methodPattern: options.methodPattern,
      allMethods: allMethods.length,
      matchedMethods: matchedMethods.length,
      typedMethods: typedMethods.filter(({ wasmType }: any) => Boolean(wasmType))
        .length,
      supportedMethods: supportedMethods.length,
      includeReturns,
      sample: typedMethods.slice(0, 16).map(({ method, wasmType }: any) => ({
        typeName: method.typeName,
        name: method.name,
        tableIndex: method.tableIndex,
        wasmType,
      })),
    });

    for (const { method, wasmType } of candidates as any[]) {
      let hook: Hook;
      hook = this.hookPrefix(
        {
          typeName: method.typeName,
          methodName: method.name,
          params: wasmType.params,
          returnType: wasmType.returnType,
          sharedBodyFallback: options.sharedBodyFallback !== false,
        },
        (...args: any[]) => {
          const wrappedArgs = args.map((arg) =>
            arg instanceof ValueWrapper ? arg : new ValueWrapper(arg),
          );
          const callCount = hook.callCount || 0;
          if (callback) {
            callback({
              typeName: method.typeName,
              methodName: method.name,
              hook,
              callCount,
              args: wrappedArgs,
            });
            return;
          }
          if (callCount <= 5 || callCount % logEvery === 0) {
            this.logger.info(
              "[PROBE] %s.%s hit #%d %o",
              method.typeName,
              method.name,
              callCount,
              wrappedArgs.map((arg) => arg.val()),
            );
          }
        },
      );
      if (wasmType.returnType && options.directFallback !== true) {
        hook.runtimeTableFallbackOnly = true;
        hook.tryInvokerFallback = true;
      }
      hook.skipDirectFallback = wasmType.returnType
        ? options.directFallback === false
        : options.directFallback !== true;
      hooks.push(hook);
    }

    this.logger.info(
      "[PROBE] installed %d method hook(s) %o",
      hooks.length,
      candidates.map(
        ({ method, wasmType }: any) =>
          `${method.typeName}.${method.name}(${wasmType.params.join(",")})${
            wasmType.returnType ? `:${wasmType.returnType}` : ""
          }`,
      ),
    );
  }

  public hookImport(
    target: ImportHookInfo,
    callback: ImportHookCallback,
  ): ImportHook {
    const hook: ImportHook = {
      moduleName: target.moduleName,
      importName: target.importName,
      importNames: target.importNames,
      pattern: target.pattern,
      applied: false,
      enabled: true,
      callback,
    };
    this._importHooks.push(hook);
    return hook;
  }

  public patchBytecode(
    target: MethodTarget,
    bytecode: number[],
  ): BytecodePatch {
    const parsed = this.parseMethodTarget(target);
    const patch: BytecodePatch = {
      typeName: parsed.typeName,
      methodName: parsed.methodName,
      returnType: parsed.returnType,
      bytecode: Array.from(bytecode),
      applied: false,
      enabled: true,
      kind: "patch",
    };
    this._bytecodePatches.push(patch);
    return patch;
  }

  public nopMethod(target: MethodTarget): BytecodePatch {
    const parsed = this.parseMethodTarget(target);
    const patch: BytecodePatch = {
      typeName: parsed.typeName,
      methodName: parsed.methodName,
      returnType: parsed.returnType,
      applied: false,
      enabled: true,
      kind: "nop",
    };
    this._bytecodePatches.push(patch);
    return patch;
  }

  private parseMethodTarget(target: MethodTarget) {
    if (typeof target !== "string") return target;
    const normalized = target.replace("::", "$$");
    let separator = normalized.indexOf("$$");
    let separatorLength = 2;
    if (separator < 0) {
      separator = normalized.lastIndexOf(".");
      separatorLength = 1;
    }
    if (separator < 0) {
      throw new Error(
        `Invalid method target "${target}". Use "Type$$Method", "Type.Method", or { typeName, methodName }.`,
      );
    }
    return {
      typeName: normalized.slice(0, separator),
      methodName: normalized.slice(separator + separatorLength),
    };
  }

  private hook(
    target: HookInfo,
    callback: PrefixCallback | PostfixCallback,
    kind: number,
  ): Hook {
    const hook = {
      typeName: target.typeName,
      methodName: target.methodName,
      params: target.params,
      returnType: target.returnType,
      sharedBodyFallback:
        target.sharedBodyFallback === true || target.allowSharedBody === true,
      runtimeTableFallbackOnly: target.runtimeTableFallback === true,
      tryInvokerFallback: target.invokerFallback === true,
      skipDirectFallback: target.directFallback === false,
      applied: false,
      enabled: true,
      kind,
      callCount: 0,
      callback,
    };
    this._hooks.push(hook);
    return hook;
  }

  private getProbeBaseMethodName(name: string) {
    return name.replace(/_\d+$/, "");
  }

  private makeProbeMatcher(pattern?: string | RegExp) {
    if (!pattern) return (_value: string) => true;
    if (Object.prototype.toString.call(pattern) === "[object RegExp]") {
      const regexp = pattern as RegExp;
      return (value: string) => {
        regexp.lastIndex = 0;
        return regexp.test(value);
      };
    }
    const needle = String(pattern).toLowerCase();
    return (value: string) => value.toLowerCase().includes(needle);
  }

  public call(target: string, args: any[]): ValueWrapper;
  public call(
    targetClass: string,
    targetMethod: string,
    args: any[],
  ): ValueWrapper;
  public call(
    target: string,
    targetMethodOrArgs?: string | any[],
    args?: any[],
  ) {
    const _game = this._runtime.getUnityInstance();
    const table = this._runtime.getWasmTable(_game.Module);
    if (!table) {
      throw new Error("Failed to invoke function! Wasm table not found.");
    }
    if (typeof targetMethodOrArgs === "string") {
      const tableIndex = this._runtime.getTableIndex(
        target,
        targetMethodOrArgs,
      );
      if (tableIndex === -1)
        throw new Error(
          `Failed to invoke function! Could not find table index for ${
            target + "$$" + targetMethodOrArgs
          }`,
        );
      if (args)
        args = args.map((arg) =>
          arg instanceof ValueWrapper ? arg.val() : arg,
        );
      const tableSlot = this._runtime.getTableSlot(tableIndex, table);
      if (tableSlot === undefined)
        throw new Error(
          `Failed to invoke function! Invalid table slot for ${
            target + "$$" + targetMethodOrArgs
          }`,
        );
      const result = table.get(tableSlot)(...(args as any[]));
      return new ValueWrapper(result);
    } else if (
      typeof targetMethodOrArgs === "object" ||
      typeof targetMethodOrArgs === "undefined"
    ) {
      const [typeName, methodName] = target.replace("::", "$$").split("$$");
      const tableIndex = this._runtime.getTableIndex(typeName, methodName);
      if (tableIndex === -1)
        throw new Error(
          `Failed to invoke function! Could not find table index for ${
            typeName + "$$" + methodName
          }`,
        );
      if (!targetMethodOrArgs) targetMethodOrArgs = [];
      targetMethodOrArgs = targetMethodOrArgs.map((arg) =>
        arg instanceof ValueWrapper ? arg.val() : arg,
      );
      const tableSlot = this._runtime.getTableSlot(tableIndex, table);
      if (tableSlot === undefined)
        throw new Error(
          `Failed to invoke function! Invalid table slot for ${
            typeName + "$$" + methodName
          }`,
        );
      const result = table.get(tableSlot)(...(targetMethodOrArgs as any[]));
      return new ValueWrapper(result);
    }
  }

  public createObject(typeInfo: ValueWrapper | number): ValueWrapper {
    return new ValueWrapper(this._runtime.createObject(typeInfo));
  }

  public createMstr(char: string): ValueWrapper {
    return new ValueWrapper(this._runtime.createMstr(char));
  }

  public slice(address: ValueWrapper | number, size: number = 256): Uint8Array {
    return this._runtime.memory(address, size);
  }

  public malloc(size: number): ValueWrapper {
    return new ValueWrapper(this._runtime.malloc(size));
  }

  public alloc(size: number): ManagedAllocation {
    return this._runtime.alloc(size);
  }

  public free(block: ValueWrapper | number) {
    this._runtime.free(block);
  }

  public getFieldInfo(targetClass: string, fieldName: string) {
    return this._runtime.getFieldInfo(targetClass, fieldName);
  }

  public registerFieldOffsets(offsets: Record<string, Record<string, number>>) {
    this._runtime.registerFieldOffsets(offsets);
  }

  public listFields(targetClass?: string) {
    return this._runtime.listFields(targetClass);
  }

  public findFields(pattern: string) {
    return this._runtime.findFields(pattern);
  }

  public listMethods(targetClass?: string) {
    return this._runtime.listMethods(targetClass);
  }

  public findMethods(pattern: string) {
    return this._runtime.findMethods(pattern);
  }

  public getMethodWasmType(targetClass: string, targetMethod: string) {
    return this._runtime.getMethodWasmType(targetClass, targetMethod);
  }

  public findTypes(pattern: string) {
    return this._runtime.findTypes(pattern);
  }

  public getTypeNameCandidates(typeName: string) {
    return this._runtime.getRuntimeTypeNameCandidates(typeName);
  }

  public getRuntimeTypeAddress(typeIndex: number | undefined) {
    return this._runtime.getRuntimeTypeAddress(typeIndex);
  }

  public memcpy(
    dest: ValueWrapper | number,
    src: ValueWrapper | number,
    count: number,
  ) {
    const _game = this._runtime.getUnityInstance();
    writeUint8ArrayAtOffset(
      _game.Module.HEAPU8,
      this.slice(src, count),
      dest instanceof ValueWrapper ? dest.val() : dest,
    );
  }
}

type ObjectTreeDumpOptions = {
  depth?: number;
  includePosition?: boolean;
};

type ObjectTreeNode = {
  ptr: number;
  name: string | null;
  position?: { x: number; y: number; z: number };
  children: ObjectTreeNode[];
};

type TypeResolutionTrace = {
  query: string;
  names: string[];
  metadataTypes: Array<{
    typeName: string;
    assemblyName: string;
    imageName: string;
    typeIndex?: number;
    runtimeTypeIndex?: number;
    typeAddress?: number;
  }>;
  stringResults: Array<{
    name: string;
    method?: string;
    mode?: string;
    args?: any[];
    result: number;
    resultName?: string | null;
    resultFullName?: string | null;
    accepted?: boolean;
  }>;
  handleResults: Array<{
    typeIndex?: number;
    runtimeTypeIndex?: number;
    typeAddress?: number;
    method?: string;
    mode?: string;
    args?: any[];
    result: number;
    name?: string | null;
    fullName?: string | null;
    accepted?: boolean;
  }>;
  result?: number;
};

class ObjectQueryApi {
  private readonly plugin: ModkitPlugin;
  private typeCache = new Map<string, ValueWrapper>();
  private typeTraceCache = new Map<string, TypeResolutionTrace>();

  constructor(plugin: ModkitPlugin) {
    this.plugin = plugin;
  }

  public getType(typeName: string): ValueWrapper | undefined {
    const cached = this.typeCache.get(typeName);
    if (cached) return cached;

    const trace = this.resolveType(typeName);
    if (!trace.result) return undefined;
    const result = new ValueWrapper(trace.result);
    this.typeCache.set(typeName, result);
    this.typeTraceCache.set(typeName, trace);
    return result;
  }

  public resolveType(typeName: string): TypeResolutionTrace {
    this.plugin.diag("objects.resolveType start", { typeName });
    const metadataTypes = this.plugin.findTypes(typeName);
    const names = this.getTypeNameCandidates(typeName);
    const trace: TypeResolutionTrace = {
      query: typeName,
      names,
      metadataTypes: metadataTypes.map((metadataType) => ({
        ...metadataType,
        typeAddress: this.plugin.getRuntimeTypeAddress(metadataType.typeIndex),
      })),
      stringResults: [],
      handleResults: [],
    };
    for (const metadataType of metadataTypes) {
      const typeAddress = this.plugin.getRuntimeTypeAddress(
        metadataType.typeIndex,
      );
      if (!typeAddress) continue;
      for (const attempt of this.getHandleTypeAttempts(typeAddress)) {
        this.plugin.diag("objects.resolveType try handle", {
          typeName,
          typeIndex: metadataType.typeIndex,
          runtimeTypeIndex: metadataType.runtimeTypeIndex,
          typeAddress,
          method: attempt.methods[0],
          mode: attempt.mode,
        });
        const result = this.tryCallHandleTypeAttempt(attempt);
        const resultValue = result?.val() ?? 0;
        const name = result && this.isLikelyPointer(resultValue)
          ? this.runtimeTypeName(result)
          : null;
        const fullName = result && this.isLikelyPointer(resultValue)
          ? this.runtimeTypeFullName(result)
          : null;
        const accepted = this.isResolvedTypeMatch(metadataType, typeName, name, fullName);
        trace.handleResults.push({
          typeIndex: metadataType.typeIndex,
          runtimeTypeIndex: metadataType.runtimeTypeIndex,
          typeAddress,
          method: attempt.methods[0],
          mode: attempt.mode,
          args: this.formatDiagArgs(attempt.args),
          result: resultValue,
          name,
          fullName,
          accepted,
        });
        this.plugin.diag("objects.resolveType handle result", {
          typeName,
          method: attempt.methods[0],
          mode: attempt.mode,
          args: this.formatDiagArgs(attempt.args),
          result: resultValue,
          name,
          fullName,
          accepted,
        });
        if (
          result &&
          this.isLikelyPointer(resultValue) &&
          accepted
        ) {
          trace.result = resultValue;
          this.plugin.diag("objects.resolveType success", trace);
          return trace;
        }
      }
    }
    for (const name of names) {
      const namePtr = this.plugin.createMstr(name);
      this.plugin.diag("objects.resolveType try string", { typeName, name });
      for (const attempt of this.getStringTypeAttempts(namePtr)) {
        this.plugin.diag("objects.resolveType try string method", {
          typeName,
          name,
          method: attempt.methods[0],
          mode: attempt.mode,
          args: this.formatDiagArgs(attempt.args),
        });
        const result = this.tryCallStringTypeAttempt(attempt);
        const resultValue = result?.val() ?? 0;
        const resultName = result && this.isLikelyPointer(resultValue)
          ? this.runtimeTypeName(result)
          : null;
        const resultFullName = result && this.isLikelyPointer(resultValue)
          ? this.runtimeTypeFullName(result)
          : null;
        const accepted = metadataTypes.length > 0
          ? metadataTypes.some((metadataType) =>
              this.isResolvedTypeMatch(metadataType, typeName, resultName, resultFullName),
            )
          : this.isResolvedTypeMatch({ typeName }, typeName, resultName, resultFullName);
        trace.stringResults.push({
          name,
          method: attempt.methods[0],
          mode: attempt.mode,
          args: this.formatDiagArgs(attempt.args),
          result: resultValue,
          resultName,
          resultFullName,
          accepted,
        });
        this.plugin.diag("objects.resolveType string result", {
          name,
          method: attempt.methods[0],
          mode: attempt.mode,
          args: this.formatDiagArgs(attempt.args),
          result: resultValue,
          resultName,
          resultFullName,
          accepted,
        });
        if (result && this.isLikelyPointer(resultValue) && accepted) {
          trace.result = resultValue;
          this.plugin.diag("objects.resolveType success", trace);
          return trace;
        }
      }
    }
    this.plugin.diag("objects.resolveType failed", trace);
    return trace;
  }

  private getStringTypeAttempts(namePtr: ValueWrapper) {
    return [
      {
        methods: ["System.Type$$GetType_4757"],
        args: [namePtr],
        mode: "string-1-managed-return",
      },
      {
        methods: ["System.Type$$GetType_2232"],
        args: [namePtr, 0],
        mode: "string-2-managed-return",
      },
      {
        methods: ["System.Type$$GetType", "System.Type$$GetType_854"],
        args: [namePtr, 0, 0],
        mode: "string-3-managed-return",
      },
      {
        methods: ["System.Type$$GetType_486"],
        args: [namePtr, 0, 0, 0],
        mode: "string-4-managed-return",
      },
      {
        methods: ["System.Type$$GetType_317"],
        args: [namePtr, 0, 0, 0, 0],
        mode: "string-5-managed-return",
      },
      {
        methods: ["System.Type$$GetType_4757"],
        args: [namePtr],
        mode: "string-1-direct",
      },
      {
        methods: ["System.Type$$GetType_2232"],
        args: [namePtr, 0],
        mode: "string-2-direct",
      },
      {
        methods: ["System.Type$$GetType", "System.Type$$GetType_854"],
        args: [namePtr, 0, 0],
        mode: "string-3-direct",
      },
    ];
  }

  private getHandleTypeAttempts(typeAddress: number) {
    return [
      {
        methods: ["System.Type$$GetTypeFromHandle"],
        args: [typeAddress],
        mode: "handle-ptr-managed-return",
      },
      {
        methods: ["System.Type$$internal_from_handle"],
        args: [typeAddress],
        mode: "handle-ptr-managed-return",
      },
      {
        methods: ["System.Type$$GetTypeFromHandle"],
        args: [typeAddress, 0],
        mode: "handle-ptr-managed-return-extra",
      },
      {
        methods: ["System.Type$$internal_from_handle"],
        args: [typeAddress, 0],
        mode: "handle-ptr-managed-return-extra",
      },
      {
        methods: ["System.Type$$GetTypeFromHandle"],
        args: [typeAddress],
        mode: "handle-ptr-direct",
      },
      {
        methods: ["System.Type$$internal_from_handle"],
        args: [typeAddress],
        mode: "handle-ptr-direct",
      },
      {
        methods: ["System.Type$$GetTypeFromHandle"],
        args: [typeAddress, 0],
        mode: "handle-ptr-direct-extra",
      },
      {
        methods: ["System.Type$$internal_from_handle"],
        args: [typeAddress, 0],
        mode: "handle-ptr-direct-extra",
      },
      {
        methods: ["System.Type$$GetTypeFromHandle"],
        args: [typeAddress],
        mode: "raw-direct-diag",
      },
      {
        methods: ["System.Type$$GetTypeFromHandle"],
        args: [typeAddress, 0],
        mode: "raw-direct-extra-diag",
      },
    ];
  }

  private isResolvedTypeMatch(
    metadataType: { typeName: string; assemblyName?: string; imageName?: string },
    query: string,
    name: string | null,
    fullName: string | null,
  ) {
    const expectedFullName = metadataType.typeName;
    const expectedName = expectedFullName.split(".").pop() || expectedFullName;
    const queryName = query.split(".").pop() || query;
    return (
      name === expectedName ||
      name === expectedFullName ||
      name === query ||
      name === queryName ||
      fullName === expectedFullName ||
      fullName === query
    );
  }

  private tryCallHandleTypeAttempt(attempt: {
    methods: string[];
    args: any[];
    mode: string;
  }): ValueWrapper | undefined {
    if (attempt.mode.startsWith("handle-ptr")) {
      return this.withRuntimeTypeHandle(attempt.args[0], (handle) => {
        const args = [handle, ...attempt.args.slice(1)];
        if (attempt.mode.includes("managed-return")) {
          return this.tryCallManagedReturn(attempt.methods, args);
        }
        return this.tryCallPointerDirect(attempt.methods, args);
      });
    }
    if (attempt.mode.startsWith("raw-direct")) {
      return this.tryCallPointerDirect(attempt.methods, attempt.args);
    }
    return this.tryCallPointerDirect(attempt.methods, attempt.args);
  }

  private tryCallStringTypeAttempt(attempt: {
    methods: string[];
    args: any[];
    mode: string;
  }): ValueWrapper | undefined {
    if (attempt.mode.endsWith("managed-return")) {
      return this.tryCallManagedReturn(attempt.methods, attempt.args);
    }
    return this.tryCallPointerDirect(attempt.methods, attempt.args);
  }

  private withRuntimeTypeHandle<T>(
    typeAddress: number,
    read: (handle: ValueWrapper) => T,
  ): T {
    const handle = this.plugin.alloc(4);
    try {
      handle.writeField(0, "u32", typeAddress);
      return read(handle);
    } finally {
      handle.dispose();
    }
  }

  private formatDiagArgs(args: any[]) {
    return args.map((arg) => (arg instanceof ValueWrapper ? arg.val() : arg));
  }

  public findByType(typeName: string): ValueWrapper[] {
    const type = this.getType(typeName);
    if (!type) return [];
    const trace = this.typeTraceCache.get(typeName);
    this.plugin.diag("objects.findByType start", {
      typeName,
      type: type.val(),
      metadataTypes: trace?.metadataTypes ?? [],
      handleResults: trace?.handleResults ?? [],
    });
    const array = this.tryFindObjectsArray(typeName, type);
    if (!array) {
      const single = this.tryFindObject(typeName, type);
      if (single) {
        this.plugin.diag("objects.findByType singleton result", {
          typeName,
          type: type.val(),
          object: single.val(),
        });
        return [single];
      }
      this.plugin.diag("objects.findByType no array", {
        typeName,
        type: type.val(),
      });
      return [];
    }
    const objects = this.readObjectArray(array);
    this.plugin.diag("objects.findByType result", {
      typeName,
      type: type.val(),
      array: array.val(),
      count: objects.length,
    });
    return objects;
  }

  public findComponents(typeName: string): ValueWrapper[] {
    return this.findByType(typeName);
  }

  public findGameObjectsByName(name: string): ValueWrapper[] {
    const all = this.findByType("UnityEngine.GameObject");
    return all.filter((obj) => this.name(obj) === name);
  }

  public name(object: ValueWrapper | number): string | null {
    const result = this.tryCall(["UnityEngine.Object$$get_name"], [object, 0]);
    if (!result || result.val() <= 0) return null;
    try {
      return result.mstr();
    } catch {
      return null;
    }
  }

  public runtimeTypeName(type: ValueWrapper | number): string | null {
    return this.typeString(
      this.getRuntimeTypeStringTargets("Name", [
        "System.Type$$get_Name",
        "System.Reflection.MemberInfo$$get_Name",
      ]),
      type,
    );
  }

  public runtimeTypeFullName(type: ValueWrapper | number): string | null {
    return this.typeString(
      this.getRuntimeTypeStringTargets("FullName", [
        "System.Type$$get_FullName",
      ]),
      type,
    );
  }

  public transform(object: ValueWrapper | number): ValueWrapper | undefined {
    return this.tryCall(
      [
        "UnityEngine.GameObject$$get_transform",
        "UnityEngine.Component$$get_transform",
      ],
      [object, 0],
    );
  }

  public gameObject(
    component: ValueWrapper | number,
  ): ValueWrapper | undefined {
    return this.tryCall(
      [
        "UnityEngine.Component$$get_gameObject",
        "UnityEngine.GameObject$$get_gameObject",
      ],
      [component, 0],
    );
  }

  public getComponent(
    object: ValueWrapper | number,
    typeName: string,
  ): ValueWrapper | undefined {
    const type = this.getType(typeName);
    if (!type) return undefined;
    const gameObject =
      this.gameObject(object) || new ValueWrapper(this.ptr(object));
    return this.tryCall(
      [
        "UnityEngine.GameObject$$GetComponent_0",
        "UnityEngine.GameObject$$GetComponent_6135",
        "UnityEngine.Component$$GetComponent_0",
        "UnityEngine.Component$$GetComponent_6132",
      ],
      [gameObject, type, 0],
    );
  }

  public childCount(transform: ValueWrapper | number): number {
    return (
      this.tryCall(
        ["UnityEngine.Transform$$get_childCount"],
        [transform, 0],
      )?.val() ?? 0
    );
  }

  public child(
    transform: ValueWrapper | number,
    index: number,
  ): ValueWrapper | undefined {
    return this.tryCall(
      ["UnityEngine.Transform$$GetChild"],
      [transform, index, 0],
    );
  }

  public children(transform: ValueWrapper | number): ValueWrapper[] {
    const count = this.childCount(transform);
    const result: ValueWrapper[] = [];
    for (let i = 0; i < count; i++) {
      const child = this.child(transform, i);
      if (child && child.val() > 0) result.push(child);
    }
    return result;
  }

  public position(transform: ValueWrapper | number) {
    return this.readVector3Injected(
      "UnityEngine.Transform$$get_position_Injected",
      transform,
    );
  }

  public localPosition(transform: ValueWrapper | number) {
    return this.readVector3Injected(
      "UnityEngine.Transform$$get_localPosition_Injected",
      transform,
    );
  }

  public dumpTree(
    transform: ValueWrapper | number,
    options: ObjectTreeDumpOptions = {},
  ): ObjectTreeNode {
    const maxDepth = options.depth ?? 4;
    const visit = (node: ValueWrapper, depth: number): ObjectTreeNode => {
      const dumped: ObjectTreeNode = {
        ptr: node.val(),
        name: this.name(node),
        children: [],
      };
      if (options.includePosition) dumped.position = this.position(node);
      if (depth >= maxDepth) return dumped;
      dumped.children = this.children(node).map((child) =>
        visit(child, depth + 1),
      );
      return dumped;
    };
    return visit(new ValueWrapper(this.ptr(transform)), 0);
  }

  private tryCall(targets: string[], args: any[]): ValueWrapper | undefined {
    for (const target of targets) {
      try {
        const result = this.plugin.call(target, args);
        if (result && result.val() > 0) return result;
      } catch {
        // Try the next overload/name variant.
      }
    }
    return undefined;
  }

  private tryCallReturn(
    targets: string[],
    args: any[],
    diagLabel?: string,
  ): ValueWrapper | undefined {
    const direct = this.tryCallPointerDirect(targets, args, diagLabel);
    if (direct) return direct;
    return this.tryCallManagedReturn(targets, args, diagLabel);
  }

  private tryCallPointerDirect(
    targets: string[],
    args: any[],
    diagLabel?: string,
  ): ValueWrapper | undefined {
    for (const target of targets) {
      const normalizedArgs = args.map((arg) =>
        arg instanceof ValueWrapper ? arg.val() : arg,
      );
      try {
        const result = this.plugin.call(target, args);
        if (diagLabel) {
          this.plugin.diag(`${diagLabel} direct`, {
            target,
            args: normalizedArgs,
            result: result?.val() ?? 0,
          });
        }
        if (result && this.isLikelyPointer(result.val())) return result;
      } catch (err) {
        if (diagLabel) {
          this.plugin.diag(`${diagLabel} direct failed`, {
            target,
            args: normalizedArgs,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Try the next overload/name variant.
      }
    }
    return undefined;
  }

  private tryCallManagedReturn(
    targets: string[],
    args: any[],
    diagLabel?: string,
  ): ValueWrapper | undefined {
    for (const target of targets) {
      const normalizedArgs = args.map((arg) =>
        arg instanceof ValueWrapper ? arg.val() : arg,
      );
      const result = this.plugin.alloc(4);
      try {
        result.writeField(0, "u32", 0);
        this.plugin.call(target, [result, ...args]);
        const ptr = result.readField(0, "u32")?.val() ?? 0;
        if (diagLabel) {
          this.plugin.diag(`${diagLabel} managed`, {
            target,
            args: normalizedArgs,
            result: ptr,
          });
        }
        if (this.isLikelyPointer(ptr)) return new ValueWrapper(ptr);
      } catch (err) {
        this.plugin.diag("managed return call failed", {
          target,
          args: args.map((arg) => (arg instanceof ValueWrapper ? arg.val() : arg)),
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        result.dispose();
      }
    }
    return undefined;
  }

  private isLikelyPointer(value: number): boolean {
    return Number.isInteger(value) && value > 0x1000;
  }

  private tryCallVariants(
    targets: string[],
    argVariants: any[][],
  ): ValueWrapper | undefined {
    for (const args of argVariants) {
      const result = this.tryCall(targets, args);
      if (result) return result;
    }
    return undefined;
  }

  private tryFindObjectsArray(
    typeName: string,
    type: ValueWrapper,
  ): ValueWrapper | undefined {
    const targets = this.getFindObjectsTargets();
    this.plugin.diag("objects.findByType candidates", {
      typeName,
      count: targets.length,
      targets,
    });
    const argVariants = [[type], [type, 0], [type, 1], [type, 0, 0]];
    for (const args of argVariants) {
      const direct = this.tryCallPointerDirectWithDiag(
        targets,
        args,
        "objects.findByType direct",
        typeName,
      );
      if (direct) return direct;
    }
    return undefined;
  }

  private tryFindObject(
    typeName: string,
    type: ValueWrapper,
  ): ValueWrapper | undefined {
    const targets = this.getFindObjectTargets();
    this.plugin.diag("objects.findByType single candidates", {
      typeName,
      count: targets.length,
      targets,
    });
    const argVariants = [[type], [type, 0], [type, 1], [type, 0, 0]];
    for (const args of argVariants) {
      const direct = this.tryCallPointerDirectWithDiag(
        targets,
        args,
        "objects.findByType single direct",
        typeName,
      );
      if (direct) return direct;
      const managed = this.tryCallManagedReturnWithDiag(
        targets,
        args,
        "objects.findByType single managed",
        typeName,
      );
      if (managed) return managed;
    }
    return undefined;
  }

  private getFindObjectsTargets() {
    const dynamicMethods = this.plugin
      .findMethods("FindObjects")
      .filter(
        (method) =>
          method.tableIndex > 0 &&
          (method.typeName === "UnityEngine.Object" ||
            method.typeName === "UnityEngine.Resources" ||
            method.typeName.endsWith(".Object") ||
            method.typeName.endsWith(".Resources")),
      )
      .sort((a, b) => this.rankFindObjectsMethod(a.name) - this.rankFindObjectsMethod(b.name));
    this.plugin.diag("objects.findByType method metadata", dynamicMethods);
    const dynamicTargets = dynamicMethods
      .map((method) => `${method.typeName}$$${method.name}`);

    const fallbackTargets = ["UnityEngine.Object$$FindObjectsOfType_12890"];

    return [...new Set([...dynamicTargets, ...fallbackTargets])];
  }

  private rankFindObjectsMethod(name: string) {
    if (name.startsWith("FindObjectsOfTypeAll")) return 0;
    if (name.startsWith("FindObjectsByType")) return 1;
    if (name.startsWith("FindObjectsOfType")) return 2;
    return 10;
  }

  private getFindObjectTargets() {
    const dynamicMethods = this.plugin
      .findMethods("FindObject")
      .filter(
        (method) =>
          method.tableIndex > 0 &&
          (method.typeName === "UnityEngine.Object" ||
            method.typeName.endsWith(".Object")) &&
          method.name.startsWith("FindObject") &&
          !method.name.startsWith("FindObjects") &&
          !method.name.startsWith("FindObjectFromInstanceID"),
      )
      .sort((a, b) => this.rankFindObjectMethod(a.name) - this.rankFindObjectMethod(b.name));
    this.plugin.diag("objects.findByType single method metadata", dynamicMethods);
    const dynamicTargets = dynamicMethods
      .map((method) => `${method.typeName}$$${method.name}`);

    const fallbackTargets = ["UnityEngine.Object$$FindObjectOfType_12892"];

    return [...new Set([...dynamicTargets, ...fallbackTargets])];
  }

  private rankFindObjectMethod(name: string) {
    if (name.startsWith("FindObjectOfType")) return 0;
    if (name.startsWith("FindFirstObjectByType")) return 1;
    if (name.startsWith("FindAnyObjectByType")) return 2;
    return 10;
  }

  private typeString(targets: string[], type: ValueWrapper | number): string | null {
    const normalizedType = this.ptr(type);
    this.plugin.diag("objects.typeString start", {
      type: normalizedType,
      targets,
    });
    const result =
      this.tryCallReturn(targets, [type], "objects.typeString") ??
      this.tryCallReturn(targets, [type, 0], "objects.typeString fallback");
    if (!result || result.val() <= 0) return null;
    try {
      const value = result.mstr();
      this.plugin.diag("objects.typeString decoded", {
        type: normalizedType,
        result: result.val(),
        value,
      });
      return value;
    } catch (err) {
      this.plugin.diag("objects.typeString decode failed", {
        type: normalizedType,
        result: result.val(),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private getRuntimeTypeStringTargets(propertyName: string, fallback: string[]) {
    const dynamicTargets = this.plugin
      .findMethods(`get_${propertyName}`)
      .filter(
        (method) =>
          method.typeName === "System.RuntimeType" ||
          method.typeName === "System.Type" ||
          method.typeName === "System.Reflection.MemberInfo",
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((method) => `${method.typeName}$$${method.name}`);
    return [...new Set([...dynamicTargets, ...fallback])];
  }

  private pointerFromThrowable(err: unknown): number | undefined {
    if (typeof err === "number" && this.isLikelyPointer(err)) return err;
    if (typeof err === "string") {
      const value = Number(err.trim());
      if (this.isLikelyPointer(value)) return value;
    }
    return undefined;
  }

  private tryCallPointerDirectWithDiag(
    targets: string[],
    args: any[],
    label: string,
    typeName: string,
  ): ValueWrapper | undefined {
    for (const target of targets) {
      const normalizedArgs = args.map((arg) =>
        arg instanceof ValueWrapper ? arg.val() : arg,
      );
      try {
        const result = this.plugin.call(target, args);
        this.plugin.diag(label, {
          typeName,
          target,
          args: normalizedArgs,
          result: result?.val() ?? 0,
        });
        if (result && this.isLikelyPointer(result.val())) return result;
      } catch (err) {
        const thrownPointer = this.pointerFromThrowable(err);
        if (thrownPointer) {
          this.plugin.diag(`${label} threw pointer`, {
            typeName,
            target,
            args: normalizedArgs,
            result: thrownPointer,
            accepted: false,
          });
          continue;
        }
        this.plugin.diag(`${label} failed`, {
          typeName,
          target,
          args: normalizedArgs,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return undefined;
  }

  private tryCallManagedReturnWithDiag(
    targets: string[],
    args: any[],
    label: string,
    typeName: string,
  ): ValueWrapper | undefined {
    for (const target of targets) {
      const normalizedArgs = args.map((arg) =>
        arg instanceof ValueWrapper ? arg.val() : arg,
      );
      const result = this.plugin.alloc(4);
      try {
        result.writeField(0, "u32", 0);
        this.plugin.call(target, [result, ...args]);
        const ptr = result.readField(0, "u32")?.val() ?? 0;
        this.plugin.diag(label, {
          typeName,
          target,
          args: normalizedArgs,
          result: ptr,
        });
        if (this.isLikelyPointer(ptr)) return new ValueWrapper(ptr);
      } catch (err) {
        this.plugin.diag(`${label} failed`, {
          typeName,
          target,
          args: normalizedArgs,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        result.dispose();
      }
    }
    return undefined;
  }

  private tryCallReturnVariants(
    targets: string[],
    argVariants: any[][],
    diagLabel?: string,
  ): ValueWrapper | undefined {
    for (const args of argVariants) {
      const result = this.tryCallReturn(targets, args, diagLabel);
      if (result) return result;
    }
    return undefined;
  }

  private tryCallManagedReturnVariants(
    targets: string[],
    argVariants: any[][],
  ): ValueWrapper | undefined {
    for (const args of argVariants) {
      const result = this.tryCallManagedReturn(targets, args);
      if (result) return result;
    }
    return undefined;
  }

  private readObjectArray(array: ValueWrapper): ValueWrapper[] {
    const ptr = array.val();
    if (ptr <= 0) return [];
    const length = new ValueWrapper(ptr + 12).readField(0, "u32")?.val() ?? 0;
    if (length <= 0 || length > 0x100000) return [];
    const objects: ValueWrapper[] = [];
    for (let i = 0; i < length; i++) {
      const item = new ValueWrapper(ptr + 16 + i * 4)
        .readField(0, "u32")
        ?.val();
      if (item && item > 0) objects.push(new ValueWrapper(item));
    }
    return objects;
  }

  private readVector3Injected(
    method: string,
    transform: ValueWrapper | number,
  ) {
    const block = this.plugin.alloc(12);
    try {
      this.tryCall([method], [transform, block, 0]);
      return {
        x: block.readField(0, "f32")?.val() ?? 0,
        y: block.readField(4, "f32")?.val() ?? 0,
        z: block.readField(8, "f32")?.val() ?? 0,
      };
    } finally {
      block.dispose();
    }
  }

  private getTypeNameCandidates(typeName: string) {
    if (typeName.includes(",")) return [typeName];
    const shortName = typeName.startsWith("UnityEngine.")
      ? typeName
      : `UnityEngine.${typeName}`;
    const runtimeCandidates = this.plugin.getTypeNameCandidates(typeName);
    return [
      ...runtimeCandidates,
      typeName,
      `${typeName}, Assembly-CSharp`,
      `${typeName}, mscorlib`,
      `${typeName}, UnityEngine.CoreModule`,
      `${shortName}, UnityEngine.CoreModule`,
    ].filter(
      (candidate, index, candidates) => candidates.indexOf(candidate) === index,
    );
  }

  private ptr(value: ValueWrapper | number) {
    return value instanceof ValueWrapper ? value.val() : value;
  }
}

export class ValueWrapper {
  private static runtime: Runtime | undefined;
  private _result: number;

  constructor(result: number) {
    this._result = result;
  }

  public static bindRuntime(runtime: Runtime) {
    ValueWrapper.runtime = runtime;
  }

  public set(value: ValueWrapper | number) {
    this._result = value instanceof ValueWrapper ? value.val() : value;
  }

  public val(): number {
    return this._result;
  }

  public mstr() {
    const _game = ValueWrapper.getRuntime().getUnityInstance();
    const heap = _game.Module.HEAPU8;
    const view = new DataView(heap.buffer);
    const length = view.getInt32(this._result + 8, true);
    if (length < 0 || length > 0x100000) {
      throw new Error(`Invalid managed string length: ${length}`);
    }
    const byteOffset = this._result + 12;
    const byteLength = length * 2;
    if (byteOffset < 0 || byteOffset + byteLength > heap.byteLength) {
      throw new Error("Managed string points outside the wasm heap");
    }
    return new TextDecoder("utf-16le").decode(
      heap.slice(byteOffset, byteOffset + byteLength),
    );
  }

  public deref(): ValueWrapper | undefined {
    const val = this.readField(0, "u32")?.val();
    return val ? new ValueWrapper(val) : undefined;
  }

  public getClassName(): string | null {
    try {
      const _game = ValueWrapper.getRuntime().getUnityInstance();
      const classPtr = new DataView(
        _game.Module.HEAPU8.slice(this._result, this._result + 4).buffer,
      ).getUint32(0, true);
      let classNamePtr = new DataView(
        _game.Module.HEAPU8.slice(classPtr + 8, classPtr + 12).buffer,
      ).getUint32(0, true);
      const classNameReader = new BinaryReader(
        _game.Module.HEAPU8.slice(
          classNamePtr,
          classNamePtr + 128, // Assumed max length for a class name
        ).buffer,
      );
      return classNameReader.readNullTerminatedUTF8String();
    } catch {
      return null;
    }
  }

  public readField(offset: number, type: string) {
    const _game = ValueWrapper.getRuntime().getUnityInstance();
    const valAddress = this._result + offset;
    let valArray = _game.Module.HEAPU8.slice(
      valAddress,
      valAddress + (dataTypeSizes[type] || 4),
    );
    const reader = new BinaryReader(valArray.buffer);
    switch (type) {
      case "i32":
        return new ValueWrapper(reader.readInt32());
      case "f32":
        return new ValueWrapper(reader.readFloat());
      case "u8":
        return new ValueWrapper(reader.readUint8());
      case "u32":
        return new ValueWrapper(reader.readUint32());
    }
  }

  public readFieldByName(
    typeName: string,
    fieldName: string,
    dataType: string,
  ) {
    const field = ValueWrapper.getRuntime().getFieldInfo(typeName, fieldName);
    if (!field || field.offset < 0) {
      throw new Error(
        `Unable to resolve field offset for ${typeName}.${fieldName}`,
      );
    }
    return this.readField(field.offset, dataType);
  }

  public writeField(
    offset: number,
    type: string,
    value: ValueWrapper | number,
  ) {
    const _game = ValueWrapper.getRuntime().getUnityInstance();
    let size = dataTypeSizes[type];
    const writer = new BinaryWriter(new ArrayBuffer(size));
    if (value instanceof ValueWrapper) value = value.val();
    switch (type) {
      case "u8":
        writer.writeUint8(value);
        break;
      case "i32":
        writer.writeInt32(value);
        break;
      case "u32":
        writer.writeUint32(value);
        break;
      case "f32":
        writer.writeFloat(value);
        break;
    }
    writeUint8ArrayAtOffset(
      _game.Module.HEAPU8,
      writer.finalize(),
      this._result + offset,
    );
  }

  public writeFieldByName(
    typeName: string,
    fieldName: string,
    dataType: string,
    value: ValueWrapper | number,
  ) {
    const field = ValueWrapper.getRuntime().getFieldInfo(typeName, fieldName);
    if (!field || field.offset < 0) {
      throw new Error(
        `Unable to resolve field offset for ${typeName}.${fieldName}`,
      );
    }
    this.writeField(field.offset, dataType, value);
  }

  private static readUtf16Char(ptr: number, maxCodeUnits = 0x10000) {
    const _game = ValueWrapper.getRuntime().getUnityInstance();
    let buffer = new Uint16Array(_game.Module.HEAPU8.buffer);
    let offset = ptr / 2; // divide by 2 to convert from byte offset to character offset
    let subarray = [];
    let charCode = buffer[offset];

    while (charCode !== 0 && subarray.length < maxCodeUnits) {
      subarray.push(charCode);
      offset++;
      charCode = buffer[offset];
    }
    if (subarray.length >= maxCodeUnits) {
      throw new Error("UTF-16 string scan exceeded the maximum length");
    }

    let decoder = new TextDecoder("utf-16le");
    return decoder.decode(new Uint16Array(subarray));
  }

  private static getRuntime(): Runtime {
    if (ValueWrapper.runtime) return ValueWrapper.runtime;
    const runtime = getPageWindow().UnityWebModkit?.Runtime;
    if (!runtime) throw new Error("UnityWebModkit Runtime is not available");
    return runtime;
  }
}

export class ManagedAllocation extends ValueWrapper {
  public readonly size: number;
  private readonly runtime: Runtime;
  private disposed = false;

  constructor(ptr: number, size: number, runtime: Runtime) {
    super(ptr);
    this.size = size;
    this.runtime = runtime;
  }

  public dispose() {
    if (this.disposed) return;
    this.runtime.releaseAllocation(this);
    this.disposed = true;
  }
}

export class ClassWrapper {
  protected readonly ptr: ValueWrapper;
  protected readonly typeName: string;

  constructor(ptr: ValueWrapper | number, typeName: string) {
    this.ptr = ptr instanceof ValueWrapper ? ptr : new ValueWrapper(ptr);
    this.typeName = typeName;
  }

  public val() {
    return this.ptr.val();
  }

  public readFieldByName(fieldName: string, dataType: string) {
    return this.ptr.readFieldByName(this.typeName, fieldName, dataType);
  }

  public writeFieldByName(
    fieldName: string,
    dataType: string,
    value: ValueWrapper | number,
  ) {
    this.ptr.writeFieldByName(this.typeName, fieldName, dataType, value);
  }
}
