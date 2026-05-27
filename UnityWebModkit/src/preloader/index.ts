import { Logger } from "../logger";
import { WebData } from "../web-data";
import { version } from "../mod";

const logger = new Logger("Preloader");

export function preload(): Promise<WebData> {
  const page = getPageWindow();
  announcePreloader();
  installUnityInstanceInterceptor();
  installFetchDataInterceptor();
  installXhrDataInterceptor();
  if (page.__UnityWebModkitClearUnityCache) {
    clearUnityCache().catch((err) =>
      logger.warn("Unable to clear Unity cache before preload: %o", err),
    );
  }
  return loadWebData();
}

function announcePreloader() {
  const page = getPageWindow();
  if (page.__UnityWebModkitPreloaderAnnounced) return;
  page.__UnityWebModkitPreloaderAnnounced = true;
  logger.info("UnityWebModkit v%s - %s", version, page.location.hostname);
  // @ts-ignore Set by webpack at bundle time
  logger.info("Build hash: %s", __webpack_hash__);
}

export function watchUnityWebData(
  onWebData: (webData: WebData) => void,
  onUnityCandidate?: () => void,
): void {
  const page = getPageWindow();
  installUnityInstanceInterceptor();
  registerWebDataCallback(onWebData);
  if (onUnityCandidate) registerUnityCandidateCallback(onUnityCandidate);
  installFetchDataInterceptor();
  installXhrDataInterceptor();
}

function loadWebData(): Promise<WebData> {
  logger.debug("Trying to load Unity web data from indexedDB cache");
  return new Promise<WebData>(async (resolve) => {
    const cachedWebData = await probeUnityWebDataFromCache().catch((err) => {
      logger.debug("Unity indexedDB cache probe failed: %o", err);
      return undefined;
    });
    if (cachedWebData) {
      resolve(cachedWebData);
      return;
    }
    resolve(await fallbackInterceptFetch());
  });
}

export async function probeUnityWebDataFromCache(): Promise<
  WebData | undefined
> {
  const page = getPageWindow();
  const cacheStorageWebData = await loadWebDataFromCacheStorage();
  if (cacheStorageWebData) {
    page.__UnityWebModkitWebData = cacheStorageWebData;
    notifyWebDataCallbacks(cacheStorageWebData);
    return cacheStorageWebData;
  }

  if (!("indexedDB" in page) || !("databases" in page.indexedDB))
    return undefined;

  const databases: IDBDatabaseInfo[] = await page.indexedDB.databases();
  const unityCache = databases.findIndex((d) => d.name === "UnityCache");
  if (unityCache == -1) return undefined;

  return new Promise<WebData | undefined>((resolve) => {
    const request = page.indexedDB.open("UnityCache");
    request.onerror = () => resolve(undefined);
    request.onsuccess = (event: any) => {
      const db = event.target.result;
      const objectStores = Array.from(db.objectStoreNames as any) as string[];
      const storesToProbe = objectStores.includes("RequestStore")
        ? ["RequestStore"]
        : objectStores.filter((name) =>
            /request|xhr|xmlhttprequest|data/i.test(name),
          );

      if (storesToProbe.length === 0) {
        db.close();
        resolve(undefined);
        return;
      }

      let remainingStores = storesToProbe.length;
      const finishStore = () => {
        remainingStores--;
        if (remainingStores <= 0) {
          db.close();
          resolve(undefined);
        }
      };

      for (const storeName of storesToProbe) {
        let requestCacheEntries;
        try {
          requestCacheEntries = db
            .transaction([storeName], "readonly")
            .objectStore(storeName)
            .getAll();
        } catch {
          finishStore();
          return;
        }
        requestCacheEntries.onsuccess = async (event: any) => {
          const entries = event.target.result;
          for (const entry of entries) {
            const buffers = await extractArrayBuffers(entry);
            for (const data of buffers) {
              const parsed = await tryParseWebData(
                data,
                `UnityCache indexedDB ${storeName}`,
              );
              if (parsed) {
                page.__UnityWebModkitWebData = parsed;
                notifyWebDataCallbacks(parsed);
                db.close();
                resolve(parsed);
                return;
              }
            }
          }
          finishStore();
        };
        requestCacheEntries.onerror = () => {
          finishStore();
        };
      }
    };
  });
}

