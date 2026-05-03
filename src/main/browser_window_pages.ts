import { escapeHtml } from './web_service_utils';

const toHtmlDataUrl = (html: string): string => {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

const serializeForInlineScript = (value: unknown): string => {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
};

export const makeWtbProbeLoadingDataUrl = (targetUrl: string): string => {
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
            <p class="title">正在打开…</p>
            <div class="sub">${safeUrl}</div>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;

  return toHtmlDataUrl(html);
};

export const makeNavigationFailureDataUrl = (opts: {
  targetUrl: string;
  title?: string;
  hint?: string;
  buttonLabel?: string;
  errorDetail?: string;
}): string => {
  const safeUrl = escapeHtml(opts.targetUrl || '');
  const safeTitle = escapeHtml(opts.title || '页面暂时没跑起来');
  const safeHint = escapeHtml(
    opts.hint || '请检查网络、代理或服务状态后，再试一次。',
  );
  const safeButtonLabel = escapeHtml(opts.buttonLabel || '重新尝试');
  const safeDetail = escapeHtml(opts.errorDetail || '');
  const retryTarget = serializeForInlineScript(opts.targetUrl || '');
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-top: #f4ede1;
        --bg-bottom: #d6cab2;
        --ink: #1f1913;
        --paper: rgba(255, 252, 245, 0.78);
        --paper-border: rgba(31, 25, 19, 0.16);
        --accent: #1f1913;
        --accent-contrast: #f7f1e8;
        --muted: rgba(31, 25, 19, 0.72);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top, rgba(255,255,255,0.72), transparent 40%),
          linear-gradient(180deg, var(--bg-top) 0%, var(--bg-bottom) 100%);
      }

      .card {
        width: min(760px, 100%);
        padding: 26px;
        border-radius: 24px;
        background: var(--paper);
        border: 1px solid var(--paper-border);
        box-shadow: 0 24px 50px rgba(31, 25, 19, 0.16);
        backdrop-filter: blur(10px);
      }

      .hero {
        display: grid;
        grid-template-columns: 156px minmax(0, 1fr);
        gap: 22px;
        align-items: center;
      }

      .scene {
        position: relative;
        height: 126px;
        border-radius: 18px;
        overflow: hidden;
        background: linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0.22));
        border: 1px solid rgba(31, 25, 19, 0.1);
      }

      .ground {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 18px;
        height: 3px;
        background: rgba(31, 25, 19, 0.28);
      }

      .dino {
        position: absolute;
        left: 18px;
        bottom: 21px;
        width: 86px;
        height: 52px;
        animation: hop 1.8s steps(2, end) infinite;
      }

      .dino svg,
      .cactus svg {
        display: block;
        width: 100%;
        height: 100%;
        fill: currentColor;
      }

      .cactus {
        position: absolute;
        right: 20px;
        bottom: 21px;
        width: 20px;
        height: 38px;
        color: rgba(31, 25, 19, 0.82);
      }

      @keyframes hop {
        0%, 100% { transform: translateY(0); }
        35% { transform: translateY(-9px); }
        50% { transform: translateY(-2px); }
      }

      h1 {
        margin: 0;
        font-size: clamp(24px, 3.5vw, 32px);
        line-height: 1.1;
      }

      .hint {
        margin: 12px 0 0;
        font-size: 14px;
        line-height: 1.6;
        color: var(--muted);
      }

      .url,
      .detail {
        margin-top: 16px;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid rgba(31, 25, 19, 0.1);
        background: rgba(255, 255, 255, 0.46);
      }

      .label {
        display: block;
        margin-bottom: 6px;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(31, 25, 19, 0.55);
      }

      .value {
        margin: 0;
        font-family: "Cascadia Mono", "Consolas", monospace;
        font-size: 13px;
        line-height: 1.6;
        word-break: break-all;
      }

      .actions {
        display: flex;
        gap: 12px;
        margin-top: 20px;
        flex-wrap: wrap;
      }

      button {
        appearance: none;
        border: none;
        border-radius: 999px;
        padding: 12px 18px;
        background: var(--accent);
        color: var(--accent-contrast);
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      button:hover {
        transform: translateY(-1px);
        box-shadow: 0 10px 24px rgba(31, 25, 19, 0.18);
      }

      button:active {
        transform: translateY(0);
      }

      .ghost {
        background: rgba(31, 25, 19, 0.08);
        color: var(--ink);
      }

      @media (max-width: 680px) {
        .card { padding: 20px; }
        .hero { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <section class="hero">
        <div class="scene" aria-hidden="true">
          <div class="dino">
            <svg viewBox="0 0 86 52" xmlns="http://www.w3.org/2000/svg">
              <rect x="12" y="2" width="30" height="8" />
              <rect x="8" y="10" width="42" height="8" />
              <rect x="4" y="18" width="50" height="8" />
              <rect x="16" y="26" width="34" height="8" />
              <rect x="24" y="34" width="10" height="8" />
              <rect x="40" y="34" width="10" height="8" />
              <rect x="54" y="12" width="12" height="8" />
              <rect x="62" y="20" width="8" height="8" />
              <rect x="66" y="28" width="8" height="8" />
              <rect x="70" y="36" width="8" height="8" />
              <rect x="0" y="22" width="8" height="8" />
              <rect x="2" y="30" width="8" height="8" />
              <rect x="8" y="38" width="8" height="8" />
              <rect x="54" y="0" width="8" height="8" />
            </svg>
          </div>
          <div class="cactus">
            <svg viewBox="0 0 20 38" xmlns="http://www.w3.org/2000/svg">
              <rect x="8" y="0" width="4" height="38" />
              <rect x="0" y="8" width="4" height="12" />
              <rect x="4" y="8" width="4" height="4" />
              <rect x="12" y="12" width="4" height="4" />
              <rect x="16" y="12" width="4" height="14" />
            </svg>
          </div>
          <div class="ground"></div>
        </div>
        <div>
          <h1>${safeTitle}</h1>
          <p class="hint">${safeHint}</p>
          <section class="url">
            <span class="label">目标地址</span>
            <p class="value">${safeUrl}</p>
          </section>
          ${safeDetail ? `<section class="detail"><span class="label">错误信息</span><p class="value">${safeDetail}</p></section>` : ''}
          <div class="actions">
            <button id="retry" type="button">${safeButtonLabel}</button>
            <button class="ghost" id="copy" type="button">复制地址</button>
          </div>
        </div>
      </section>
    </main>
    <script>
      const retryTarget = ${retryTarget};
      const retryButton = document.getElementById('retry');
      const copyButton = document.getElementById('copy');

      retryButton.addEventListener('click', () => {
        if (!retryTarget) return;
        window.location.replace(retryTarget);
      });

      copyButton.addEventListener('click', async () => {
        if (!retryTarget || !navigator.clipboard) return;
        try {
          await navigator.clipboard.writeText(retryTarget);
          copyButton.textContent = '已复制';
          window.setTimeout(() => {
            copyButton.textContent = '复制地址';
          }, 1200);
        } catch {
          // ignore
        }
      });
    </script>
  </body>
</html>`;

  return toHtmlDataUrl(html);
};

export const makeProxiedToolbarDataUrl = (opts: {
  windowId: number;
  height: number;
}): string => {
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
        background: #fdfdfd;
        font-family: "Segoe UI", system-ui, sans-serif;
        color: rgba(255, 255, 255, 0.94);
      }

      .bar {
        height: ${opts.height}px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: linear-gradient(180deg, #161b24 0%, #121720 100%);
        box-sizing: border-box;
      }

      button {
        flex: 0 0 auto;
        height: 30px;
        min-width: 30px;
        padding: 0 10px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 9px;
        background: rgba(255, 255, 255, 0.05);
        color: inherit;
        cursor: pointer;
        font: inherit;
        line-height: 1;
        white-space: nowrap;
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
        flex: 1 1 220px;
        min-width: 0;
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
        flex: 0 0 4px;
        width: 4px;
      }

      .title {
        flex: 0 1 160px;
        min-width: 0;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.86);
      }

      .status {
        flex: 0 1 96px;
        min-width: 0;
        font-size: 12px;
        opacity: 0.7;
        color: rgba(255, 255, 255, 0.7);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .status.error {
        color: #ff9d9d;
        opacity: 1;
      }

      .stats {
        flex: 0 1 240px;
        min-width: 0;
        max-width: 240px;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.78);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      @media (max-width: 1180px) {
        .title {
          display: none;
        }
      }

      @media (max-width: 1040px) {
        .stats {
          display: none;
        }
      }

      @media (max-width: 900px) {
        .status {
          display: none;
        }
      }

      @media (max-width: 760px) {
        .bar {
          gap: 6px;
          padding: 0 8px;
        }

        .spacer,
        .title,
        .stats,
        .status {
          display: none;
        }

        input {
          flex-basis: 140px;
        }
      }

      @media (max-width: 620px) {
        #copy,
        #external {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <form class="bar" id="toolbar-form">
      <button id="back" type="button" title="后退">◀</button>
      <button id="forward" type="button" title="前进">▶</button>
      <button id="reload" type="button" title="刷新">刷新</button>
      <input id="address" type="text" spellcheck="false" autocomplete="off" aria-label="地址栏" />
      <button id="go" type="submit" title="前往">Go</button>
      <button id="copy" type="button" title="复制当前地址">复制</button>
      <button id="external" type="button" title="用系统浏览器打开当前页面">浏览器</button>
      <div class="spacer"></div>
      <div class="title" id="title"></div>
      <div class="stats" id="stats"></div>
      <div class="status" id="status"></div>
      <button id="close" type="button" title="关闭窗口">关闭</button>
    </form>
    <script>
      const invoke = (cmd, value) =>
        window.electron.ipcRenderer.invoke('proxied-window-command', ${opts.windowId}, cmd, value);

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
      const stats = document.getElementById('stats');
      let errorText = '';

      const formatBytes = (value) => {
        const bytes = Number.isFinite(value) ? Math.max(0, value) : 0;
        if (bytes < 1024) return String(Math.round(bytes)) + ' B';
        if (bytes < 1024 * 1024) {
          return (
            (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KB'
          );
        }
        if (bytes < 1024 * 1024 * 1024) {
          return (
            (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) +
            ' MB'
          );
        }
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
      };

      const renderStats = (state) => {
        const totalReceivedBytes =
          state && typeof state.totalReceivedBytes === 'number'
            ? state.totalReceivedBytes
            : 0;
        const downloadRateBytesPerSecond =
          state && typeof state.downloadRateBytesPerSecond === 'number'
            ? state.downloadRateBytesPerSecond
            : 0;
        const avgResponseLatencyMs =
          state && typeof state.avgResponseLatencyMs === 'number'
            ? state.avgResponseLatencyMs
            : null;

        stats.textContent = [
          '下行 ' + formatBytes(totalReceivedBytes),
          formatBytes(downloadRateBytesPerSecond) + '/s',
          avgResponseLatencyMs === null
            ? '响应 --'
            : '响应 ' + String(Math.round(avgResponseLatencyMs)) + ' ms',
        ].join(' · ');
      };

      const renderStatus = (state) => {
        const stateError = state && typeof state.errorText === 'string' ? state.errorText : '';
        const text = errorText || stateError;
        if (text) {
          status.textContent = text;
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
        renderStats(state);
        if (!state.errorText && !state.isLoading) {
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

  return toHtmlDataUrl(html);
};
