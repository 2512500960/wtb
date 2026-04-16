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
} from 'electron';

import { escapeHtml } from './web_service_utils';
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

const makeInAppLoadingDataUrl = (targetUrl: string): string => {
  const safeUrl = escapeHtml(targetUrl || '');
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>正在打开…</title>
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0f1115; color: rgba(255,255,255,0.92); }
      .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .card { width: min(720px, calc(100vw - 48px)); border-radius: 16px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); padding: 18px 18px; }
      .row { display: flex; gap: 14px; align-items: center; }
      .spinner { width: 28px; height: 28px; border-radius: 999px; border: 3px solid rgba(255,255,255,0.18); border-top-color: rgba(255,255,255,0.92); animation: spin 0.9s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .title { font-size: 16px; font-weight: 700; margin: 0; }
      .sub { margin-top: 10px; font-size: 12px; opacity: 0.85; word-break: break-all; line-height: 1.45; }
      .hint { margin-top: 10px; font-size: 12px; opacity: 0.65; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="row">
          <div class="spinner" aria-hidden="true"></div>
          <div>
            <p class="title">正在打开网页…</p>
            <div class="sub">${safeUrl}</div>
          </div>
        </div>
        <div class="hint">网络较慢时需要耐心等待，窗口已先打开。</div>
      </div>
    </div>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

const makeWtbProbeLoadingDataUrl = (targetUrl: string): string => {
  const safeUrl = escapeHtml(targetUrl || '');
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>正在探测…</title>
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0c1017; color: rgba(255,255,255,0.92); }
      .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .card { width: min(760px, calc(100vw - 48px)); border-radius: 16px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); padding: 18px; }
      .row { display: flex; gap: 14px; align-items: center; }
      .spinner { width: 28px; height: 28px; border-radius: 999px; border: 3px solid rgba(255,255,255,0.18); border-top-color: rgba(255,255,255,0.92); animation: spin 0.9s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .title { font-size: 16px; font-weight: 700; margin: 0; }
      .sub { margin-top: 10px; font-size: 12px; opacity: 0.85; word-break: break-all; line-height: 1.45; }
      .hint { margin-top: 10px; font-size: 12px; opacity: 0.72; line-height: 1.5; }
      .tip { margin-top: 12px; font-size: 12px; opacity: 0.62; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="row">
          <div class="spinner" aria-hidden="true"></div>
          <div>
            <p class="title">正在探测网页能力…</p>
            <div class="sub">${safeUrl}</div>
          </div>
        </div>
        <div class="hint">正在判断目标是否为 WTB Web 服务。如果响应头声明支持资源清单，将切换到本地原生资源页，以便使用 HTTP / IPFS 双源加载与回退。</div>
        <div class="tip">普通网页会继续按原样打开。</div>
      </div>
    </div>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
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
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    });
  } catch {
    response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: createProbeAbortSignal(WTB_SERVICE_PROBE_TIMEOUT_MS),
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
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

const makeProxiedToolbarDataUrl = (windowId: number, proxyUri: string): string => {
  const safeProxy = escapeHtml(proxyUri);
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: dark;
      }

      body {
        margin: 0;
        background: #10141b;
        font-family: "Segoe UI", system-ui, sans-serif;
        color: rgba(255, 255, 255, 0.94);
      }

      .bar {
        height: ${PROXIED_TOOLBAR_HEIGHT}px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: linear-gradient(180deg, #161b24 0%, #121720 100%);
        box-sizing: border-box;
      }

      button {
        height: 30px;
        min-width: 30px;
        padding: 0 10px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 9px;
        background: rgba(255, 255, 255, 0.05);
        color: inherit;
        cursor: pointer;
        font: inherit;
      }

      button:hover {
        background: rgba(255, 255, 255, 0.1);
      }

      button:disabled {
        opacity: 0.4;
        cursor: default;
      }

      input {
        height: 32px;
        flex: 1;
        min-width: 120px;
        padding: 0 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 9px;
        background: rgba(255, 255, 255, 0.06);
        color: inherit;
        font: inherit;
        outline: none;
      }

      input:focus {
        border-color: rgba(98, 168, 255, 0.75);
        box-shadow: 0 0 0 3px rgba(98, 168, 255, 0.15);
      }

      .spacer {
        width: 4px;
      }

      .proxy {
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        opacity: 0.82;
      }

      .title {
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.86);
      }

      .status {
        font-size: 12px;
        opacity: 0.7;
        min-width: 70px;
        color: rgba(255, 255, 255, 0.7);
      }

      .status.error {
        color: #ff9d9d;
        opacity: 1;
      }
    </style>
  </head>
  <body>
    <form class="bar" id="toolbar-form">
      <tr>
      <button id="back" type="button" title="后退">◀</button>
      <button id="forward" type="button" title="前进">▶</button>
      <button id="reload" type="button" title="刷新">刷新</button>
      <input id="address" type="text" spellcheck="false" autocomplete="off" aria-label="地址栏" />
      <button id="go" type="submit" title="前往">Go</button>
      <button id="copy" type="button" title="复制当前地址">复制</button>
      <button id="external" type="button" title="用系统浏览器打开当前页面">浏览器</button>
      <div class="spacer"></div>
      <div class="title" id="title"></div>
      <div class="status" id="status"></div>
      <!-- <div class="proxy" title="${safeProxy}">代理: ${safeProxy}</div> -->
      <button id="close" type="button" title="关闭窗口">关闭</button>
      </tr>
      <tr>

      </tr>
    </form>
    <script>
      const invoke = (cmd, value) =>
        window.electron.ipcRenderer.invoke('proxied-window-command', ${windowId}, cmd, value);

      const address = document.getElementById('address');
      const back = document.getElementById('back');
      const forward = document.getElementById('forward');
      const reload = document.getElementById('reload');
      const copy = document.getElementById('copy');
      const external = document.getElementById('external');
      const closeButton = document.getElementById('close');
      const form = document.getElementById('toolbar-form');
      const status = document.getElementById('status');
      const title = document.getElementById('title');
      let errorText = '';

      const renderStatus = (state) => {
        if (errorText) {
          status.textContent = errorText;
          status.classList.add('error');
          return;
        }

        status.classList.remove('error');
        status.textContent = state && state.isLoading ? '加载中…' : '';
      };

      const setError = (text) => {
        errorText = text || '';
        renderStatus(window.__proxiedToolbarState || null);
      };

      window.__setProxiedToolbarState = (state) => {
        if (!state || typeof state !== 'object') return;
        window.__proxiedToolbarState = state;
        if (document.activeElement !== address) {
          address.value = typeof state.url === 'string' ? state.url : '';
        }
        back.disabled = !state.canGoBack;
        forward.disabled = !state.canGoForward;
        title.textContent = typeof state.title === 'string' ? state.title : '';
        if (!state.isLoading) {
          errorText = '';
        }
        renderStatus(state);
      };

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        setError('');
        const result = await invoke('navigate', address.value);
        if (!result || result.ok !== true) {
          setError('地址无效，仅支持 http/https');
        }
      });

      back.addEventListener('click', () => invoke('back'));
      forward.addEventListener('click', () => invoke('forward'));
      reload.addEventListener('click', () => invoke('reload'));
      copy.addEventListener('click', () => invoke('copy-url'));
      external.addEventListener('click', () => invoke('open-external'));
      closeButton.addEventListener('click', () => invoke('close'));

      address.addEventListener('focus', () => address.select());
      address.addEventListener('input', () => {
        if (errorText) setError('');
      });
    </script>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

