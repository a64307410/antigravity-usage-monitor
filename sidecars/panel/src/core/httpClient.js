/**
 * @fileoverview Async HTTP client with AbortController cancellation for stale
 * polling requests, concurrent GET deduplication, and dual-mode transport
 * (Sidecar Webview `window.sidecar.fetch` + Main Window Loopback Bridge).
 */

import {
  LOCAL_ENDPOINT_ID,
  WINDOW_BRIDGE_ENDPOINT_HEADER,
  WINDOW_BRIDGE_ENDPOINT_KEY,
  readInjectedWindowBridge,
} from '../../shared/window-bridge-protocol.mjs';

const inFlightGets = new Map();
const activeControllers = new Map();

export function abortSidecarApiKey(abortKey) {
  if (!abortKey) return;
  const prev = activeControllers.get(abortKey);
  if (prev) {
    activeControllers.delete(abortKey);
    prev.abort();
  }
}

/**
 * 读取主窗口双栖模式下注入的本地桥接配置（`port`、`token`、`bundleVersion`、`stylesCss`）。
 *
 * @returns {{ port: number, token: string, bundleVersion?: string, stylesCss?: string } | null}
 */
export function getWindowBridgeConfig() {
  const br = readInjectedWindowBridge();
  const port = Number(br?.port || 0);
  if (br && Number.isInteger(port) && port > 0 && typeof br.token === 'string' && br.token) {
    return br;
  }
  return null;
}

/**
 * 判断当前脚本是否以双栖悬浮模式运行在宿主主聊天窗口内（而非右侧辅助栏 Webview）。
 *
 * @returns {boolean}
 */
export function isWindowOverlayMode() {
  if (typeof window === 'undefined') return false;
  if (window.sidecar?.fetch) return false;
  return Boolean(getWindowBridgeConfig());
}

/**
 * 接收 Sidecar 通过 CDP `Runtime.evaluate` 批量投递的 RPC 响应，完成因 CSP/代理解除 HTTP 直连时的兜底请求。
 *
 * @param {Array<{ id: string, ok: boolean, status?: number, data?: any, error?: string }>} responses
 * @returns {number}
 */
export function deliverCdpBridgeResponses(responses) {
  const br = getWindowBridgeConfig();
  if (!br || !(br.rpcPending instanceof Map) || !Array.isArray(responses)) return 0;
  let delivered = 0;
  for (const item of responses) {
    const entry = br.rpcPending.get(item?.id);
    if (!entry) continue;
    br.rpcPending.delete(item.id);
    delivered += 1;
    if (item.ok) {
      entry.resolve(item.data);
    } else {
      entry.reject(new Error(item.error || `HTTP ${item.status || 500}`));
    }
  }
  return delivered;
}

