import * as React from 'react';
import { MemoryRouter as Router, Routes, Route, Link } from 'react-router-dom';
import './App.css';
import { ServiceName, ServiceStatus } from './types/services';
import LauncherTileLink from './components/Launcher/LauncherTileLink';
import LauncherTileExternalLink from './components/Launcher/LauncherTileExternalLink';
import ServiceCard from './components/ServiceCard/ServiceCard';
import ChatPage from './pages/ChatPage';

const YGG_WEBSITE_INDEX_URL = 'http://[21e:a51c:885b:7db0:166e:927:98cd:d186]/';

const YGG_MINI_WIKI_URL = 'http://[201:f536:8bb3:f51d:3377:70d4:fb3b:a829]/';

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

  const openExternal = React.useCallback((url: string) => {
    try {
      // Prefer in-app opening via main process
      window.electron.ipcRenderer.invoke('open-in-app', url);
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
        {/* <div className="LauncherSubtitle">请选择一个功能</div> */}
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
          <button className="ServiceGhostButton" type="button" onClick={refresh}>
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
      commandDefs.map((d) => [d.cmd, { busy: false, result: null, error: null }]),
    ) as Record<YggdrasilCtlCommand, CommandCardState>;
  }, [commandDefs]);

  const [items, setItems] = React.useState<Record<YggdrasilCtlCommand, CommandCardState>>(
    () => buildInitial(),
  );

  const runIdRef = React.useRef(0);

  const runAll = React.useCallback(async () => {
    const runId = ++runIdRef.current;

    setItems((prev) => {
      const next: Record<YggdrasilCtlCommand, CommandCardState> = { ...prev };
      for (const d of commandDefs) {
        next[d.cmd] = { busy: true, result: null, error: null };
      }
      return next;
    });

    for (const d of commandDefs) {
      window.electron.ipcRenderer
        .invoke('yggdrasilctl:run', d.cmd)
        .then((res) => {
          if (runIdRef.current !== runId) return;
          setItems((prev) => ({
            ...prev,
            [d.cmd]: { busy: false, result: res as YggdrasilCtlResult, error: null },
          }));
        })
        .catch((e) => {
          if (runIdRef.current !== runId) return;
          const message = e instanceof Error ? e.message : String(e);
          setItems((prev) => ({
            ...prev,
            [d.cmd]: { busy: false, result: null, error: message },
          }));
        });
    }
  }, [commandDefs]);

  React.useEffect(() => {
    runAll();
  }, [runAll]);

  const busyCount = commandDefs.reduce((acc, d) => acc + (items[d.cmd]?.busy ? 1 : 0), 0);

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
                    {d.label} <span className="StatusBlockDesc">- {d.desc}</span>
                  </div>

                  {item?.busy ? (
                    <span className="StatusOk">加载中…</span>
                  ) : item?.error ? (
                    <span className="StatusBad">ERROR</span>
                  ) : result ? (
                    <span className={result.ok ? 'StatusOk' : 'StatusBad'}>
                      {result.ok ? 'OK' : 'ERROR'}
                    </span>
                  ) : (
                    <span className="StatusOk">等待</span>
                  )}
                </div>

                {item?.error ? <div className="ServiceError">{item.error}</div> : null}

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

                {!item?.busy && !item?.error && result && !showStdout && !showStderr ? (
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
        <Route path="/settings" element={<PlaceholderPage title="软件设置" />} />
        <Route path="/status" element={<StatusPage />} />
      </Routes>
    </Router>
  );
}
