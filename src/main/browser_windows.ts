import path from 'path';
import {
  BrowserView,
  BrowserWindow,
  Menu,
  clipboard,
  session,
  shell,
  type App,
  type Session,
  type WebContents,
} from 'electron';

import {
  makeNavigationFailureDataUrl,
  makeProxiedToolbarDataUrl,
  makeWtbProbeLoadingDataUrl,
} from './browser_window_pages';
import { resolveHtmlPath } from './util';

type LoggerLike = {
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

type ProxiedToolbarState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  errorText?: string;
  totalReceivedBytes?: number;
  downloadRateBytesPerSecond?: number;
  avgResponseLatencyMs?: number | null;
};

type ProxiedWindowState = {
  requestedUrl: string;
  errorText: string;
};

type WtbServiceProbeResult = {
  url: string;
  serviceHeader: string;
  featureList: string[];
  ipfsStatus: string;
  isWtbWebService: boolean;
  supportsResourceManifest: boolean;
  supportsIpfs: boolean;
};

type ProxiedNetworkSnapshot = {
  totalReceivedBytes: number;
  downloadRateBytesPerSecond: number;
  avgResponseLatencyMs: number | null;
};

type ProxiedNetworkCollector = {
  getSnapshot: () => ProxiedNetworkSnapshot;
  reset: () => void;
  dispose: () => void;
};

type ToolbarWindowOptions = {
  requestedUrl: string;
  initialViewUrl: string;
  fallbackTitle: string;
  fallbackHint: string;
  fallbackButtonLabel: string;
  partition?: string;
  onHttpWindowOpen: (url: string) => void;
  onSocksWindowOpen?: (proxyUri: string) => void;
};

const PROXIED_TOOLBAR_HEIGHT = 60;
const WTB_SERVICE_PROBE_TIMEOUT_MS = 3500;
const PROXIED_METRICS_UPDATE_INTERVAL_MS = 1000;
const PROXIED_DOWNLOAD_RATE_WINDOW_MS = 2000;
const PROXIED_LATENCY_SAMPLE_LIMIT = 20;

const FAILED_LOAD_ABORTED = -3;

const LATENCY_RESOURCE_TYPES = new Set([
  'Document',
  'Fetch',
  'Script',
  'Stylesheet',
  'XHR',
]);

const EXCLUDED_NETWORK_RESOURCE_TYPES = new Set(['EventSource', 'WebSocket']);

const attachSelectionContextMenu = (targetWindow: BrowserWindow): void => {
  targetWindow.webContents.on('context-menu', (_event, params) => {
    try {
      const hasSelection = (params.selectionText || '').trim().length > 0;
      const isEditable = !!params.isEditable;

      const template = isEditable
        ? [
            { role: 'cut' as const, enabled: hasSelection },
            { role: 'copy' as const, enabled: hasSelection },
            { role: 'paste' as const },
            { type: 'separator' as const },
            { role: 'selectAll' as const },
          ]
        : [
            { role: 'copy' as const, enabled: hasSelection },
            { role: 'selectAll' as const },
          ];

      Menu.buildFromTemplate(template).popup({ window: targetWindow });
    } catch {
      // ignore
    }
  });
};

const getPreloadPath = (app: App): string => {
  return app.isPackaged
    ? path.join(__dirname, 'preload.js')
    : path.join(__dirname, '../../.erb/dll/preload.js');
};

const normalizeProxiedTargetUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withScheme = /^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const parseWtbFeatureList = (headerValue: string): string[] => {
  return headerValue
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
};

const createProbeAbortSignal = (timeoutMs: number): AbortSignal => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
};