function callViaCdpBridge(bridge, path, { method, body, signal, cdpTimeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
      return;
    }
    if (!Array.isArray(bridge.rpcQueue)) bridge.rpcQueue = [];
    if (!(bridge.rpcPending instanceof Map)) bridge.rpcPending = new Map();

    const reqId = `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const cleanupQueueItem = () => {
      if (!Array.isArray(bridge.rpcQueue)) return;
      const idx = bridge.rpcQueue.findIndex((item) => item?.id === reqId);
      if (idx >= 0) bridge.rpcQueue.splice(idx, 1);
    };

    const timeoutId = setTimeout(() => {
      bridge.rpcPending.delete(reqId);
      cleanupQueueItem();
      reject(new Error('CDP bridge timeout'));
    }, cdpTimeoutMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      bridge.rpcPending.delete(reqId);
      cleanupQueueItem();
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    bridge.rpcPending.set(reqId, {
      resolve: (data) => {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    });

    if (bridge.rpcQueue.length >= 16) {
      const dropped = bridge.rpcQueue.shift();
      if (dropped?.id) {
        const stale = bridge.rpcPending.get(dropped.id);
        bridge.rpcPending.delete(dropped.id);
        stale?.reject(new Error('CDP queue superseded'));
      }
    }
    bridge.rpcQueue.push({ id: reqId, path, method, body });
  });
}

export async function callSidecarApi(path, { method = 'GET', body, abortKey = '', cdpTimeoutMs = 3500 } = {}) {
  const upperMethod = method.toUpperCase();
  const activeEndpointId =
    String(getWindowBridgeConfig()?.[WINDOW_BRIDGE_ENDPOINT_KEY] || LOCAL_ENDPOINT_ID).trim() ||
    LOCAL_ENDPOINT_ID;
  const dedupKey = upperMethod === 'GET' && !abortKey ? `${activeEndpointId}::${path}` : '';

  if (dedupKey && inFlightGets.has(dedupKey)) {
    return inFlightGets.get(dedupKey);
  }

  let signal;
  let requestController = null;
  if (abortKey && typeof AbortController !== 'undefined') {
    const prev = activeControllers.get(abortKey);
    if (prev) {
      prev.abort();
    }
    requestController = new AbortController();
    activeControllers.set(abortKey, requestController);
    signal = requestController.signal;
  }

  const ensureEndpointUnchanged = (targetBridge) => {
    if (!targetBridge) return;
    const currentEndpointId =
      String(targetBridge[WINDOW_BRIDGE_ENDPOINT_KEY] || LOCAL_ENDPOINT_ID).trim() ||
      LOCAL_ENDPOINT_ID;
    if (currentEndpointId !== activeEndpointId) {
      const switchErr = new Error('Bridge endpoint switched');
      switchErr.name = 'AbortError';
      throw switchErr;
    }
  };

  const execHttpOnce = async (activeBridge) => {
    ensureEndpointUnchanged(activeBridge);
    const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
    const fetchFn = sidecar?.fetch
      ? sidecar.fetch.bind(sidecar)
      : typeof window !== 'undefined' && typeof window.fetch === 'function'
        ? window.fetch.bind(window)
        : globalThis.fetch.bind(globalThis);
    const requestUrl = activeBridge ? `http://127.0.0.1:${activeBridge.port}${path}` : path;
    const headers = {};
    if (body !== undefined || !activeBridge) {
      headers['Content-Type'] = 'application/json';
    }
    if (activeBridge) {
      headers['X-Usage-Monitor-Token'] = activeBridge.token;
      const epId = String(activeBridge[WINDOW_BRIDGE_ENDPOINT_KEY] || '').trim();
      if (epId && epId !== LOCAL_ENDPOINT_ID) {
        headers[WINDOW_BRIDGE_ENDPOINT_HEADER] = epId;
      }
    }
    const res = await fetchFn(requestUrl, {
      method: upperMethod,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    const data = await res.json().catch(() => ({}));
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (!res.ok) {
      const httpErr = new Error(data.error || `HTTP ${res.status}`);
      httpErr.httpStatus = res.status;
      httpErr.retryable = Boolean(data?.retryable);
      throw httpErr;
    }
    if (activeBridge) {
      activeBridge.transportMode = 'http';
    }
    return data;
  };

  const fallbackViaCdpWithRecovery = async (initialBridge) => {
    initialBridge.transportMode = 'cdp';
    try {
      return await callViaCdpBridge(initialBridge, path, {
        method: upperMethod,
        body,
        signal,
        cdpTimeoutMs,
      });
    } catch (cdpErr) {
      if (signal?.aborted || cdpErr?.name === 'AbortError') {
        throw cdpErr;
      }
      // 热更新或守护重启期间若 CDP 尚未轮询投递，自动重置回 HTTP 并用最新桥接端口重试一次；
      // 但若端点已切换（例如本地 <-> SSH），绝不将旧端点请求重放至新端点
      const latestBridge = getWindowBridgeConfig() || initialBridge;
      ensureEndpointUnchanged(latestBridge);
      latestBridge.transportMode = 'http';
      return execHttpOnce(latestBridge);
    }
  };

  const runRequest = async () => {
    const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
    const bridge = !sidecar?.fetch ? getWindowBridgeConfig() : null;
    if (bridge && bridge.transportMode === 'cdp') {
      return fallbackViaCdpWithRecovery(bridge);
    }

    try {
      return await execHttpOnce(bridge);
    } catch (fetchErr) {
      if (signal?.aborted || fetchErr?.name === 'AbortError') {
        throw fetchErr;
      }
      if (!bridge) {
        // 辅助栏 Webview 在 Worker 热替换瞬间若有极短暂波动，延迟 180ms 自动无感重试一次
        if (upperMethod === 'GET') {
          await new Promise((r) => setTimeout(r, 180));
          if (!signal?.aborted) {
            return execHttpOnce(null);
          }
        }
        throw fetchErr;
      }
      // 仅在网络/CORS 阻断（无 HTTP 状态码）或桥接令牌失配（403）时切换至 CDP 兜底；
      // 业务/初始化状态码（如 503 Remote endpoint initializing、400、500）保持 HTTP 通道等待正常重试。
      if (fetchErr?.httpStatus && fetchErr.httpStatus !== 403) {
        throw fetchErr;
      }
      return fallbackViaCdpWithRecovery(bridge);
    }
  };

  const promise = runRequest().finally(() => {
    if (dedupKey) {
      inFlightGets.delete(dedupKey);
    }
    if (abortKey && requestController && activeControllers.get(abortKey) === requestController) {
      activeControllers.delete(abortKey);
    }
  });

  if (dedupKey) {
    inFlightGets.set(dedupKey, promise);
  }
  return promise;
}

/**
 * Copy text to system clipboard across Webview / Shadow DOM / Sidecar sandbox:
 * 1. Synchronous hidden `<textarea>` + `execCommand('copy')` while user activation is active;
 * 2. Async `navigator.clipboard.writeText`;
 * 3. Sidecar `/api/clipboard` fallback.
 */
export async function copyTextToClipboard(text) {
  const str = String(text ?? '');
  if (!str) return false;
  if (typeof window !== 'undefined') {
    window.__AGLastCopiedText = str;
  }

  let syncCopied = false;
  if (
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function' &&
    typeof document.execCommand === 'function' &&
    document.body?.appendChild
  ) {
    let ta = null;
    const prevActive = document.activeElement;
    try {
      ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute?.('readonly', '');
      if (ta.style) {
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '-9999px';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
      }
      document.body.appendChild(ta);
      ta.focus?.({ preventScroll: true });
      ta.select?.();
      ta.setSelectionRange?.(0, str.length);
      syncCopied = Boolean(document.execCommand('copy'));
    } catch {
      syncCopied = false;
    } finally {
      ta?.remove?.();
      try {
        prevActive?.focus?.({ preventScroll: true });
      } catch {
        // ignore focus restore failure
      }
    }
  }

  let asyncCopied = false;
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(str);
      asyncCopied = true;
    } catch {
      asyncCopied = false;
    }
  }

  if (syncCopied || asyncCopied) {
    return true;
  }

  try {
    const res = await callSidecarApi('/api/clipboard', {
      method: 'POST',
      body: { text: str },
    });
    if (res?.ok) return true;
  } catch {
    // ignore fallback failure
  }
  return false;
}

export async function copyWithTimedFeedback(text, timerHolder, onToggle, durationMs = 1500) {
  const ok = await copyTextToClipboard(text);
  if (!ok || typeof onToggle !== 'function') return ok;
  if (timerHolder?.id) {
    clearTimeout(timerHolder.id);
    timerHolder.id = null;
  }
  onToggle(true);
  if (timerHolder) {
    timerHolder.id = setTimeout(() => {
      timerHolder.id = null;
      onToggle(false);
    }, durationMs);
  }
  return true;
}
