export const isolatedFrameBootstrap = String.raw`
(() => {
  "use strict";
  const protocol = "codex.browser-addon/1";
  const tagPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
  let connected = false;

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (connected || event.source !== window.parent || event.ports.length !== 1 ||
      typeof data !== "object" || data === null || data.protocol !== protocol ||
      data.type !== "connect" || Object.keys(data).length !== 2) {
      return;
    }
    connected = true;
    waitForActivation(event.ports[0]);
  });

  function waitForActivation(port) {
    const receive = (event) => {
      const data = event.data;
      if (typeof data === "object" && data !== null && data.protocol === protocol &&
        data.type === "revoke") {
        port.removeEventListener("message", receive);
        port.close();
        return;
      }
      if (typeof data !== "object" || data === null || data.protocol !== protocol ||
        data.type !== "activate" || typeof data.moduleSource !== "string" ||
        !Array.isArray(data.styleSources) ||
        !data.styleSources.every((value) => typeof value === "string") ||
        !Array.isArray(data.declarations) || typeof data.contribution !== "object" ||
        data.contribution === null || typeof data.contribution.id !== "string") {
        return;
      }
      port.removeEventListener("message", receive);
      void activate(data, port);
    };
    port.addEventListener("message", receive);
    port.start();
  }

  function requireJSON(value, depth = 0, ancestors = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || depth > 20 || ancestors.has(value)) {
      throw new Error("The isolated callback result must be bounded JSON.");
    }
    const next = new Set(ancestors);
    next.add(value);
    if (Array.isArray(value)) {
      if (value.length > 1000) throw new Error("The isolated callback result is too large.");
      for (const item of value) requireJSON(item, depth + 1, next);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    const keys = Object.keys(value);
    if ((prototype !== Object.prototype && prototype !== null) || keys.length > 1000 ||
      Reflect.ownKeys(value).length !== keys.length) {
      throw new Error("The isolated callback result must contain plain JSON objects.");
    }
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error("The isolated callback result contains a forbidden key.");
      }
      requireJSON(value[key], depth + 1, next);
    }
  }

  async function activate(data, port) {
    const controller = new AbortController();
    const capabilitySet = new Set(data.capabilities);
    const permissionMap = new Map(data.permissions.map((grant) => [grant.id, [...grant.resources]]));
    const declarations = Object.freeze([...data.declarations]);
    const handles = new Map();
    const invocations = new Map();
    const root = document.getElementById("codex-addon-root");
    let moduleDisposable;
    let observer;
    let revoked = false;

    const post = (message) => {
      if (!revoked) {
        const envelope = { protocol, ...message };
        const encoded = JSON.stringify(envelope);
        if (typeof encoded !== "string" || new TextEncoder().encode(encoded).byteLength > 64 * 1024) {
          throw new Error("The isolated bridge message exceeds 64 KiB.");
        }
        port.postMessage(envelope);
      }
    };
    const report = (cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      const bounded = message.slice(0, 500) || "isolated activation failed";
      post({ type: "diagnostic", message: bounded });
      return bounded;
    };
    const requireActive = () => {
      if (revoked || controller.signal.aborted) {
        throw new DOMException("The add-on generation is no longer active.", "AbortError");
      }
    };
    const capabilities = Object.freeze({
      has: (capability) => !revoked && capabilitySet.has(capability),
      require: (capability) => {
        requireActive();
        if (!capabilitySet.has(capability)) {
          throw new Error("Browser capability " + capability + " is unavailable.");
        }
      },
    });
    const permissions = Object.freeze({
      has: (permission, resource) => {
        if (revoked) return false;
        const resources = permissionMap.get(permission);
        return resources !== undefined && (resource === undefined || resources.includes(resource));
      },
      resources: (permission) => revoked ? [] : Object.freeze([...(permissionMap.get(permission) || [])]),
      require: (permission, resource) => {
        requireActive();
        if (!permissions.has(permission, resource)) {
          throw new Error("Browser permission " + permission + " is unavailable.");
        }
      },
    });
    const ui = Object.freeze({
      declarations: () => {
        requireActive();
        return declarations;
      },
      bind: (contributionId, binding) => {
        requireActive();
        const declaration = declarations.find((candidate) => candidate.id === contributionId);
        if (declaration === undefined || handles.has(contributionId) ||
          typeof binding !== "object" || binding === null) {
          throw new Error("The isolated UI binding is invalid.");
        }
        const expected = declaration.surface === "article-action"
          ? "action"
          : declaration.surface === "graph-view" || declaration.surface === "graph-contributor"
            ? "model-provider"
            : "element";
        const valid = expected === "element"
          ? binding.kind === "element" && typeof binding.tag === "string" && tagPattern.test(binding.tag)
          : expected === "action"
            ? binding.kind === "action" && typeof binding.run === "function"
            : binding.kind === "model-provider" && typeof binding.provide === "function";
        if (!valid) {
          throw new Error("The isolated UI binding does not match its declared surface.");
        }
        let element;
        if (expected === "element") {
          element = document.createElement(binding.tag);
          element.codexContribution = Object.freeze({
            addon: data.addon,
            contribution: declaration,
            signal: controller.signal,
          });
          root.replaceChildren(element);
        }
        let disposed = false;
        const handle = Object.freeze({
          descriptor: declaration,
          dispose: () => {
            if (disposed) return;
            disposed = true;
            handles.delete(contributionId);
            if (element && element.parentNode === root) element.remove();
            if (!revoked) {
              post({ type: "unavailable", contributionId });
            }
          },
        });
        handles.set(contributionId, { binding, handle });
        return handle;
      },
    });
    const context = Object.freeze({
      addon: Object.freeze(data.addon),
      signal: controller.signal,
      capabilities,
      permissions,
      ui,
    });

    const revoke = async (reason) => {
      if (revoked) return;
      revoked = true;
      controller.abort(reason);
      observer?.disconnect();
      for (const invocation of invocations.values()) invocation.abort(reason);
      invocations.clear();
      for (const entry of [...handles.values()]) entry.handle.dispose();
      try {
        await moduleDisposable?.dispose?.();
      } catch (_) {
        // The host already revoked authority; cleanup remains best effort here.
      }
      port.close();
    };
    const invoke = async (message) => {
      const id = message.id;
      const contributionId = message.contributionId;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
        typeof contributionId !== "string" || contributionId !== data.contribution.id ||
        invocations.has(id) || invocations.size >= 32) {
        return;
      }
      const entry = handles.get(contributionId);
      if (entry === undefined) {
        post({
          type: "result",
          id,
          ok: false,
          error: { code: "ADDON_ERROR", message: "The contribution is not bound." },
        });
        return;
      }
      const invocation = new AbortController();
      invocations.set(id, invocation);
      try {
        const signal = AbortSignal.any([controller.signal, invocation.signal]);
        const result = entry.binding.kind === "action"
          ? await entry.binding.run(message.request, { signal })
          : await entry.binding.provide(message.request, { signal });
        const normalized = result === undefined ? null : result;
        requireJSON(normalized);
        post({ type: "result", id, ok: true, result: normalized });
      } catch (cause) {
        const message = invocation.signal.aborted
          ? "The host cancelled this contribution request."
          : (cause instanceof Error ? cause.message : String(cause));
        try {
          post({
            type: "result",
            id,
            ok: false,
            error: { code: "ADDON_ERROR", message: message.slice(0, 500) || "Add-on callback failed." },
          });
        } catch (reportCause) {
          report(reportCause);
        }
      } finally {
        invocations.delete(id);
      }
    };
    port.addEventListener("message", (event) => {
      const message = event.data;
      if (typeof message !== "object" || message === null || message.protocol !== protocol) {
        return;
      }
      if (message.type === "revoke") {
        void revoke(typeof message.reason === "string" ? message.reason : "authority-changed");
      } else if (message.type === "cancel" && typeof message.id === "string") {
        invocations.get(message.id)?.abort("host-cancelled");
      } else if (message.type === "invoke") {
        void invoke(message);
      }
    });
    port.start();
    window.addEventListener("pagehide", () => {
      try {
        post({ type: "unavailable", contributionId: data.contribution.id });
      } catch (_) {
        // The document is already leaving; the host timeout remains a fallback.
      }
    }, { once: true });

    try {
      for (const source of data.styleSources) {
        const style = document.createElement("style");
        style.textContent = source;
        document.head.append(style);
      }
      const moduleURL = URL.createObjectURL(new Blob([data.moduleSource], { type: "text/javascript" }));
      let loaded;
      try {
        loaded = await import(moduleURL);
      } finally {
        URL.revokeObjectURL(moduleURL);
      }
      if (typeof loaded !== "object" || loaded === null || typeof loaded.activate !== "function") {
        throw new TypeError("The isolated module must export activate(context).");
      }
      moduleDisposable = await loaded.activate(context);
      if (moduleDisposable !== undefined &&
        (typeof moduleDisposable !== "object" || moduleDisposable === null ||
          typeof moduleDisposable.dispose !== "function")) {
        throw new TypeError("activate(context) must return { dispose() } or undefined.");
      }
      if (!handles.has(data.contribution.id)) {
        throw new TypeError("The isolated module did not bind its contribution.");
      }
      if (handles.get(data.contribution.id).binding.kind === "element") {
        const resize = () => {
          const height = Math.max(120, Math.min(2400, Math.ceil(document.documentElement.scrollHeight)));
          post({ type: "resize", height });
        };
        observer = new ResizeObserver(resize);
        observer.observe(document.documentElement);
        resize();
      }
      post({ type: "ready", contributionId: data.contribution.id });
    } catch (cause) {
      const message = report(cause);
      post({ type: "failed", message });
    }
  }
})();
`;