async function fallbackInterceptFetch(): Promise<WebData> {
  const page = getPageWindow();
  logger.debug(
    "Nothing in indexedDB cache, resorting to hooking Fetch/XHR API",
  );
  return new Promise<WebData>((resolve) => {
    let resolved = false;
    const resolveOnce = async (
      data: ArrayBuffer,
      source = "intercepted Unity data",
    ) => {
      if (resolved) return;
      const parsed = await tryParseWebData(data, source);
      if (!parsed) return;
      resolved = true;
      resolve(parsed);
    };

    const originalFetch = page.fetch;
    page.fetch = async function (input: RequestInfo | URL) {
      if (isUnityDataUrl(input)) {
        const response = await originalFetch.apply(this, arguments as any);
        try {
          if (page.__UnityWebModkitWebData) {
            resolved = true;
            resolve(page.__UnityWebModkitWebData);
          } else if (page.__UnityWebModkitWebDataPromise) {
            const parsed = await page.__UnityWebModkitWebDataPromise;
            if (parsed) {
              resolved = true;
              resolve(parsed);
            }
          } else {
            await resolveOnce(
              await response.clone().arrayBuffer(),
              "fallback fetch",
            );
          }
          if (resolved) page.fetch = originalFetch;
        } catch (err) {
          logger.warn("Failed to inspect fallback fetch response: %o", err);
        }
        return response;
      }
      return originalFetch.apply(this, arguments as any);
    };

    installXhrDataInterceptor(resolveOnce);
  });
}

function registerWebDataCallback(callback: (webData: WebData) => void) {
  const page = getPageWindow();
  const callbacks: Array<(webData: WebData) => void> =
    page.__UnityWebModkitWebDataCallbacks || [];
  callbacks.push(callback);
  page.__UnityWebModkitWebDataCallbacks = callbacks;
}

function registerUnityCandidateCallback(callback: () => void) {
  const page = getPageWindow();
  const callbacks: Array<() => void> =
    page.__UnityWebModkitUnityCandidateCallbacks || [];
  callbacks.push(callback);
  page.__UnityWebModkitUnityCandidateCallbacks = callbacks;
}

function markUnityCandidateSeen() {
  const page = getPageWindow();
  if (page.__UnityWebModkitUnityCandidateSeen) return;
  page.__UnityWebModkitUnityCandidateSeen = true;
  announcePreloader();
  const callbacks: Array<() => void> =
    page.__UnityWebModkitUnityCandidateCallbacks || [];
  callbacks.forEach((callback) => {
    try {
      callback();
    } catch (err) {
      logger.warn("Unity candidate callback failed: %o", err);
    }
  });
}

function notifyWebDataCallbacks(webData: WebData) {
  const page = getPageWindow();
  announcePreloader();
  const callbacks: Array<(webData: WebData) => void> =
    page.__UnityWebModkitWebDataCallbacks || [];
  callbacks.forEach((callback) => {
    try {
      callback(webData);
    } catch (err) {
      logger.warn("Unity web data callback failed: %o", err);
    }
  });
}

function installUnityInstanceInterceptor() {
  const page = getPageWindow();
  if (page.__UnityWebModkitCreateUnityInstancePatched) return;
  page.__UnityWebModkitCreateUnityInstancePatched = true;

  const capture = (instance: any) => {
    if (!instance) return instance;
    markUnityCandidateSeen();
    page.__UnityWebModkitUnityInstance = instance;
    return instance;
  };

  const wrap = (fn: any) => {
    if (typeof fn !== "function" || fn.__unityWebModkitPatched) return fn;
    const wrapped = function (this: any, ...args: any[]) {
      markUnityCandidateSeen();
      const result = fn.apply(this, args);
      Promise.resolve(result)
        .then(capture)
        .catch(() => undefined);
      return result;
    };
    wrapped.__unityWebModkitPatched = true;
    return wrapped;
  };

  let current = page.createUnityInstance;
  try {
    Object.defineProperty(page, "createUnityInstance", {
      configurable: true,
      get() {
        return current;
      },
      set(next) {
        current = wrap(next);
      },
    });
    current = wrap(current);
  } catch {
    // Some pages define createUnityInstance as non-configurable; a short poll
    // still catches normal Unity loader assignment before startup.
  }

  const timer = page.setInterval(() => {
    if (typeof page.createUnityInstance === "function") {
      page.createUnityInstance = wrap(page.createUnityInstance);
    }
  }, 25);
  page.setTimeout(() => page.clearInterval(timer), 30000);
}