const probeWtbWebService = async (
  targetUrl: string,
): Promise<WtbServiceProbeResult> => {
  let response: Response;

  try {
    response = await fetch(targetUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: createProbeAbortSignal(WTB_SERVICE_PROBE_TIMEOUT_MS),
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    });
  } catch {
    response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: createProbeAbortSignal(WTB_SERVICE_PROBE_TIMEOUT_MS),
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        Range: 'bytes=0-0',
      },
    });
    await response.body?.cancel().catch(() => {
      // ignore
    });
  }

  const serviceHeader = (response.headers.get('wtb-service') || '').trim();
  const featureList = parseWtbFeatureList(
    response.headers.get('wtb-features') || '',
  );
  const ipfsStatus = (response.headers.get('wtb-ipfs-status') || '')
    .trim()
    .toLowerCase();
  const isWtbWebService = /^web(?:\s*;|$)/i.test(serviceHeader);
  const supportsResourceManifest = featureList.includes('resource-manifest');
  const supportsIpfs = featureList.includes('ipfs') && ipfsStatus === 'running';

  return {
    url: response.url || targetUrl,
    serviceHeader,
    featureList,
    ipfsStatus,
    isWtbWebService,
    supportsResourceManifest,
    supportsIpfs,
  };
};

const normalizeStandaloneResourcePath = (inputPath: string): string => {
  const normalized = (inputPath || '/').trim() || '/';
  if (normalized === '/') return '/';
  if (normalized.endsWith('/')) return normalized;
  const lastSegment = normalized.split('/').pop() || '';
  if (lastSegment.includes('.')) {
    const directory = normalized.split('/').slice(0, -1).join('/');
    return directory ? `${directory}/` : '/';
  }
  return `${normalized}/`;
};

const buildStandaloneRemoteResourcesUrl = (opts: {
  baseUrl: string;
  requestedPath: string;
}): string => {
  const appUrl = new URL(resolveHtmlPath('index.html'));
  appUrl.searchParams.set('wtbView', 'remote-resources');
  appUrl.searchParams.set('baseUrl', opts.baseUrl);
  appUrl.searchParams.set('path', opts.requestedPath);
  return appUrl.toString();
};

const layoutProxiedBrowserView = (
  targetWindow: BrowserWindow,
  view: BrowserView,
): void => {
  if (targetWindow.isDestroyed()) return;

  const [width, height] = targetWindow.getContentSize();
  view.setBounds({
    x: 0,
    y: PROXIED_TOOLBAR_HEIGHT,
    width,
    height: Math.max(0, height - PROXIED_TOOLBAR_HEIGHT),
  });
  view.setAutoResize({ width: true, height: true });
};

const updateProxiedToolbarState = (
  targetWindow: BrowserWindow,
  state: ProxiedToolbarState,
): void => {
  if (targetWindow.isDestroyed()) return;

  const serialized = JSON.stringify(state)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\\u2028/g, '\\u2028')
    .replace(/\\u2029/g, '\\u2029');

  targetWindow.webContents
    .executeJavaScript(
      `window.__setProxiedToolbarState && window.__setProxiedToolbarState(${serialized});`,
      true,
    )
    .catch(() => {
      // ignore
    });
};

