import * as React from 'react';
import { MemoryRouter as Router, Routes, Route, Link } from 'react-router-dom';
import './App.css';
import { ServiceName, ServiceStatus } from './types/services';
import LauncherTileLink from './components/Launcher/LauncherTileLink';
import ServiceCardYggdrasil from './components/ServiceCard/ServiceCardYggdrasil';
import ChatPage from './pages/ChatPage';
import SettingsPage from './pages/SettingsPage';
// import YggWebsiteIndexPage from './pages/YggWebsiteIndexPage';
// import ServiceAnnouncementsPage from './pages/ServiceAnnouncementsPage';
// import ServiceSyncPage from './pages/ServiceSyncPage';
import PeersPage from './pages/PeersPage';
import RemoteResourcesPage from './pages/RemoteResourcesPage';
import SiteServicesPage from './pages/SiteServicesPage';
import StatusPage from './pages/StatusPage';
import NetworkVisualizePage from './pages/NetworkVisualizePage';
import { FEATURES } from './features/flags';
import type { YggdrasilCtlResult } from './types/yggdrasilctl';
import {
  YGG_MINI_WIKI_URL,
  YGG_WEBSITE_INDEX_IN_APP_URL,
  YGG_WEBSITE_INDEX_URL,
} from '../common/ygg_urls';

type StandaloneRemoteResourcesConfig = {
  baseUrl: string;
  path: string;
};

function getStandaloneRemoteResourcesConfig(): StandaloneRemoteResourcesConfig | null {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search || '');
  if (params.get('wtbView') !== 'remote-resources') {
    return null;
  }

  const baseUrl = (params.get('baseUrl') || '').trim();
  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl,
    path: (params.get('path') || '/').trim() || '/',
  };
}

function ModalShell({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="ChatModalOverlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ChatModal"
        role="dialog"
        aria-modal="true"
        style={{
          width: 'min(1080px, calc(100vw - 32px))',
          maxHeight: 'min(84vh, 860px)',
          overflow: 'auto',
        }}
      >
        <div className="ChatModalHeader">
          <div className="ChatModalTitle">{title}</div>
          <button
            type="button"
            className="ServiceGhostButton"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
        <div className="ChatModalBody">{children}</div>
      </div>
    </div>
  );
}

// LauncherTile and ServiceCard components extracted to separate files

