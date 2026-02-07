import * as React from 'react';
import { MemoryRouter as Router, Routes, Route, Link } from 'react-router-dom';
import './App.css';

type ServiceName = 'yggdrasil' | 'ipfs' | 'web';

type ServiceStatus = {
  name: ServiceName;
  state: 'running' | 'stopped';
  details?: string;
};

const YGG_WEBSITE_INDEX_URL = 'http://[21e:a51c:885b:7db0:166e:927:98cd:d186]/';

const serviceLabel: Record<ServiceName, string> = {
  yggdrasil: 'Yggdrasil 服务',
  ipfs: 'IPFS 服务',
  web: 'Web 服务',
};

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

function LauncherTileLink({
  to,
  label,
  icon,
  disabled,
  disabledHint,
}: {
  to: string;
  label: string;
  icon: string;
  disabled: boolean;
  disabledHint?: string;
}) {
  if (disabled) {
    return (
      <div
        className="LauncherTile isDisabled"
        role="button"
        aria-disabled="true"
        title={disabledHint ?? '需要先启动 Yggdrasil 服务'}
      >
        <div className="LauncherIcon" aria-hidden>
          {icon}
        </div>
        <div className="LauncherLabel">{label}</div>
        <div className="LauncherHint">需要先启动 Yggdrasil</div>
      </div>
    );
  }

  return (
    <Link className="LauncherTile" to={to} aria-label={label}>
      <div className="LauncherIcon" aria-hidden>
        {icon}
      </div>
      <div className="LauncherLabel">{label}</div>
    </Link>
  );
}

function LauncherTileExternalLink({
  href,
  label,
  icon,
  disabled,
  disabledHint,
}: {
  href: string;
  label: string;
  icon: string;
  disabled: boolean;
  disabledHint?: string;
}) {
  if (disabled) {
    return (
      <div
        className="LauncherTile isDisabled"
        role="button"
        aria-disabled="true"
        title={disabledHint ?? 'Requires Yggdrasil to be running'}
      >
        <div className="LauncherIcon" aria-hidden>
          {icon}
        </div>
        <div className="LauncherLabel">{label}</div>
        <div className="LauncherHint">Start Yggdrasil first</div>
      </div>
    );
  }

  return (
    <a
      className="LauncherTile"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
    >
      <div className="LauncherIcon" aria-hidden>
        {icon}
      </div>
      <div className="LauncherLabel">{label}</div>
    </a>
  );
}

function Home() {
  const [services, setServices] = React.useState<ServiceStatus[]>([]);
  const [busy, setBusy] = React.useState<ServiceName | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
        <div className="LauncherSubtitle">请选择一个功能</div>
      </div>

      <div className="LauncherGrid">
        <LauncherTileExternalLink
          href={YGG_WEBSITE_INDEX_URL}
          label="Ygg 网站索引"
          icon="🌐"
          disabled={!yggRunning}
        />

        <LauncherTileLink
          to="/irc"
          label="IRC 聊天索引"
          icon="💬"
          disabled={!yggRunning}
        />

        <LauncherTileLink
          to="/settings"
          label="软件设置"
          icon="⚙️"
          disabled={!yggRunning}
        />

        <LauncherTileLink
          to="/status"
          label="Ygg 状态"
          icon="📡"
          disabled={false}
          disabledHint=""
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
          {services.map((svc) => {
            const isBusy = busy === svc.name;
            const running = svc.state === 'running';
            const locked = svc.name !== 'yggdrasil' && !yggRunning;
            const notImplemented = svc.name !== 'yggdrasil' && (svc.details ?? '').includes('not implemented');
            const disableActions = locked || notImplemented;
            return (
              <div
                key={svc.name}
                className={
                  disableActions && !running
                    ? 'ServiceCard isDisabled'
                    : 'ServiceCard'
                }
              >
                <div className="ServiceCardTop">
                  <div>
                    <div className="ServiceName">{serviceLabel[svc.name]}</div>
                    <div className="ServiceMeta">
                      <span
                        className={running ? 'ServiceDot DotGreen' : 'ServiceDot DotGray'}
                        aria-hidden
                      />
                      <span className="ServiceState">{running ? '运行中' : '未运行'}</span>
                      {svc.details ? (
                        <span className="ServiceDetails">{svc.details}</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="ServiceActions">
                    {running ? (
                      <button
                        type="button"
                        className="ServiceDangerButton"
                        disabled={isBusy || disableActions}
                        onClick={() => stop(svc.name)}
                      >
                        {isBusy ? '处理中…' : '停止'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ServicePrimaryButton"
                        disabled={isBusy || disableActions}
                        onClick={() => start(svc.name)}
                      >
                        {isBusy ? '处理中…' : '启动'}
                      </button>
                    )}
                  </div>
                </div>

                {svc.name === 'yggdrasil' ? (
                  <div className="ServiceHint">
                    点击“启动”时才会弹出 UAC。管理员权限用于创建 TUN 网卡并启动 Yggdrasil。
                  </div>
                ) : locked ? (
                  <div className="ServiceHint">需要先启动 Yggdrasil 服务后才能操作。</div>
                ) : notImplemented ? (
                  <div className="ServiceHint">该服务暂未接入（后续实现）。</div>
                ) : (
                  <div className="ServiceHint">该服务逻辑后续接入。</div>
                )}
              </div>
            );
          })}
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
        <Route path="/irc" element={<PlaceholderPage title="IRC 聊天索引" />} />
        <Route path="/settings" element={<PlaceholderPage title="软件设置" />} />
        <Route path="/status" element={<StatusPage />} />
      </Routes>
    </Router>
  );
}
