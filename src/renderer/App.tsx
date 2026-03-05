import * as React from 'react';
import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import './App.css';
import { ServiceName, ServiceStatus } from './types/services';
import LauncherTileLink from './components/Launcher/LauncherTileLink';
import LauncherTileExternalLink from './components/Launcher/LauncherTileExternalLink';
import ServiceCard from './components/ServiceCard/ServiceCard';
import ChatPage from './pages/ChatPage';
import SettingsPage from './pages/SettingsPage';
import YggWebsiteIndexPage from './pages/YggWebsiteIndexPage';
// import ServiceAnnouncementsPage from './pages/ServiceAnnouncementsPage'; // 已切换到 HTTP pull 模式
import ServiceSyncPage from './pages/ServiceSyncPage';
import PeersPage from './pages/PeersPage';
import StatusPage from './pages/StatusPage';
import { FEATURES } from './features/flags';
import type { YggdrasilCtlResult } from './types/yggdrasilctl';

const YGG_WEBSITE_INDEX_URL = 'http://[21e:a51c:885b:7db0:166e:927:98cd:d186]/';

const YGG_MINI_WIKI_URL =
  'http://[200:85b:60c4:e7b5:c33b:959f:9b52:6783]/?lang=zh';

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
          width: 'min(980px, calc(100vw - 32px))',
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

  const openExternal = React.useCallback((url: string) => {
    try {
      // Open via system default browser (fast UX for slow/unreliable links)
      window.electron.ipcRenderer.invoke('open-external', url);
    } catch {
      // Fallback to external browser
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

  React.useEffect(() => {
    if (!yggRunning) {
      setYggAddress(null);
      return;
    }

    const cancelled = false;
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

  const openDir = async (name: ServiceName) => {
    setError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'services:openDir',
        name,
      )) as { ok: boolean; error?: string };
      if (res && typeof res === 'object' && res.ok === false) {
        throw new Error(res.error || '打开目录失败');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="LauncherRoot">
      <div className="LauncherHeader">
        <div className="LauncherTitle">WTB</div>
        <div className="LauncherSubtitle">
          YGGDRASIL网络连接能需要时间，网页打不开需要耐心
        </div>
        <div>
          {/* 显示连接成功的Peer数量和P2PPeers数量，（自动刷新功能） */}
          <div className="LauncherSubtitle">
            已连接 Peer：{connectedPeerCount ?? '—'}，P2P Peers：
            {p2pPeerCount ?? '—'}
            <button
              type="button"
              className="ServiceGhostButton"
              style={{ marginLeft: 8, width: 120 }}
              disabled={!yggRunning}
              onClick={() => setShowPeers(true)}
            >
              查看 peers
            </button>
          </div>
          <div className="LauncherSubtitle">
            Yggdrasil IPv6：
            {yggAddress ?? '—'}
            {yggAddress ? (
              <button
                type="button"
                className="ServiceGhostButton"
                style={{ marginLeft: 8 }}
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
      </div>

      <ModalShell
        title="当前连接的 Peers"
        open={showPeers}
        onClose={() => setShowPeers(false)}
      >
        <PeersPage embedded />
      </ModalShell>

      <div className="LauncherGrid">
        <LauncherTileExternalLink
          href={YGG_WEBSITE_INDEX_URL}
          label="Ygg 网站索引"
          icon="🌐"
          disabled={!yggRunning}
        />

        <LauncherTileExternalLink
          href={YGG_MINI_WIKI_URL}
          label="Mini 维基百科"
          icon="📚"
          disabled={!yggRunning}
        />
        <LauncherTileLink
          to="/ygg"
          label="其他网站索引"
          icon="🧭"
          disabled={!yggRunning}
        />

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
        <LauncherTileLink
          to="/announcements"
          label="服务公告"
          icon="📢"
          disabled={!yggRunning}
        />
        <LauncherTileLink
          to="/settings"
          label="软件设置"
          icon="⚙️"
          disabled={!yggRunning}
        />
      </div>

      <div className="ServiceSection">
        <div className="ServiceHeader">
          <div className="ServiceTitle">服务状态</div>
          <button
            className="ServiceGhostButton"
            type="button"
            onClick={refresh}
          >
            刷新
          </button>
        </div>

        {error ? <div className="ServiceError">{error}</div> : null}

        <div className="ServiceGrid">
          {services.map((svc) => (
            <ServiceCard
              key={svc.name}
              svc={svc}
              yggRunning={yggRunning}
              busyName={busy}
              start={start}
              stop={stop}
              openDir={openDir}
              openExternal={openExternal}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/ygg" element={<YggWebsiteIndexPage />} />
        {FEATURES.chat && <Route path="/irc" element={<ChatPage />} />}
        {/* <Route path="/announcements" element={<ServiceAnnouncementsPage />} /> */}
        <Route path="/announcements" element={<ServiceSyncPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/peers" element={<PeersPage embedded={false} />} />
      </Routes>
    </Router>
  );
}