const attachProxiedNetworkMetrics = (
  contents: WebContents,
  logger: LoggerLike,
): ProxiedNetworkCollector => {
  let totalReceivedBytes = 0;
  let recentByteSamples: Array<{ recordedAtMs: number; bytes: number }> = [];
  let latencySamples: number[] = [];
  let attached = false;

  const activeRequests = new Map<string, { startedAtMs: number }>();

  const trimByteSamples = (nowMs: number) => {
    recentByteSamples = recentByteSamples.filter(
      (sample) => nowMs - sample.recordedAtMs <= PROXIED_DOWNLOAD_RATE_WINDOW_MS,
    );
  };

  const reset = () => {
    totalReceivedBytes = 0;
    recentByteSamples = [];
    latencySamples = [];
    activeRequests.clear();
  };

  const getSnapshot = (): ProxiedNetworkSnapshot => {
    const nowMs = Date.now();
    trimByteSamples(nowMs);
    const recentBytes = recentByteSamples.reduce(
      (sum, sample) => sum + sample.bytes,
      0,
    );
    const avgResponseLatencyMs = latencySamples.length
      ? Math.round(
          latencySamples.reduce((sum, latencyMs) => sum + latencyMs, 0) /
            latencySamples.length,
        )
      : null;

    return {
      totalReceivedBytes,
      downloadRateBytesPerSecond: Math.round(
        (recentBytes * 1000) / PROXIED_DOWNLOAD_RATE_WINDOW_MS,
      ),
      avgResponseLatencyMs,
    };
  };

  const onDebuggerMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => {
    const requestId =
      typeof params.requestId === 'string' ? params.requestId : null;
    const resourceType =
      typeof params.type === 'string' ? params.type : undefined;
    const timestampSeconds =
      typeof params.timestamp === 'number' ? params.timestamp : undefined;
    const timestampMs =
      typeof timestampSeconds === 'number'
        ? Math.round(timestampSeconds * 1000)
        : Date.now();

    if (method === 'Network.requestWillBeSent') {
      if (!requestId || EXCLUDED_NETWORK_RESOURCE_TYPES.has(resourceType || '')) {
        return;
      }
      activeRequests.set(requestId, { startedAtMs: timestampMs });
      return;
    }

    if (method === 'Network.responseReceived') {
      if (
        !requestId ||
        !resourceType ||
        !LATENCY_RESOURCE_TYPES.has(resourceType)
      ) {
        return;
      }

      const requestState = activeRequests.get(requestId);
      if (!requestState) return;

      const latencyMs = Math.max(0, timestampMs - requestState.startedAtMs);
      latencySamples.push(latencyMs);
      if (latencySamples.length > PROXIED_LATENCY_SAMPLE_LIMIT) {
        latencySamples = latencySamples.slice(-PROXIED_LATENCY_SAMPLE_LIMIT);
      }
      return;
    }

    if (method === 'Network.loadingFinished') {
      if (!requestId) return;

      const encodedDataLength =
        typeof params.encodedDataLength === 'number'
          ? Math.max(0, params.encodedDataLength)
          : 0;

      if (encodedDataLength > 0) {
        totalReceivedBytes += encodedDataLength;
        recentByteSamples.push({
          recordedAtMs: timestampMs,
          bytes: encodedDataLength,
        });
        trimByteSamples(timestampMs);
      }

      activeRequests.delete(requestId);
      return;
    }

    if (method === 'Network.loadingFailed' && requestId) {
      activeRequests.delete(requestId);
    }
  };

  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3');
      attached = true;
    }
    contents.debugger.on('message', onDebuggerMessage);
    void contents.debugger.sendCommand('Network.enable').catch((error) => {
      logger.debug?.('Failed to enable proxied window network metrics', error);
    });
  } catch (error) {
    logger.debug?.('Failed to attach proxied window debugger', error);
  }

  const dispose = () => {
    try {
      contents.debugger.off('message', onDebuggerMessage);
    } catch {
      // ignore
    }

    if (!attached) return;

    try {
      void contents.debugger.sendCommand('Network.disable').catch(() => {
        // ignore
      });
      if (contents.debugger.isAttached()) {
        contents.debugger.detach();
      }
    } catch {
      // ignore
    }
  };

  return {
    getSnapshot,
    reset,
    dispose,
  };
};

const isDataHtmlUrl = (value: string): boolean => {
  return value.startsWith('data:text/html');
};

const formatLoadFailureDetail = (
  errorCode: number,
  errorDescription: string,
): string => {
  const detail = (errorDescription || '').trim();
  if (!detail) return `错误代码 ${errorCode}`;
  return `${detail}（错误代码 ${errorCode}）`;
};

const attachRetryPageOnLoadFailure = (
  contents: WebContents,
  options: {
    logger: LoggerLike;
    getFallbackUrl: (
      validatedUrl: string,
      errorCode: number,
      errorDescription: string,
    ) => string;
    onFailure?: (
      validatedUrl: string,
      errorCode: number,
      errorDescription: string,
    ) => void;
    onSuccess?: (url: string) => void;
  },
): void => {
  contents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === FAILED_LOAD_ABORTED) return;
      if (!validatedUrl || isDataHtmlUrl(validatedUrl)) return;

      options.onFailure?.(validatedUrl, errorCode, errorDescription);

      const fallbackUrl = options.getFallbackUrl(
        validatedUrl,
        errorCode,
        errorDescription,
      );
      contents.loadURL(fallbackUrl).catch((error) => {
        options.logger.debug?.('Failed to load retry page', error);
      });
    },
  );

  contents.on('did-navigate', (_event, url) => {
    if (!url || isDataHtmlUrl(url)) return;
    options.onSuccess?.(url);
  });

  contents.on('did-navigate-in-page', (_event, url) => {
    if (!url || isDataHtmlUrl(url)) return;
    options.onSuccess?.(url);
  });
};