function Home() {
  const [services, setServices] = React.useState<ServiceStatus[]>([]);
  const [busy, setBusy] = React.useState<ServiceName | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [connectedPeerCount, setConnectedPeerCount] = React.useState<
    number | null
  >(null);
  const [p2pPeerCount, setP2pPeerCount] = React.useState<number | null>(null);
  const [yggAddress, setYggAddress] = React.useState<string | null>(null);
  const [showPeers, setShowPeers] = React.useState(false);

  const openInApp = React.useCallback((url: string) => {
    try {
      window.electron.ipcRenderer.invoke('open-in-app', url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const refresh = React.useCallback(async () => {
    setError(null);
    const result = (await window.electron.ipcRenderer.invoke(
      'services:getAll',
    )) as ServiceStatus[];
    setServices(result);
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const ygg = services.find((s) => s.name === 'yggdrasil');
  const yggRunning = ygg?.state === 'running';
  const yggService: ServiceStatus = ygg ?? {
    name: 'yggdrasil',
    state: 'stopped',
  };

  React.useEffect(() => {
    let cancelled = false;

    if (!yggRunning) {
      setYggAddress(null);
    } else {
      (async () => {
        try {
          const addr = (await window.electron.ipcRenderer.invoke(
            'ygg:getIPv6',
          )) as string;
          if (!cancelled) setYggAddress(addr);
        } catch {
          if (!cancelled) setYggAddress(null);
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [yggRunning]);

  const tryParseJson = React.useCallback((input: string) => {
    const trimmed = (input ?? '').trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }, []);

  const countFromYggCtlStdoutP2PPeer = React.useCallback(
    (stdout: string): number | null => {
      const data = tryParseJson(stdout);
      if (data == null) return null;
      // check if data has ygg_peers field and is an array
      if (
        typeof data === 'object' &&
        data !== null &&
        'ygg_peers' in data &&
        Array.isArray((data as Record<string, unknown>).ygg_peers)
      ) {
        return ((data as Record<string, unknown>).ygg_peers as unknown[])
          .length;
      }
      return null;
    },
    [tryParseJson],
  );

  const countFromYggCtlStdoutTranditionalPeer = React.useCallback(
    (stdout: string): number | null => {
      const data = tryParseJson(stdout);
      if (data == null) return null;
      // data is object, use peers field of it
      const obj = data as Record<string, unknown>;
      const peers = obj.peers ?? obj.Peers;
      if (Array.isArray(peers)) {
        // count peers that are "up"; tolerate boolean, numeric and string representations
        const filterData = peers.filter(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            'up' in item &&
            (item as Record<string, unknown>).up,
        );
        // console.log('Filtered peers with up=true:', filterData);
        return filterData.length;
      }
      return null;
    },
    [tryParseJson],
  );

  const refreshPeerCounts = React.useCallback(async () => {
    try {
      const [peersResRaw, p2pResRaw] = await Promise.all([
        window.electron.ipcRenderer.invoke('yggdrasilctl:run', 'getpeersjson'),
        window.electron.ipcRenderer.invoke(
          'yggdrasilctl:run',
          'getp2ppeersjson',
        ),
      ]);
      const peersRes = peersResRaw as Partial<YggdrasilCtlResult> | null;
      const p2pRes = p2pResRaw as Partial<YggdrasilCtlResult> | null;

      const connected =
        peersRes && peersRes.ok
          ? countFromYggCtlStdoutTranditionalPeer(String(peersRes.stdout ?? ''))
          : null;
      const p2p =
        p2pRes && p2pRes.ok
          ? countFromYggCtlStdoutP2PPeer(String(p2pRes.stdout ?? ''))
          : null;

      setConnectedPeerCount(connected);
      setP2pPeerCount(p2p);
    } catch {
      setConnectedPeerCount(null);
      setP2pPeerCount(null);
    }
  }, [countFromYggCtlStdoutP2PPeer, countFromYggCtlStdoutTranditionalPeer]);

  React.useEffect(() => {
    refreshPeerCounts();
    const id = window.setInterval(() => {
      refreshPeerCounts();
    }, 5000);
    return () => window.clearInterval(id);
  }, [refreshPeerCounts]);

  const start = async (name: ServiceName) => {
    setBusy(name);
    setError(null);
    try {
      await window.electron.ipcRenderer.invoke('services:start', name);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const stop = async (name: ServiceName) => {
    setBusy(name);
    setError(null);
    try {
      await window.electron.ipcRenderer.invoke('services:stop', name);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="LauncherRoot">
      <div className="LauncherHeader">
        <div className="LauncherTitle">WTB</div>
        <div className="LauncherSubtitle">
          YGGDRASIL网络连接能需要时间，网页打不开需要耐心
        </div>
        <div className="LauncherStatusRow">
          <div className="LauncherNetworkPanel">
            <div className="LauncherPanelTitle">网络状态</div>
            <div className="LauncherMetricRow">
              <div className="LauncherMetricBlock">
                <div className="LauncherMetricLabel">已连接 Peer</div>
                <div className="LauncherMetricValue">
                  {connectedPeerCount ?? '—'}
                </div>
              </div>
              <div className="LauncherMetricBlock">
                <div className="LauncherMetricLabel">P2P Peers</div>
                <div className="LauncherMetricValue">{p2pPeerCount ?? '—'}</div>
              </div>
              <span style={{ display: 'inline-flex', gap: 8 }}>
                <button
                  type="button"
                  className="ServiceGhostButton LauncherInlineButton"
                  disabled={!yggRunning}
                  onClick={() => setShowPeers(true)}
                >
                  查看 peers
                </button>
                <Link
                  to="/network"
                  className="ServiceGhostButton LauncherInlineButton"
                  style={
                    !yggRunning
                      ? { pointerEvents: 'none', opacity: 0.4 }
                      : undefined
                  }
                  onClick={(e) => {
                    if (!yggRunning) e.preventDefault();
                  }}
                >
                  查看 route
                </Link>
              </span>
            </div>
            <div className="LauncherAddressRow">
              <div className="LauncherMetricLabel">Yggdrasil IPv6</div>
              <div className="LauncherAddressValue">{yggAddress ?? '—'}</div>
              {yggAddress ? (
                <button
                  type="button"
                  className="ServiceGhostButton LauncherInlineButton"
                  onClick={() => {
                    if (!yggAddress) return;
                    try {
                      navigator.clipboard.writeText(yggAddress);
                    } catch {
                      // ignore clipboard errors
                    }
                  }}
                >
                  复制
                </button>
              ) : null}
            </div>
          </div>

          <div className="LauncherYggCard">
            <ServiceCardYggdrasil
              svc={yggService}
              busyName={busy}
              start={start}
              stop={stop}
            />
          </div>
        </div>
      </div>

      <ModalShell
        title="当前连接的 Peers"
        open={showPeers}
        onClose={() => setShowPeers(false)}
      >
        <PeersPage embedded />
      </ModalShell>

      <div className="LauncherGrid">
        <button
          className={yggRunning ? 'LauncherTile' : 'LauncherTile isDisabled'}
          type="button"
          onClick={() => {
            if (!yggRunning) return;
            openInApp(YGG_WEBSITE_INDEX_URL);
          }}
          aria-label="Ygg 网站索引"
          disabled={!yggRunning}
          title={!yggRunning ? '需要先启动 Yggdrasil 服务' : undefined}
        >
          <div className="LauncherIcon" aria-hidden>
            🌐
          </div>
          <div className="LauncherLabel">Ygg 网站索引</div>
          {!yggRunning ? (
            <div className="LauncherHint">需要先启动 Yggdrasil</div>
          ) : null}
        </button>

        {/* 隐藏 Mini 维基百科磁贴
        <button
          className={yggRunning ? 'LauncherTile' : 'LauncherTile isDisabled'}
          type="button"
          onClick={() => {
            if (!yggRunning) return;
            openInApp(YGG_MINI_WIKI_URL);
          }}
          aria-label="Mini 维基百科"
          disabled={!yggRunning}
          title={!yggRunning ? '需要先启动 Yggdrasil 服务' : undefined}
        >
          <div className="LauncherIcon" aria-hidden>
            📚
          </div>
          <div className="LauncherLabel">Mini 维基百科</div>
          {!yggRunning ? (
            <div className="LauncherHint">需要先启动 Yggdrasil</div>
          ) : null}
        </button>
        */}

        <button
          className={yggRunning ? 'LauncherTile' : 'LauncherTile isDisabled'}
          type="button"
          onClick={() => {
            if (!yggRunning) return;
            openInApp(YGG_WEBSITE_INDEX_IN_APP_URL);
          }}
          aria-label="其他网站索引"
          disabled={!yggRunning}
          title={!yggRunning ? '需要先启动 Yggdrasil 服务' : undefined}
        >
          <div className="LauncherIcon" aria-hidden>
            🧭
          </div>
          <div className="LauncherLabel">其他网站索引</div>
          {!yggRunning ? (
            <div className="LauncherHint">需要先启动 Yggdrasil</div>
          ) : null}
        </button>

        <button
          className="LauncherTile"
          type="button"
          onClick={() => {
            try {
              window.electron.ipcRenderer.invoke('cinny:open');
            } catch {
              setError('无法打开 Cinny（IPC 不可用）');
            }
          }}
          aria-label="Matrix (Cinny)"
        >
          <div className="LauncherIcon" aria-hidden>
            🟩
          </div>
          <div className="LauncherLabel">Matrix (Cinny)</div>
        </button>

        <button
          className="LauncherTile"
          type="button"
          onClick={() => {
            try {
              window.electron.ipcRenderer.invoke('element:open');
            } catch {
              setError('无法打开 Element（IPC 不可用）');
            }
          }}
          aria-label="Matrix (Element)"
        >
          <div className="LauncherIcon" aria-hidden>
            🟦
          </div>
          <div className="LauncherLabel">Matrix (Element)</div>
        </button>
        {FEATURES.chat ? (
          <LauncherTileLink
            to="/irc"
            label="聊天"
            icon="💬"
            disabled={!yggRunning}
          />
        ) : null}
        {/* <LauncherTileLink
          to="/resources"
          label="远程资源"
          icon="🎞️"
          disabled={false}
          disabledHint=""
        /> */}
        <LauncherTileLink
          to="/site-services"
          label="站点管理"
          icon="🛰️"
          disabled={false}
          disabledHint=""
        />
        {/* <LauncherTileLink
          to="/announcements"
          label="服务公告"
          icon="📢"
          disabled={!yggRunning}
        /> */}
        <LauncherTileLink
          to="/settings"
          label="软件设置"
          icon="⚙️"
          disabled={false}
        />
      </div>

      {error ? <div className="ServiceError">{error}</div> : null}
    </div>
  );
}

export default function App() {
  const standaloneRemoteResources = getStandaloneRemoteResourcesConfig();

  return (
    <Router initialEntries={[standaloneRemoteResources ? '/resources' : '/']}>
      <Routes>
        <Route path="/" element={<Home />} />
        {/* 临时弃用：保留文件但不再挂载路由 */}
        {/* <Route path="/ygg" element={<YggWebsiteIndexPage />} /> */}
        {FEATURES.chat && <Route path="/irc" element={<ChatPage />} />}
        <Route
          path="/resources"
          element={
            <RemoteResourcesPage
              initialBaseUrl={standaloneRemoteResources?.baseUrl}
              initialPath={standaloneRemoteResources?.path}
              standalone={!!standaloneRemoteResources}
            />
          }
        />
        <Route path="/site-services" element={<SiteServicesPage />} />
        {/* <Route path="/announcements" element={<ServiceAnnouncementsPage />} /> */}
        {/* <Route path="/announcements" element={<ServiceSyncPage />} /> */}
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/peers" element={<PeersPage embedded={false} />} />
        <Route path="/network" element={<NetworkVisualizePage />} />
      </Routes>
    </Router>
  );
}