export class BrowserWindowCoordinator {
  private readonly proxiedWindowViews = new Map<number, BrowserView>();

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
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return { action: 'deny' };
          }
          void this.openProxiedWindow(proxyUri, parsedUrl.toString());
          return { action: 'deny' };
        } catch {
          return { action: 'deny' };
        }
      });

      const syncToolbarState = () => {
        updateProxiedToolbarState(targetWindow, {
          url: view.webContents.getURL() || targetUrl,
          title: view.webContents.getTitle() || '',
          canGoBack: view.webContents.canGoBack(),
          canGoForward: view.webContents.canGoForward(),
          isLoading: view.webContents.isLoading(),
        });
      };

      view.webContents.on('did-start-loading', syncToolbarState);
      view.webContents.on('did-stop-loading', syncToolbarState);
      view.webContents.on('did-navigate', syncToolbarState);
      view.webContents.on('did-navigate-in-page', syncToolbarState);
      view.webContents.on('page-title-updated', syncToolbarState);

      targetWindow.on('resize', () => layoutProxiedBrowserView(targetWindow, view));
      targetWindow.on('maximize', () => layoutProxiedBrowserView(targetWindow, view));
      targetWindow.on('unmaximize', () => layoutProxiedBrowserView(targetWindow, view));
      targetWindow.on('enter-full-screen', () =>
        layoutProxiedBrowserView(targetWindow, view),
      );
      targetWindow.on('leave-full-screen', () =>
        layoutProxiedBrowserView(targetWindow, view),
      );
      targetWindow.on('closed', () => {
        this.proxiedWindowViews.delete(targetWindow.id);
      });

      try {
        await targetWindow.loadURL(makeProxiedToolbarDataUrl(targetWindow.id, proxyUri));
      } catch {
        // ignore
      }
      syncToolbarState();

      const normalizedTarget =
        normalizeProxiedTargetUrl(targetUrl) || 'https://www.google.com';
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
      if (!webContents || webContents.isDestroyed()) return { ok: false };

      switch (command) {
        case 'back':
          if (webContents.canGoBack()) webContents.goBack();
          break;
        case 'forward':
          if (webContents.canGoForward()) webContents.goForward();
          break;
        case 'reload':
          webContents.reload();
          break;
        case 'navigate': {
          const normalized = normalizeProxiedTargetUrl(
            typeof value === 'string' ? value : '',
          );
          if (!normalized) return { ok: false, error: 'invalid-url' };
          webContents.loadURL(normalized).catch(() => {
            // ignore
          });
          break;
        }
        case 'copy-url':
          clipboard.writeText(webContents.getURL() || '');
          break;
        case 'open-external': {
          const currentUrl = webContents.getURL() || '';
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
    child.once('ready-to-show', () => child.show());

    child.webContents.on('will-navigate', (event, navUrl) => {
      try {
        const parsed = new URL(navUrl);
        if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') {
          event.preventDefault();
          void this.openProxiedWindow(parsed.toString(), 'https://www.google.com');
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
          void this.openProxiedWindow(parsed.toString(), 'https://www.google.com');
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
