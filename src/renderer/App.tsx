import * as React from 'react';
import { MemoryRouter as Router, Routes, Route, Link } from 'react-router-dom';
import './App.css';
import { ServiceName, ServiceStatus } from './types/services';
import LauncherTileLink from './components/Launcher/LauncherTileLink';
import LauncherTileExternalLink from './components/Launcher/LauncherTileExternalLink';
import ServiceCard from './components/ServiceCard/ServiceCard';
import ChatPage from './pages/ChatPage';

const YGG_WEBSITE_INDEX_URL = 'http://[21e:a51c:885b:7db0:166e:927:98cd:d186]/';

const YGG_MINI_WIKI_URL =
  'http://[200:85b:60c4:e7b5:c33b:959f:9b52:6783]/?lang=zh';

type YggdrasilCtlCommand =
  | 'getself'
  | 'getpeers'
  | 'getsessions'
  | 'getpaths'
  | 'gettree'
  | 'gettun'
  | 'getp2ppeers'
  | 'getmulticastinterfaces'
  | 'list';

type YggdrasilCtlResult = {
  ok: boolean;
  command: YggdrasilCtlCommand;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

// LauncherTile and ServiceCard components extracted to separate files

function Home() {
  const [services, setServices] = React.useState<ServiceStatus[]>([]);
  const [busy, setBusy] = React.useState<ServiceName | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [connectedPeerCount, setConnectedPeerCount] = React.useState<
    number | null
  >(null);
  const [p2pPeerCount, setP2pPeerCount] = React.useState<number | null>(null);

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

  const tryParseJson = React.useCallback((input: string) => {
    const trimmed = (input ?? '').trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }, []);

  const countFromYggCtlStdout = React.useCallback(
    (stdout: string): number | null => {
      const data = tryParseJson(stdout);
      if (data == null) return null;

      if (Array.isArray(data)) return data.length;

      if (typeof data === 'object') {
        const obj = data as Record<string, unknown>;

        const peers = obj.peers ?? obj.Peers;
        if (Array.isArray(peers)) return peers.length;
        if (peers && typeof peers === 'object') {
          return Object.keys(peers as Record<string, unknown>).length;
        }

        return Object.keys(obj).length;
      }

      return null;
    },
    [tryParseJson],
  );

  const refreshPeerCounts = React.useCallback(async () => {
    try {
      const [peersResRaw, p2pResRaw] = await Promise.all([
        window.electron.ipcRenderer.invoke('yggdrasilctl:run', 'getpeers'),
        window.electron.ipcRenderer.invoke('yggdrasilctl:run', 'getp2ppeers'),
      ]);
      const peersRes = peersResRaw as Partial<YggdrasilCtlResult> | null;
      const p2pRes = p2pResRaw as Partial<YggdrasilCtlResult> | null;

      const connected =
        peersRes && peersRes.ok
          ? countFromYggCtlStdout(String(peersRes.stdout ?? ''))
          : null;
      const p2p =
        p2pRes && p2pRes.ok
          ? countFromYggCtlStdout(String(p2pRes.stdout ?? ''))
          : null;

      setConnectedPeerCount(connected);
      setP2pPeerCount(p2p);
    } catch {
      setConnectedPeerCount(null);
      setP2pPeerCount(null);
    }
  }, [countFromYggCtlStdout]);

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
          </div>
        </div>
      </div>

      <div className="LauncherGrid">
        <LauncherTileExternalLink
          href={YGG_WEBSITE_INDEX_URL}
          label="Ygg 网站索引"
          icon="🌐"
          disabled={!yggRunning}
        />

        <LauncherTileExternalLink
          href={YGG_MINI_WIKI_URL}
          label="Mini 维基"
          icon="📚"
          disabled={!yggRunning}
        />
        <LauncherTileLink
          to="/irc"
          label="聊天（libp2p）"
          icon="💬"
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

function StatusPage() {
  const commandDefs = React.useMemo(
    () =>
      [
        { cmd: 'getself', label: 'getself', desc: '本机信息' },
        { cmd: 'getpeers', label: 'getpeers', desc: '直连 peers' },
        { cmd: 'getsessions', label: 'getsessions', desc: '会话' },
        { cmd: 'getpaths', label: 'getpaths', desc: '已建立路径' },
        { cmd: 'gettree', label: 'gettree', desc: 'Tree 表' },
        { cmd: 'gettun', label: 'gettun', desc: 'TUN 信息' },
        { cmd: 'getp2ppeers', label: 'getp2ppeers', desc: 'libp2p peers' },
        {
          cmd: 'getmulticastinterfaces',
          label: 'getmulticastinterfaces',
          desc: '组播接口',
        },
        { cmd: 'list', label: 'list', desc: '命令列表' },
      ] as const,
    [],
  );

  type CommandCardState = {
    busy: boolean;
    result: YggdrasilCtlResult | null;
    error: string | null;
  };

  const buildInitial = React.useCallback(() => {
    return Object.fromEntries(
      commandDefs.map((d) => [
        d.cmd,
        { busy: false, result: null, error: null },
      ]),
    ) as Record<YggdrasilCtlCommand, CommandCardState>;
  }, [commandDefs]);

  const [items, setItems] = React.useState<
    Record<YggdrasilCtlCommand, CommandCardState>
  >(() => buildInitial());

  const runIdRef = React.useRef(0);

  const runAll = React.useCallback(async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    setItems((prev) => {
      const next: Record<YggdrasilCtlCommand, CommandCardState> = { ...prev };
      commandDefs.forEach((d) => {
        next[d.cmd] = { busy: true, result: null, error: null };
      });
      return next;
    });

    const promises = commandDefs.map((d) =>
      window.electron.ipcRenderer
        .invoke('yggdrasilctl:run', d.cmd)
        .then((res) => {
          if (runIdRef.current !== runId) return res;
          setItems((prev) => ({
            ...prev,
            [d.cmd]: {
              busy: false,
              result: res as YggdrasilCtlResult,
              error: null,
            },
          }));
          return res;
        })
        .catch((e) => {
          if (runIdRef.current !== runId) throw e;
          const message = e instanceof Error ? e.message : String(e);
          setItems((prev) => ({
            ...prev,
            [d.cmd]: { busy: false, result: null, error: message },
          }));
          throw e;
        }),
    );

    // observe all promises to avoid unhandled rejections; we don't need their results here
    await Promise.allSettled(promises);
  }, [commandDefs]);

  React.useEffect(() => {
    runAll();
  }, [runAll]);

  const busyCount = commandDefs.reduce(
    (acc, d) => acc + (items[d.cmd]?.busy ? 1 : 0),
    0,
  );

  return (
    <div className="PageRoot">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">Yggdrasil 状态</div>
      </div>

      <div className="PageBody">
        <div className="StatusControls">
          <div className="StatusSummary">
            共 {commandDefs.length} 条命令
            {busyCount ? `，加载中：${busyCount}` : ''}
          </div>
          <button
            type="button"
            className="ServiceGhostButton"
            onClick={runAll}
            disabled={busyCount > 0}
          >
            {busyCount > 0 ? '刷新中…' : '刷新全部'}
          </button>
        </div>

        <div className="StatusBlocks">
          {commandDefs.map((d) => {
            const item = items[d.cmd];
            const result = item?.result;
            const showStderr = (result?.stderr ?? '').trim().length > 0;
            const showStdout = (result?.stdout ?? '').trim().length > 0;
            return (
              <div key={d.cmd} className="StatusBlock">
                <div className="StatusBlockHeader">
                  <div className="StatusBlockTitle">
                    {d.label}{' '}
                    <span className="StatusBlockDesc">- {d.desc}</span>
                  </div>

                  {(() => {
                    if (item?.busy) {
                      return <span className="StatusOk">加载中…</span>;
                    }
                    if (item?.error) {
                      return <span className="StatusBad">ERROR</span>;
                    }
                    if (result) {
                      if (result.ok) {
                        return <span className="StatusOk">OK</span>;
                      }
                      return <span className="StatusBad">ERROR</span>;
                    }
                    return <span className="StatusOk">等待</span>;
                  })()}
                </div>

                {item?.error ? (
                  <div className="ServiceError">{item.error}</div>
                ) : null}

                {result ? (
                  <div className="StatusMeta">
                    <span>exit={result.exitCode ?? '-'} </span>
                    <span>耗时={result.durationMs}ms</span>
                  </div>
                ) : null}

                {showStderr ? (
                  <div className="StatusIO">
                    <div className="StatusBlockTitle">stderr</div>
                    <pre className="StatusPre">{result?.stderr}</pre>
                  </div>
                ) : null}

                {showStdout ? (
                  <div className="StatusIO">
                    <div className="StatusBlockTitle">stdout</div>
                    <pre className="StatusPre">{result?.stdout}</pre>
                  </div>
                ) : null}

                {!item?.busy &&
                !item?.error &&
                result &&
                !showStdout &&
                !showStderr ? (
                  <div className="StatusEmpty">无输出</div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="PageRoot">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">{title}</div>
      </div>
      <div className="PageBody">功能开发中…</div>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/ygg" element={<PlaceholderPage title="Ygg 网站索引" />} />
        <Route path="/irc" element={<ChatPage />} />
        <Route
          path="/settings"
          element={<PlaceholderPage title="软件设置" />}
        />
        <Route path="/status" element={<StatusPage />} />
      </Routes>
    </Router>
  );
}
