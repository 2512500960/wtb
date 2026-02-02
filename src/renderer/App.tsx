import * as React from 'react';
import { MemoryRouter as Router, Routes, Route, Link } from 'react-router-dom';
import './App.css';

type ServiceName = 'yggdrasil' | 'ipfs' | 'web';

type ServiceStatus = {
  name: ServiceName;
  state: 'running' | 'stopped';
  details?: string;
};

const serviceLabel: Record<ServiceName, string> = {
  yggdrasil: 'Yggdrasil 服务',
  ipfs: 'IPFS 服务',
  web: 'Web 服务',
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
        <LauncherTileLink
          to="/ygg"
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
      </Routes>
    </Router>
  );
}
