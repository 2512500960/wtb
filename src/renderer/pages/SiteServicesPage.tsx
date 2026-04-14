import * as React from 'react';
import { Link } from 'react-router-dom';

import type { ServiceName, ServiceStatus } from '../types/services';
import WebSettingsSection from './settings/WebSettingsSection';

type IpfsDetailedStatus = {
  running: boolean;
  repoDir: string;
  apiUrl: string;
  gatewayUrl: string;
  pid: number | null;
  peerId?: string;
  addresses: string[];
};

type IpfsSwarmPeer = {
  peerId: string;
  address: string;
  latency: string;
  direction: string;
  muxer: string;
  streams: string[];
};

type WebActiveClient = {
  remoteAddress: string;
  lastSeenAt: string;
  requestCount: number;
  recentPaths: string[];
  userAgent: string;
};

type WebRequestRecord = {
  id: number;
  at: string;
  method: string;
  path: string;
  remoteAddress: string;
  userAgent: string;
  statusCode: number;
};

type WebActivitySnapshot = {
  activeWindowMinutes: number;
  activeClients: WebActiveClient[];
  recentRequests: WebRequestRecord[];
  error?: string;
};

type YggSitePreheaterStatus = {
  enabled: boolean;
  running: boolean;
  activeWorkers: number;
  knownTargets: number;
  queuedTargets: number;
  seedTargets: number;
  staticTargets: number;
  discoveredTargets: number;
  lastDiscoveryAt: number | null;
  lastProbeAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
};

type WebRuntimeSettings = {
  autoStartEnabled: boolean;
  preheaterEnabled: boolean;
  preheaterStatus: YggSitePreheaterStatus;
};

const EMPTY_WEB_ACTIVITY: WebActivitySnapshot = {
  activeWindowMinutes: 10,
  activeClients: [],
  recentRequests: [],
};

const EMPTY_PREHEATER_STATUS: YggSitePreheaterStatus = {
  enabled: false,
  running: false,
  activeWorkers: 0,
  knownTargets: 0,
  queuedTargets: 0,
  seedTargets: 0,
  staticTargets: 0,
  discoveredTargets: 0,
  lastDiscoveryAt: null,
  lastProbeAt: null,
  lastSuccessAt: null,
  lastError: null,
};

const EMPTY_RUNTIME_SETTINGS: WebRuntimeSettings = {
  autoStartEnabled: false,
  preheaterEnabled: false,
  preheaterStatus: EMPTY_PREHEATER_STATUS,
};

const formatDateTime = (value: string): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
};

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="ChatModalOverlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
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