function installFetchDataInterceptor() {
  const page = getPageWindow();
  const originalFetch = page.fetch;
  if ((originalFetch as any).__unityWebModkitPatched) return;

  const patchedFetch = async function (
    this: any,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    const response = await originalFetch.apply(this, arguments as any);
    if (isUnityDataUrl(input)) {
      markUnityCandidateSeen();
      page.__UnityWebModkitWebDataPromise = response
        .clone()
        .arrayBuffer()
        .then((data: ArrayBuffer) => tryParseWebData(data, "intercepted fetch"))
        .then((parsed: WebData | undefined) => {
          if (parsed) {
            page.__UnityWebModkitWebData = parsed;
            notifyWebDataCallbacks(parsed);
          }
          return parsed;
        })
        .catch((err: unknown) =>
          logger.warn("Failed to inspect intercepted Unity data: %o", err),
        );
    }
    return response;
  };
  (patchedFetch as any).__unityWebModkitPatched = true;
  page.fetch = patchedFetch as typeof page.fetch;
}

function installXhrDataInterceptor(onData?: (data: ArrayBuffer) => void) {
  const page = getPageWindow();
  const proto = page.XMLHttpRequest.prototype as any;
  if (proto.__unityWebModkitXhrPatched) {
    if (onData) {
      const callbacks: Array<(data: ArrayBuffer) => void> =
        page.__UnityWebModkitXhrDataCallbacks || [];
      callbacks.push(onData);
      page.__UnityWebModkitXhrDataCallbacks = callbacks;
    }
    return;
  }

  const callbacks: Array<(data: ArrayBuffer) => void> = [];
  if (onData) callbacks.push(onData);
  page.__UnityWebModkitXhrDataCallbacks = callbacks;

  const originalOpen = proto.open;
  const originalSend = proto.send;

  proto.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    this.__unityWebModkitUrl = typeof url === "string" ? url : url.href;
    return originalOpen.apply(this, arguments as any);
  };

  proto.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const xhr = this as XMLHttpRequest & { __unityWebModkitUrl?: string };
    if (xhr.__unityWebModkitUrl && isUnityDataUrl(xhr.__unityWebModkitUrl)) {
      markUnityCandidateSeen();
      xhr.addEventListener("load", async () => {
        try {
          let data: ArrayBuffer | undefined;
          if (xhr.response instanceof ArrayBuffer) {
            data = xhr.response;
          } else if (xhr.response && ArrayBuffer.isView(xhr.response)) {
            data = xhr.response.buffer.slice(
              xhr.response.byteOffset,
              xhr.response.byteOffset + xhr.response.byteLength,
            );
          }
          if (!data) return;
          const parsed = await tryParseWebData(data, "intercepted XHR");
          if (!parsed) return;
          page.__UnityWebModkitWebData = parsed;
          notifyWebDataCallbacks(parsed);
          const activeCallbacks: Array<(buffer: ArrayBuffer) => void> =
            page.__UnityWebModkitXhrDataCallbacks || [];
          activeCallbacks.splice(0).forEach((callback) => callback(data!));
        } catch (err) {
          logger.warn("Failed to inspect intercepted Unity XHR data: %o", err);
        }
      });
    }
    return originalSend.apply(this, arguments as any);
  };

  proto.__unityWebModkitXhrPatched = true;
}

function isUnityDataUrl(input: RequestInfo | URL) {
  const url =
    typeof input === "string"
      ? input
      : (input as URL).href || (input as Request).url;
  return /\.data(\.|$)/i.test(url) || url.includes("webgl.data.br");
}

async function clearUnityCache() {
  const page = getPageWindow();
  if ("caches" in page) {
    const keys = await page.caches.keys();
    await Promise.all(
      keys
        .filter(
          (key: string) =>
            key === "UnityCache" || key.toLowerCase().includes("unity"),
        )
        .map((key: string) => page.caches.delete(key)),
    );
  }

  if ("indexedDB" in page && "databases" in page.indexedDB) {
    const databases = await page.indexedDB.databases();
    await Promise.all(
      databases
        .map((db: IDBDatabaseInfo) => db.name)
        .filter(
          (name: string | undefined): name is string =>
            !!name && name.includes("UnityCache"),
        )
        .map(
          (name: string) =>
            new Promise<void>((resolve) => {
              const request = page.indexedDB.deleteDatabase(name);
              request.onsuccess = () => resolve();
              request.onerror = () => resolve();
              request.onblocked = () => resolve();
            }),
        ),
    );
  }
}

