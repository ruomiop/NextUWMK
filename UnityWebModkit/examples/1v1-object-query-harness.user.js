// ==UserScript==
// @name        1v1Recteloaded Object Query Harness
// @namespace   Violentmonkey Scripts
// @match       *://1v1lolreloaded.com/index.html*
// @version     1.0
// @author      -
// @run-at      document-start
// @grant       unsafeWindow
// @grant       GM_xmlhttpRequest
// @connect     127.0.0.1
// @connect     localhost
// @require     https://raw.githubusercontent.com/ruomiop/NextUWMK/refs/heads/main/UnityWebModkit/dist/unity-web-modkit.95ad200af3b9fa9c3ef0.js
// ==/UserScript==

(function () {
  "use strict";

  const root = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const HARNESS_URL = "http://127.0.0.1:18777/log";

  function simplify(value, depth = 0) {
    if (value === undefined) return { undefined: true };
    if (value == null) return value;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (typeof value.val === "function") {
      try {
        return { ptr: value.val() };
      } catch {
        return "[ValueWrapper]";
      }
    }
    if (depth >= 4) return "[MaxDepth]";
    if (Array.isArray(value)) return value.slice(0, 80).map((item) => simplify(item, depth + 1));
    if (typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).slice(0, 80)) out[key] = simplify(value[key], depth + 1);
      return out;
    }
    return String(value);
  }

  function resultPayload(value) {
    return {
      value: simplify(value),
      isUndefined: value === undefined,
      isNull: value === null,
    };
  }

  function post(level, stage, message, data) {
    const body = JSON.stringify({
      level,
      stage,
      message,
      data: simplify(data),
      href: location.href,
      at: Date.now(),
    });

    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({
        method: "POST",
        url: HARNESS_URL,
        headers: { "content-type": "application/json" },
        data: body,
      });
      return;
    }

    fetch(HARNESS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }).catch(() => {});
  }

  function info(stage, message, data) {
    console.log(`[ObjectQueryHarness] ${stage}: ${message}`, data || "");
    post("info", stage, message, data);
  }

  function warn(stage, message, data) {
    console.warn(`[ObjectQueryHarness] ${stage}: ${message}`, data || "");
    post("warn", stage, message, data);
  }

  function error(stage, message, data) {
    console.error(`[ObjectQueryHarness] ${stage}: ${message}`, data || "");
    post("error", stage, message, data);
  }

  function runStep(stage, fn) {
    try {
      const result = fn();
      info(stage, "ok", resultPayload(result));
      return result;
    } catch (err) {
      error(stage, "threw", {
        name: err && err.name,
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack,
      });
      return undefined;
    }
  }

  function ptr(value) {
    return value && typeof value.val === "function" ? value.val() : 0;
  }

  function runObjectQuerySmoke(ctx) {
    info("metadata", "loaded", ctx.metadata);

    runStep("methods.typeHandle", () => ({
      getTypeFromHandle: ctx.findMethods("GetTypeFromHandle"),
      internalFromHandle: ctx.findMethods("internal_from_handle"),
      typeGetType: ctx.findMethods("GetType").filter((m) => m.typeName === "System.Type"),
    }));

    runStep("methods.objectQuery", () => ({
      findObject: ctx.findMethods("FindObject"),
      findObjects: ctx.findMethods("FindObjects"),
      getTransform: ctx.findMethods("get_transform"),
      getGameObject: ctx.findMethods("get_gameObject"),
      getName: ctx.findMethods("get_name"),
    }));

    const gameObjectType = runStep("type.gameObject", () =>
      ctx.objects.resolveType("UnityEngine.GameObject"),
    );
    const playerControllerTypes = runStep("metadata.playerController", () =>
      ctx.findTypes("PlayerController"),
    );
    const playerControllerType = runStep("type.playerController", () =>
      ctx.objects.resolveType("PlayerController"),
    );

    runStep("compare.types", () => ({
      gameObjectResult: gameObjectType && gameObjectType.result,
      playerControllerResult: playerControllerType && playerControllerType.result,
      same:
        Boolean(gameObjectType && playerControllerType) &&
        gameObjectType.result === playerControllerType.result,
    }));

    const gameObjects = runStep("find.gameObjects", () =>
      ctx.objects.findByType("UnityEngine.GameObject"),
    ) || [];
    info("find.gameObjects.summary", "count", {
      count: gameObjects.length,
      first: gameObjects.slice(0, 10).map(ptr),
    });

    const players = runStep("find.playerControllers", () =>
      ctx.objects.findByType("PlayerController"),
    ) || [];
    root.firstPlayer = players[0];
    root.__uwmkHarnessPlayers = players;
    info("find.playerControllers.summary", "count", {
      metadataTypes: playerControllerTypes,
      count: players.length,
      first: players.slice(0, 10).map(ptr),
    });

    if (!players[0]) {
      warn("player.first", "missing");
      return;
    }

    runStep("player.name", () => ctx.objects.name(players[0]));
    const gameObject = runStep("player.gameObject", () => ctx.objects.gameObject(players[0]));
    root.firstPlayerGameObject = gameObject;
    runStep("player.gameObject.name", () => gameObject && ctx.objects.name(gameObject));

    const transform = runStep("player.transform", () => ctx.objects.transform(players[0]));
    root.firstPlayerTransform = transform;
    runStep("player.transform.name", () => transform && ctx.objects.name(transform));
    runStep("player.position", () => transform && ctx.objects.position(transform));
    runStep("player.childCount", () => transform && ctx.objects.childCount(transform));
    runStep("player.tree", () =>
      transform
        ? ctx.objects.dumpTree(transform, {
            depth: 3,
            includePosition: true,
          })
        : null,
    );
  }

  const UWM = root.UnityWebModkit;
  if (!UWM || !UWM.Runtime) {
    error("bootstrap", "UnityWebModkit missing");
    return;
  }

  root.ctx = UWM.Runtime.createPlugin({
    name: "ObjectQueryHarness",
    version: "1.0.0",
    globalName: "ctx",
    referencedAssemblies: [
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
    ],
  });

  root.ctx.onReady = () => {
    info("plugin", "ready");
    setTimeout(() => runObjectQuerySmoke(root.ctx), 1000);
  };

  root.ctx.onLoaded = () => {
    info("plugin", "loaded");
  };
})();