export default function SiteServicesPage() {
  const [services, setServices] = React.useState<ServiceStatus[]>([]);
  const [ipfsDetails, setIpfsDetails] =
    React.useState<IpfsDetailedStatus | null>(null);
  const [ipfsSwarmPeers, setIpfsSwarmPeers] = React.useState<IpfsSwarmPeer[]>(
    [],
  );
  const [webActivity, setWebActivity] =
    React.useState<WebActivitySnapshot>(EMPTY_WEB_ACTIVITY);
  const [runtimeSettings, setRuntimeSettings] =
    React.useState<WebRuntimeSettings>(EMPTY_RUNTIME_SETTINGS);
  const [busy, setBusy] = React.useState<ServiceName | null>(null);
  const [settingsBusy, setSettingsBusy] = React.useState<
    'webAutoStart' | 'preheater' | null
  >(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copyHint, setCopyHint] = React.useState<string | null>(null);
  const [showWebClients, setShowWebClients] = React.useState(false);
  const [showIpfsPeers, setShowIpfsPeers] = React.useState(false);
  const [showIpfsAddresses, setShowIpfsAddresses] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        serviceList,
        detailedIpfs,
        webActivityResult,
        ipfsPeerList,
        runtimeSettingsResult,
      ] = await Promise.all([
        window.electron.ipcRenderer.invoke('services:getAll'),
        window.electron.ipcRenderer.invoke('ipfs:statusDetailed'),
        window.electron.ipcRenderer
          .invoke('wtb:web:getActivity')
          .catch(() => EMPTY_WEB_ACTIVITY),
        window.electron.ipcRenderer.invoke('ipfs:swarmPeers').catch(() => []),
        window.electron.ipcRenderer
          .invoke('wtb:web:getRuntimeSettings')
          .catch(() => ({ ok: true, data: EMPTY_RUNTIME_SETTINGS })),
      ]);

      setServices(serviceList as ServiceStatus[]);
      setIpfsDetails(detailedIpfs as IpfsDetailedStatus);
      setWebActivity(
        (webActivityResult as WebActivitySnapshot) || EMPTY_WEB_ACTIVITY,
      );
      setIpfsSwarmPeers(
        Array.isArray(ipfsPeerList) ? (ipfsPeerList as IpfsSwarmPeer[]) : [],
      );
      const parsedRuntimeSettings = runtimeSettingsResult as {
        ok?: boolean;
        data?: WebRuntimeSettings;
      };
      if (parsedRuntimeSettings?.ok && parsedRuntimeSettings.data) {
        setRuntimeSettings(parsedRuntimeSettings.data);
      } else {
        setRuntimeSettings(EMPTY_RUNTIME_SETTINGS);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  React.useEffect(() => {
    const id = window.setInterval(() => {
      refresh().catch(() => {
        // ignore timer errors
      });
    }, 8000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const showCopyHint = React.useCallback(
    async (label: string, value: string) => {
      const ok = await copyText(value);
      setCopyHint(ok ? `${label}已复制` : '复制失败');
      window.setTimeout(() => setCopyHint(null), 1200);
    },
    [],
  );

  const startWeb = React.useCallback(async () => {
    setBusy('web');
    setError(null);
    try {
      await window.electron.ipcRenderer.invoke('services:start', 'web');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const stopWeb = React.useCallback(async () => {
    setBusy('web');
    setError(null);
    try {
      await window.electron.ipcRenderer.invoke('services:stop', 'web');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const openExternal = React.useCallback((url: string) => {
    try {
      window.electron.ipcRenderer.invoke('open-external', url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const updateWebAutoStart = React.useCallback(
    async (enabled: boolean) => {
      setSettingsBusy('webAutoStart');
      setError(null);
      try {
        const response = (await window.electron.ipcRenderer.invoke(
          'wtb:web:setAutoStartEnabled',
          enabled,
        )) as {
          ok?: boolean;
          data?: WebRuntimeSettings;
          error?: string;
        };
        if (!response?.ok) {
          throw new Error(response?.error || '更新 Web 自动启动设置失败');
        }
        if (response.data) {
          setRuntimeSettings(response.data);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSettingsBusy(null);
      }
    },
    [refresh],
  );

  const updatePreheaterEnabled = React.useCallback(
    async (enabled: boolean) => {
      setSettingsBusy('preheater');
      setError(null);
      try {
        const response = (await window.electron.ipcRenderer.invoke(
          'wtb:web:setPreheaterEnabled',
          enabled,
        )) as {
          ok?: boolean;
          data?: WebRuntimeSettings;
          error?: string;
        };
        if (!response?.ok) {
          throw new Error(response?.error || '更新预热设置失败');
        }
        if (response.data) {
          setRuntimeSettings(response.data);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSettingsBusy(null);
      }
    },
    [refresh],
  );

  const yggRunning =
    services.find((service) => service.name === 'yggdrasil')?.state ===
    'running';
  const webService: ServiceStatus = services.find(
    (service) => service.name === 'web',
  ) ?? {
    name: 'web',
    state: 'stopped',
  };
  const ipfsService: ServiceStatus = services.find(
    (service) => service.name === 'ipfs',
  ) ?? {
    name: 'ipfs',
    state: 'stopped',
  };
  const webRunning = webService.state === 'running';
  const webUrl =
    webService.details && webService.details.startsWith('http')
      ? webService.details
      : null;
  const webBusy = busy === 'web';
  const webAutoStartEnabled = runtimeSettings.autoStartEnabled;
  const preheaterEnabled = runtimeSettings.preheaterEnabled;
  const preheaterStatus =
    runtimeSettings.preheaterStatus ?? EMPTY_PREHEATER_STATUS;
  const webAutoStartBusy = settingsBusy === 'webAutoStart';
  const preheaterBusy = settingsBusy === 'preheater';
  const ipfsGatewayUrl = ipfsDetails?.gatewayUrl ?? null;
  const activeClients = webActivity.activeClients ?? [];
  const recentRequests = webActivity.recentRequests ?? [];
  const ipfsAddresses = ipfsDetails?.addresses ?? [];
  const preheaterStateText = preheaterEnabled
    ? preheaterStatus.running
      ? `运行中，待处理 ${preheaterStatus.queuedTargets} 个，并发 ${preheaterStatus.activeWorkers}`
      : '已启用，等待 Yggdrasil 可用'
    : '未启用';

  let ipfsPeersContent: React.ReactNode;
  if (ipfsService.state !== 'running') {
    ipfsPeersContent = (
      <div className="ServiceHint">IPFS 未运行，暂无 peer 记录。</div>
    );
  } else if (ipfsSwarmPeers.length > 0) {
    ipfsPeersContent = (
      <div className="WebsiteIndexTableWrapper" style={{ marginTop: 0 }}>
        <table className="WebsiteIndexTable">
          <thead>
            <tr>
              <th className="WebsiteIndexHeadCell">Peer ID</th>
              <th className="WebsiteIndexHeadCell">地址</th>
              <th className="WebsiteIndexHeadCell">方向</th>
              <th className="WebsiteIndexHeadCell">延迟</th>
              <th className="WebsiteIndexHeadCell">Muxer</th>
              <th className="WebsiteIndexHeadCell">Streams</th>
            </tr>
          </thead>
          <tbody>
            {ipfsSwarmPeers.slice(0, 50).map((peer) => (
              <tr key={`${peer.peerId}|${peer.address}`}>
                <td
                  className="WebsiteIndexCell"
                  style={{ wordBreak: 'break-all' }}
                >
                  {peer.peerId || '—'}
                </td>
                <td
                  className="WebsiteIndexCell"
                  style={{ wordBreak: 'break-all' }}
                >
                  {peer.address || '—'}
                </td>
                <td className="WebsiteIndexCell">{peer.direction || '—'}</td>
                <td className="WebsiteIndexCell">{peer.latency || '—'}</td>
                <td className="WebsiteIndexCell">{peer.muxer || '—'}</td>
                <td
                  className="WebsiteIndexCell"
                  style={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {peer.streams.length ? peer.streams.join('\n') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else {
    ipfsPeersContent = (
      <div className="ServiceHint">IPFS 正在运行，但当前没有已连接 peers。</div>
    );
  }

  let ipfsAddressesContent: React.ReactNode;
  if (ipfsService.state !== 'running') {
    ipfsAddressesContent = (
      <div className="ServiceHint">IPFS 未运行，暂无节点地址。</div>
    );
  } else if (ipfsAddresses.length > 0) {
    ipfsAddressesContent = (
      <div className="WebsiteIndexTableWrapper" style={{ marginTop: 0 }}>
        <table className="WebsiteIndexTable">
          <thead>
            <tr>
              <th className="WebsiteIndexHeadCell">地址</th>
              <th className="WebsiteIndexHeadCell">操作</th>
            </tr>
          </thead>
          <tbody>
            {ipfsAddresses.map((address) => (
              <tr key={address}>
                <td
                  className="WebsiteIndexCell"
                  style={{ wordBreak: 'break-all' }}
                >
                  {address}
                </td>
                <td className="WebsiteIndexCell">
                  <button
                    type="button"
                    className="ServiceGhostButton"
                    onClick={() => {
                      showCopyHint('IPFS 节点地址', address).catch(() => {
                        // ignore
                      });
                    }}
                  >
                    复制
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else {
    ipfsAddressesContent = (
      <div className="ServiceHint">当前没有可展示的节点地址。</div>
    );
  }

  return (
    <div className="PageRoot">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">站点管理</div>
      </div>

      <div className="PageBody">
        <div className="StatusControls">
          <div className="StatusSummary">
            Web 与 IPFS 服务状态总览
            {loading ? '，刷新中…' : ''}
          </div>
          <button
            type="button"
            className="ServiceGhostButton"
            onClick={() => {
              refresh().catch(() => {
                // ignore
              });
            }}
            disabled={loading}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>

        {error ? <div className="ServiceError">{error}</div> : null}
        {copyHint ? <div className="ServiceHint">{copyHint}</div> : null}

        <div className="SiteServicesStack">
          <div className="SiteServicesGrid">
            <section className="SiteServicePanel">
              <div className="SiteServiceHeader">
                <div>
                  <div className="ServiceTitle">Web 服务</div>
                  <div className="ServiceMeta">
                    <span
                      className={
                        webRunning
                          ? 'ServiceDot DotGreen'
                          : 'ServiceDot DotGray'
                      }
                      aria-hidden
                    />
                    <span className="ServiceState">
                      {webRunning ? '运行中' : '未运行'}
                    </span>
                    {!yggRunning && !webRunning ? (
                      <span className="ServiceDetails">
                        需要先启动 Yggdrasil
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="ServiceActions SiteServiceActions">
                  <button
                    type="button"
                    className="ServiceGhostButton"
                    disabled={!webRunning || !webUrl}
                    onClick={() => {
                      if (!webUrl) return;
                      openExternal(webUrl);
                    }}
                  >
                    查看
                  </button>
                  {webRunning ? (
                    <button
                      type="button"
                      className="ServiceDangerButton"
                      disabled={webBusy}
                      onClick={stopWeb}
                    >
                      {webBusy ? '处理中…' : '停止'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ServicePrimaryButton"
                      disabled={webBusy || !yggRunning}
                      onClick={startWeb}
                    >
                      {webBusy ? '处理中…' : '启动'}
                    </button>
                  )}
                </div>
              </div>

              <div className="ServiceHint">
                Web 服务仅监听 Yggdrasil 网卡地址。目录中的内容会通过本机 HTTP
                服务暴露给其他 Yggdrasil 节点访问。
              </div>

              <div className="ServiceHint">
                主窗口关闭后程序会保留在系统托盘。启用自动启动后，只要 Yggdrasil
                可用，程序启动时会自动拉起 Web 服务。
              </div>

              <div className="SiteInfoList">
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">访问地址</div>
                  <div className="SiteInfoValue">{webUrl ?? '—'}</div>
                  <button
                    type="button"
                    className="ServiceGhostButton SiteInfoButton"
                    disabled={!webUrl}
                    onClick={() => {
                      if (!webUrl) return;
                      showCopyHint('Web 地址', webUrl).catch(() => {
                        // ignore
                      });
                    }}
                  >
                    复制
                  </button>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">活跃客户端</div>
                  <div className="SiteInfoValue">
                    最近 {webActivity.activeWindowMinutes} 分钟内{' '}
                    {activeClients.length} 个
                  </div>
                  <button
                    type="button"
                    className="ServiceGhostButton SiteInfoButton"
                    disabled={!webRunning}
                    onClick={() => setShowWebClients(true)}
                  >
                    查看
                  </button>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">状态说明</div>
                  <div className="SiteInfoValue">
                    {webService.details ?? '—'}
                  </div>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">自动启动</div>
                  <div className="SiteInfoValue">
                    {webAutoStartEnabled ? '已启用' : '未启用'}
                  </div>
                  <button
                    type="button"
                    className="ServiceGhostButton SiteInfoButton"
                    disabled={webAutoStartBusy}
                    onClick={() => {
                      updateWebAutoStart(!webAutoStartEnabled).catch(() => {
                        // ignore
                      });
                    }}
                  >
                    {webAutoStartBusy
                      ? '处理中…'
                      : webAutoStartEnabled
                        ? '禁用'
                        : '启用'}
                  </button>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">路由预热</div>
                  <div className="SiteInfoValue">{preheaterStateText}</div>
                  <button
                    type="button"
                    className="ServiceGhostButton SiteInfoButton"
                    disabled={preheaterBusy}
                    onClick={() => {
                      updatePreheaterEnabled(!preheaterEnabled).catch(() => {
                        // ignore
                      });
                    }}
                  >
                    {preheaterBusy
                      ? '处理中…'
                      : preheaterEnabled
                        ? '禁用'
                        : '启用'}
                  </button>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">预热目标</div>
                  <div className="SiteInfoValue">
                    {`${preheaterStatus.knownTargets} 个（索引种子 ${preheaterStatus.seedTargets} / 默认页面 ${preheaterStatus.staticTargets} / 索引发现 ${preheaterStatus.discoveredTargets}）`}
                  </div>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">最近发现</div>
                  <div className="SiteInfoValue">
                    {preheaterStatus.lastDiscoveryAt
                      ? formatDateTime(
                          new Date(
                            preheaterStatus.lastDiscoveryAt,
                          ).toISOString(),
                        )
                      : '—'}
                  </div>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">最近成功预热</div>
                  <div className="SiteInfoValue">
                    {preheaterStatus.lastSuccessAt
                      ? formatDateTime(
                          new Date(preheaterStatus.lastSuccessAt).toISOString(),
                        )
                      : '—'}
                  </div>
                </div>
                {preheaterStatus.lastError ? (
                  <div className="SiteInfoRow">
                    <div className="SiteInfoLabel">最近错误</div>
                    <div className="SiteInfoValue">
                      {preheaterStatus.lastError}
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="SiteServicePanel">
              <div className="SiteServiceHeader">
                <div>
                  <div className="ServiceTitle">IPFS 服务</div>
                  <div className="ServiceMeta">
                    <span
                      className={
                        ipfsService.state === 'running'
                          ? 'ServiceDot DotGreen'
                          : 'ServiceDot DotGray'
                      }
                      aria-hidden
                    />
                    <span className="ServiceState">
                      {ipfsService.state === 'running' ? '运行中' : '未运行'}
                    </span>
                    <span className="ServiceDetails">
                      自动跟随 Yggdrasil 启停
                    </span>
                  </div>
                </div>

                <div className="ServiceActions SiteServiceActions">
                  <button
                    type="button"
                    className="ServiceGhostButton"
                    disabled={
                      !ipfsGatewayUrl || ipfsService.state !== 'running'
                    }
                    onClick={() => {
                      if (!ipfsGatewayUrl) return;
                      openExternal(ipfsGatewayUrl);
                    }}
                  >
                    打开 Gateway
                  </button>
                </div>
              </div>

              <div className="ServiceHint">
                IPFS 用于缓存和分发静态资源，当前会随 Yggdrasil
                服务联动启动和停止。
              </div>

              <div className="SiteInfoList">
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">Repo 目录</div>
                  <div className="SiteInfoValue">
                    {ipfsDetails?.repoDir ?? '—'}
                  </div>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">API</div>
                  <div className="SiteInfoValue">
                    {ipfsDetails?.apiUrl ?? '—'}
                  </div>
                  <button
                    type="button"
                    className="ServiceGhostButton SiteInfoButton"
                    disabled={!ipfsDetails?.apiUrl}
                    onClick={() => {
                      if (!ipfsDetails?.apiUrl) return;
                      showCopyHint('IPFS API', ipfsDetails.apiUrl).catch(() => {
                        // ignore
                      });
                    }}
                  >
                    复制
                  </button>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">Gateway</div>
                  <div className="SiteInfoValue">{ipfsGatewayUrl ?? '—'}</div>
                  <button
                    type="button"
                    className="ServiceGhostButton SiteInfoButton"
                    disabled={!ipfsGatewayUrl}
                    onClick={() => {
                      if (!ipfsGatewayUrl) return;
                      showCopyHint('IPFS Gateway', ipfsGatewayUrl).catch(() => {
                        // ignore
                      });
                    }}
                  >
                    复制
                  </button>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">Peer ID</div>
                  <div className="SiteInfoValue">
                    {ipfsDetails?.peerId ?? '—'}
                  </div>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">连接 peers</div>
                  <div className="SiteInfoValue">
                    {ipfsSwarmPeers.length || '—'}
                  </div>
                  <button
                    type="button"
                    className="ServiceGhostButton SiteInfoButton"
                    disabled={ipfsService.state !== 'running'}
                    onClick={() => setShowIpfsPeers(true)}
                  >
                    查看
                  </button>
                </div>
                <div className="SiteInfoRow">
                  <div className="SiteInfoLabel">节点地址</div>
                  <div className="SiteInfoValue">
                    {ipfsAddresses.length ? `${ipfsAddresses.length} 个` : '—'}
                  </div>
                  <button
                    type="button"
                    className="ServiceGhostButton SiteInfoButton"
                    disabled={
                      ipfsService.state !== 'running' || !ipfsAddresses.length
                    }
                    onClick={() => setShowIpfsAddresses(true)}
                  >
                    查看
                  </button>
                </div>
              </div>
            </section>
          </div>

          <WebSettingsSection />
        </div>

        <ModalShell
          open={showWebClients}
          onClose={() => setShowWebClients(false)}
          title={`Web 在线客户端记录（${activeClients.length}）`}
        >
          {activeClients.length > 0 ? (
            <div className="WebsiteIndexTableWrapper" style={{ marginTop: 0 }}>
              <table className="WebsiteIndexTable">
                <thead>
                  <tr>
                    <th className="WebsiteIndexHeadCell">客户端</th>
                    <th className="WebsiteIndexHeadCell">最后访问</th>
                    <th className="WebsiteIndexHeadCell">请求数</th>
                    <th className="WebsiteIndexHeadCell">最近路径</th>
                    <th className="WebsiteIndexHeadCell">User-Agent</th>
                  </tr>
                </thead>
                <tbody>
                  {activeClients.map((client) => (
                    <tr key={`${client.remoteAddress}:${client.lastSeenAt}`}>
                      <td className="WebsiteIndexCell">
                        {client.remoteAddress}
                      </td>
                      <td className="WebsiteIndexCell">
                        {formatDateTime(client.lastSeenAt)}
                      </td>
                      <td className="WebsiteIndexCell">
                        {client.requestCount}
                      </td>
                      <td
                        className="WebsiteIndexCell"
                        style={{
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all',
                        }}
                      >
                        {client.recentPaths.length
                          ? client.recentPaths.join('\n')
                          : '—'}
                      </td>
                      <td
                        className="WebsiteIndexCell"
                        style={{ wordBreak: 'break-word' }}
                      >
                        {client.userAgent || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="ServiceHint">当前没有活跃客户端记录。</div>
          )}

          <div className="ServiceHint SiteSectionHint">最近请求</div>
          {recentRequests.length > 0 ? (
            <div className="WebsiteIndexTableWrapper">
              <table className="WebsiteIndexTable">
                <thead>
                  <tr>
                    <th className="WebsiteIndexHeadCell">时间</th>
                    <th className="WebsiteIndexHeadCell">客户端</th>
                    <th className="WebsiteIndexHeadCell">方法</th>
                    <th className="WebsiteIndexHeadCell">路径</th>
                    <th className="WebsiteIndexHeadCell">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRequests.slice(0, 20).map((record) => (
                    <tr key={record.id}>
                      <td className="WebsiteIndexCell">
                        {formatDateTime(record.at)}
                      </td>
                      <td className="WebsiteIndexCell">
                        {record.remoteAddress}
                      </td>
                      <td className="WebsiteIndexCell">{record.method}</td>
                      <td
                        className="WebsiteIndexCell"
                        style={{ wordBreak: 'break-all' }}
                      >
                        {record.path}
                      </td>
                      <td className="WebsiteIndexCell">
                        {record.statusCode || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="ServiceHint">当前还没有请求记录。</div>
          )}
        </ModalShell>

        <ModalShell
          open={showIpfsPeers}
          onClose={() => setShowIpfsPeers(false)}
          title={`IPFS 连接详情（${ipfsSwarmPeers.length}）`}
        >
          {ipfsPeersContent}
        </ModalShell>

        <ModalShell
          open={showIpfsAddresses}
          onClose={() => setShowIpfsAddresses(false)}
          title={`IPFS 节点地址（${ipfsAddresses.length}）`}
        >
          {ipfsAddressesContent}
        </ModalShell>
      </div>
    </div>
  );
}
