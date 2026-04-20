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

const PROXIED_TOOLBAR_HEIGHT = 60;
const WTB_SERVICE_PROBE_TIMEOUT_MS = 3500;

const FAILED_LOAD_ABORTED = -3;

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

    const child = this.createInAppWindow();
    const loadingUrl = makeWtbProbeLoadingDataUrl(url);
    try {
      await child.loadURL(loadingUrl);
    } catch {
      // ignore
    }

    let targetUrl = url;
    try {
      const probe = await probeWtbWebService(url);
      targetUrl = probe.url || url;

      if (probe.isWtbWebService && probe.supportsResourceManifest) {
        const parsed = new URL(targetUrl);
        const baseUrl = `${parsed.protocol}//${parsed.host}`;
        const requestedPath = normalizeStandaloneResourcePath(parsed.pathname);

        if (!child.isDestroyed()) {
          child.close();
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

    if (!child.isDestroyed()) {
      child.loadURL(targetUrl).catch(() => {
        // ignore
      });
    }
  }

  async openProxiedWindow(
    proxyUri: string,
    targetUrl = 'https://www.google.com',
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
          partition,
        },
      });

      this.proxiedWindowViews.set(targetWindow.id, view);
      this.proxiedWindowStates.set(targetWindow.id, {
        requestedUrl:
          normalizeProxiedTargetUrl(targetUrl) || 'https://www.google.com',
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
          const parsedUrl = new URL(navUrl);
          if (
            parsedUrl.protocol !== 'http:' &&
            parsedUrl.protocol !== 'https:' &&
            parsedUrl.protocol !== 'file:'
          ) {
            event.preventDefault();
          }
        } catch {
          event.preventDefault();
        }
      });

      view.webContents.setWindowOpenHandler((details) => {
        try {
          const parsedUrl = new URL(details.url);
          if (
            parsedUrl.protocol !== 'http:' &&
            parsedUrl.protocol !== 'https:'
          ) {
            return { action: 'deny' };
          }
          void this.openProxiedWindow(proxyUri, parsedUrl.toString());
          return { action: 'deny' };
        } catch {
          return { action: 'deny' };
        }
      });

      const syncToolbarState = () => {
        const windowState = this.proxiedWindowStates.get(targetWindow.id);
        const currentUrl = view.webContents.getURL();
        const displayedUrl =
          currentUrl && !isDataHtmlUrl(currentUrl)
            ? currentUrl
            : windowState?.requestedUrl || targetUrl;
        updateProxiedToolbarState(targetWindow, {
          url: displayedUrl,
          title: view.webContents.getTitle() || '',
          canGoBack: view.webContents.canGoBack(),
          canGoForward: view.webContents.canGoForward(),
          isLoading: view.webContents.isLoading(),
          errorText: windowState?.errorText || '',
        });
      };

      attachRetryPageOnLoadFailure(view.webContents, {
        logger: this.options.logger,
        getFallbackUrl: (validatedUrl, errorCode, errorDescription) => {
          return makeNavigationFailureDataUrl({
            targetUrl: validatedUrl,
            title: '这个页面暂时没连上',
            hint: '代理连接、目标站点或本地网络可能暂时不可用。',
            buttonLabel: '重新加载',
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

      view.webContents.on('did-start-loading', syncToolbarState);
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

      const normalizedTarget =
        normalizeProxiedTargetUrl(targetUrl) || 'https://www.google.com';
      this.proxiedWindowStates.set(targetWindow.id, {
        requestedUrl: normalizedTarget,
        errorText: '',
      });
      view.webContents.loadURL(normalizedTarget).catch(() => {
        // ignore
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

  private createInAppWindow(): BrowserWindow {
    const child = new BrowserWindow({
      width: 1000,
      height: 700,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    this.options.applyChineseAcceptLanguage(child.webContents.session);
    attachSelectionContextMenu(child);
    attachRetryPageOnLoadFailure(child.webContents, {
      logger: this.options.logger,
      getFallbackUrl: (validatedUrl, errorCode, errorDescription) => {
        return makeNavigationFailureDataUrl({
          targetUrl: validatedUrl,
          title: '这个页面暂时打不开',
          hint: '网络超时、地址失效，或者远端服务还没准备好。',
          buttonLabel: '再试一次',
          errorDetail: formatLoadFailureDetail(errorCode, errorDescription),
        });
      },
    });
    child.once('ready-to-show', () => child.show());

    child.webContents.on('will-navigate', (event, navUrl) => {
      try {
        const parsed = new URL(navUrl);
        if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') {
          event.preventDefault();
          void this.openProxiedWindow(
            parsed.toString(),
            'https://www.google.com',
          );
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

    child.webContents.setWindowOpenHandler((details) => {
      try {
        const parsed = new URL(details.url);

        if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') {
          void this.openProxiedWindow(
            parsed.toString(),
            'https://www.google.com',
          );
          return { action: 'deny' };
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { action: 'deny' };
        }

        void this.openInAppUrl(parsed.toString());
        return { action: 'deny' };
      } catch {
        return { action: 'deny' };
      }
    });

    return child;
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