function parseWebData(data: ArrayBuffer): WebData {
  return new WebData(data, [
    ["data.unity3d", 32],
    ["Il2CppData/Metadata/global-metadata.dat"],
  ]);
}

async function tryParseWebData(
  data: ArrayBuffer,
  source: string,
): Promise<WebData | undefined> {
  data = await decompressUnityWebData(data, source);
  if (!isPotentialWebData(data)) return undefined;
  try {
    return parseWebData(data);
  } catch (err) {
    logger.warn("Failed to parse %s: %o", source, err);
    return undefined;
  }
}

async function loadWebDataFromCacheStorage(): Promise<WebData | undefined> {
  const page = getPageWindow();
  if (!("caches" in page)) return undefined;

  try {
    const keys = await page.caches.keys();
    for (const key of keys) {
      if (key !== "UnityCache" && !key.toLowerCase().includes("unity"))
        continue;
      const cache = await page.caches.open(key);
      const requests = await cache.keys();
      for (const request of requests) {
        if (!isUnityDataUrl(request.url)) continue;
        const response = await cache.match(request);
        if (!response) continue;
        const data = await response.clone().arrayBuffer();
        const parsed = await tryParseWebData(data, `CacheStorage ${key}`);
        if (parsed) return parsed;
      }
    }
  } catch (err) {
    logger.warn("Unable to read Unity web data from CacheStorage: %o", err);
  }

  return undefined;
}

async function decompressUnityWebData(
  data: ArrayBuffer,
  source: string,
): Promise<ArrayBuffer> {
  if (!isGzip(data)) return data;
  const DecompressionStreamCtor = (getPageWindow() as any).DecompressionStream;
  if (typeof DecompressionStreamCtor !== "function") {
    logger.warn(
      "Unable to decompress gzip Unity data from %s: DecompressionStream is unavailable",
      source,
    );
    return data;
  }
  try {
    const stream = new Blob([data])
      .stream()
      .pipeThrough(new DecompressionStreamCtor("gzip"));
    const decompressed = await new Response(stream).arrayBuffer();
    logger.debug(
      "Decompressed gzip Unity data from %s: %d -> %d bytes",
      source,
      data.byteLength,
      decompressed.byteLength,
    );
    return decompressed;
  } catch (err) {
    logger.warn(
      "Failed to decompress gzip Unity data from %s: %o",
      source,
      err,
    );
    return data;
  }
}

function isGzip(data: ArrayBuffer): boolean {
  if (data.byteLength < 2) return false;
  const bytes = new Uint8Array(data, 0, 2);
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isPotentialWebData(data: ArrayBuffer): boolean {
  if (data.byteLength < 20) return false;
  const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 16));
  const signature = "UnityWebData";
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature.charCodeAt(i)) return false;
  }
  return true;
}

function toArrayBuffer(data: any): ArrayBuffer | undefined {
  if (!data) return undefined;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );
  }
  if (data.buffer instanceof ArrayBuffer) {
    return data.buffer.slice(
      data.byteOffset || 0,
      (data.byteOffset || 0) + (data.byteLength || data.buffer.byteLength),
    );
  }
  return undefined;
}

async function extractArrayBuffers(entry: any): Promise<ArrayBuffer[]> {
  const buffers: ArrayBuffer[] = [];
  const seen = new Set<any>();
  const queue = [
    entry,
    entry?.xhr,
    entry?.xhr?.response,
    entry?.xhr?.responseText,
    entry?.xhr?.responseBody,
    entry?.response,
    entry?.response?.parsedBody,
    entry?.response?.body,
    entry?.parsedBody,
    entry?.body,
    entry?.data,
    entry?.value,
  ];

  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || seen.has(value)) continue;
    seen.add(value);

    const buffer = toArrayBuffer(value);
    if (buffer) {
      buffers.push(buffer);
      continue;
    }

    if (value instanceof Blob) {
      buffers.push(await value.arrayBuffer());
      continue;
    }

    if (typeof Response !== "undefined" && value instanceof Response) {
      buffers.push(await value.clone().arrayBuffer());
      continue;
    }

    if (typeof value === "object") {
      for (const key of [
        "response",
        "parsedBody",
        "body",
        "data",
        "value",
        "buffer",
        "result",
      ]) {
        if (value[key]) queue.push(value[key]);
      }
    }
  }

  return buffers;
}

function getPageWindow(): any {
  return (globalThis as any).unsafeWindow || window;
}