export class BrowserWindowCoordinator {
  private readonly proxiedWindowViews = new Map<number, BrowserView>();

  private readonly proxiedWindowStates = new Map<number, ProxiedWindowState>();

  constructor(
    private readonly options: {
      app: App;
      logger: LoggerLike;
      applyChineseAcceptLanguage: (session: Session) => void;
    },
  ) {}

  async openExternalUrl(url: string): Promise<void> {
    if (!url || typeof url !== 'string') return;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return;
    }

    await shell.openExternal(parsed.toString());
  }

  async openInAppUrl(url: string): Promise<void> {
    if (!url || typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) {
      return;
    }

    const loadingUrl = makeWtbProbeLoadingDataUrl(url);
    const { targetWindow, view } = await this.createToolbarWindow({
      requestedUrl: url,
      initialViewUrl: loadingUrl,
      fallbackTitle: '这个页面暂时打不开',
      fallbackHint: '网络超时、地址失效，或者远端服务还没准备好。',
      fallbackButtonLabel: '再试一次',
      onHttpWindowOpen: (nextUrl) => {
        void this.openInAppUrl(nextUrl);
      },
      onSocksWindowOpen: (proxyUri) => {
        void this.openProxiedWindow(proxyUri, 'https://www.bing.com');
      },
    });

    let targetUrl = url;
    try {
      const probe = await probeWtbWebService(url);
      targetUrl = probe.url || url;

      if (probe.isWtbWebService && probe.supportsResourceManifest) {
        const parsed = new URL(targetUrl);
        const baseUrl = `${parsed.protocol}//${parsed.host}`;
        const requestedPath = normalizeStandaloneResourcePath(parsed.pathname);

        if (!targetWindow.isDestroyed()) {
          targetWindow.close();
        }

        await this.openStandaloneRemoteResourcesWindow({
          baseUrl,
          requestedPath,
          detectedIpfsSupport: probe.supportsIpfs,
        });
        return;
      }
    } catch (error) {
      this.options.logger.debug?.('WTB web service probe failed', error);
    }

    if (!targetWindow.isDestroyed()) {
      this.proxiedWindowStates.set(targetWindow.id, {
        requestedUrl: targetUrl,
        errorText: '',
      });
      view.webContents.loadURL(targetUrl).catch(() => {
        // ignore
      });
    }
  }

  async openProxiedWindow(
    proxyUri: string,
    targetUrl = 'https://www.bing.com',
  ): Promise<BrowserWindow | null> {
    try {
      const parsed = new URL(proxyUri);
      if (!(parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:')) {
        return null;
      }

      const partition = `proxy-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const partitionSession = session.fromPartition(partition);

      try {
        await partitionSession.setProxy({
          proxyRules: proxyUri,
          proxyBypassRules: '<-loopback>',
        });
      } catch (error) {
        this.options.logger.warn('setProxy failed for', proxyUri, error);
      }

      const normalizedTarget =
        normalizeProxiedTargetUrl(targetUrl) || 'https://www.bing.com';

      const { targetWindow } = await this.createToolbarWindow({
        requestedUrl: normalizedTarget,
        initialViewUrl: normalizedTarget,
        partition,
        fallbackTitle: '这个页面暂时没连上',
        fallbackHint: '代理连接、目标站点或本地网络可能暂时不可用。',
        fallbackButtonLabel: '重新加载',
        onHttpWindowOpen: (nextUrl) => {
          void this.openProxiedWindow(proxyUri, nextUrl);
        },
      });

      return targetWindow;
    } catch (error) {
      this.options.logger.warn('openProxiedWindow failed', error);
      return null;
    }
  }

  async handleProxiedWindowCommand(
    windowId: number,
    command: string,
    value?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const targetWindow = BrowserWindow.fromId(windowId);
      if (!targetWindow || targetWindow.isDestroyed()) return { ok: false };

      const view = this.proxiedWindowViews.get(windowId);
      const webContents = view?.webContents;
      const windowState = this.proxiedWindowStates.get(windowId);
      if (!webContents || webContents.isDestroyed()) return { ok: false };

      switch (command) {
        case 'back':
          if (webContents.canGoBack()) webContents.goBack();
          break;
        case 'forward':
          if (webContents.canGoForward()) webContents.goForward();
          break;
        case 'reload':
          if (
            isDataHtmlUrl(webContents.getURL()) &&
            windowState?.requestedUrl
          ) {
            windowState.errorText = '';
            webContents.loadURL(windowState.requestedUrl).catch(() => {
              // ignore
            });
          } else {
            webContents.reload();
          }
          break;
        case 'navigate': {
          const normalized = normalizeProxiedTargetUrl(
            typeof value === 'string' ? value : '',
          );
          if (!normalized) return { ok: false, error: 'invalid-url' };
          this.proxiedWindowStates.set(windowId, {
            requestedUrl: normalized,
            errorText: '',
          });
          webContents.loadURL(normalized).catch(() => {
            // ignore
          });
          break;
        }
        case 'copy-url':
          clipboard.writeText(
            isDataHtmlUrl(webContents.getURL())
              ? windowState?.requestedUrl || ''
              : webContents.getURL() || '',
          );
          break;
        case 'open-external': {
          const currentUrl = isDataHtmlUrl(webContents.getURL())
            ? windowState?.requestedUrl || ''
            : webContents.getURL() || '';
          if (currentUrl) {
            await shell.openExternal(currentUrl).catch(() => {
              // ignore
            });
          }
          break;
        }
        case 'close':
          targetWindow.close();
          break;
        default:
          break;
      }

      if (!targetWindow.isDestroyed() && command !== 'close') {
        targetWindow.focus();
      }

      return { ok: true };
    } catch (error) {
      this.options.logger.debug?.('proxied-window-command failed', error);
      return { ok: false };
    }
  }

  private async createToolbarWindow(
    options: ToolbarWindowOptions,
  ): Promise<{ targetWindow: BrowserWindow; view: BrowserView }> {
    const targetWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      show: false,
      webPreferences: {
        preload: getPreloadPath(this.options.app),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        ...(options.partition ? { partition: options.partition } : {}),
      },
    });

    this.proxiedWindowViews.set(targetWindow.id, view);
    this.proxiedWindowStates.set(targetWindow.id, {
      requestedUrl: options.requestedUrl,
      errorText: '',
    });

    targetWindow.setBrowserView(view);
    layoutProxiedBrowserView(targetWindow, view);

    this.options.applyChineseAcceptLanguage(targetWindow.webContents.session);
    this.options.applyChineseAcceptLanguage(view.webContents.session);
    attachSelectionContextMenu(targetWindow);
    targetWindow.once('ready-to-show', () => targetWindow.show());

    view.webContents.on('will-navigate', (event, navUrl) => {
      try {
        const parsed = new URL(navUrl);

        if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') {
          event.preventDefault();
          options.onSocksWindowOpen?.(parsed.toString());
          return;
        }

        if (
          parsed.protocol !== 'http:' &&
          parsed.protocol !== 'https:' &&
          parsed.protocol !== 'file:'
        ) {
          event.preventDefault();
        }
      } catch {
        event.preventDefault();
      }
    });

    view.webContents.setWindowOpenHandler((details) => {
      try {
        const parsed = new URL(details.url);

        if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') {
          options.onSocksWindowOpen?.(parsed.toString());
          return { action: 'deny' };
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { action: 'deny' };
        }

        options.onHttpWindowOpen(parsed.toString());
        return { action: 'deny' };
      } catch {
        return { action: 'deny' };
      }
    });

    const networkMetrics = attachProxiedNetworkMetrics(
      view.webContents,
      this.options.logger,
    );

    const syncToolbarState = () => {
      const windowState = this.proxiedWindowStates.get(targetWindow.id);
      const currentUrl = view.webContents.getURL();
      const displayedUrl =
        currentUrl && !isDataHtmlUrl(currentUrl)
          ? currentUrl
          : windowState?.requestedUrl || options.requestedUrl;
      const metrics = networkMetrics.getSnapshot();

      updateProxiedToolbarState(targetWindow, {
        url: displayedUrl,
        title: view.webContents.getTitle() || '',
        canGoBack: view.webContents.canGoBack(),
        canGoForward: view.webContents.canGoForward(),
        isLoading: view.webContents.isLoading(),
        errorText: windowState?.errorText || '',
        totalReceivedBytes: metrics.totalReceivedBytes,
        downloadRateBytesPerSecond: metrics.downloadRateBytesPerSecond,
        avgResponseLatencyMs: metrics.avgResponseLatencyMs,
      });
    };

    const metricsInterval = setInterval(
      syncToolbarState,
      PROXIED_METRICS_UPDATE_INTERVAL_MS,
    );

    view.webContents.on('did-start-loading', () => {
      networkMetrics.reset();
      syncToolbarState();
    });

    attachRetryPageOnLoadFailure(view.webContents, {
      logger: this.options.logger,
      getFallbackUrl: (validatedUrl, errorCode, errorDescription) => {
        return makeNavigationFailureDataUrl({
          targetUrl: validatedUrl,
          title: options.fallbackTitle,
          hint: options.fallbackHint,
          buttonLabel: options.fallbackButtonLabel,
          errorDetail: formatLoadFailureDetail(errorCode, errorDescription),
        });
      },
      onFailure: (validatedUrl, errorCode, errorDescription) => {
        this.proxiedWindowStates.set(targetWindow.id, {
          requestedUrl: validatedUrl,
          errorText: formatLoadFailureDetail(errorCode, errorDescription),
        });
        syncToolbarState();
      },
      onSuccess: (url) => {
        this.proxiedWindowStates.set(targetWindow.id, {
          requestedUrl: url,
          errorText: '',
        });
        syncToolbarState();
      },
    });

    view.webContents.on('did-stop-loading', syncToolbarState);
    view.webContents.on('page-title-updated', syncToolbarState);
    view.webContents.on('did-navigate', syncToolbarState);
    view.webContents.on('did-navigate-in-page', syncToolbarState);

    targetWindow.on('resize', () =>
      layoutProxiedBrowserView(targetWindow, view),
    );
    targetWindow.on('maximize', () =>
      layoutProxiedBrowserView(targetWindow, view),
    );
    targetWindow.on('unmaximize', () =>
      layoutProxiedBrowserView(targetWindow, view),
    );
    targetWindow.on('enter-full-screen', () =>
      layoutProxiedBrowserView(targetWindow, view),
    );
    targetWindow.on('leave-full-screen', () =>
      layoutProxiedBrowserView(targetWindow, view),
    );
    targetWindow.on('closed', () => {
      clearInterval(metricsInterval);
      networkMetrics.dispose();
      this.proxiedWindowViews.delete(targetWindow.id);
      this.proxiedWindowStates.delete(targetWindow.id);
    });

    try {
      await targetWindow.loadURL(
        makeProxiedToolbarDataUrl({
          windowId: targetWindow.id,
          height: PROXIED_TOOLBAR_HEIGHT,
        }),
      );
    } catch {
      // ignore
    }

    syncToolbarState();
    view.webContents.loadURL(options.initialViewUrl).catch(() => {
      // ignore
    });

    return { targetWindow, view };
  }

  private async openStandaloneRemoteResourcesWindow(opts: {
    baseUrl: string;
    requestedPath: string;
    detectedIpfsSupport: boolean;
  }): Promise<void> {
    const child = new BrowserWindow({
      width: 1080,
      height: 760,
      show: false,
      webPreferences: {
        preload: getPreloadPath(this.options.app),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    this.options.applyChineseAcceptLanguage(child.webContents.session);
    attachSelectionContextMenu(child);
    child.once('ready-to-show', () => child.show());
    child.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url).catch(() => {
        // ignore
      });
      return { action: 'deny' };
    });

    const label = opts.detectedIpfsSupport
      ? 'WTB 远程内容（IPFS 可用）'
      : 'WTB 远程内容';
    child.setTitle(label);

    await child.loadURL(
      buildStandaloneRemoteResourcesUrl({
        baseUrl: opts.baseUrl,
        requestedPath: opts.requestedPath,
      }),
    );
  }
}
