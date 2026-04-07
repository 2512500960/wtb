import * as React from 'react';
import { Link } from 'react-router-dom';

import type { ServiceName, ServiceStatus } from '../types/services';

type IpfsDetailedStatus = {
  running: boolean;
  repoDir: string;
  apiUrl: string;
  gatewayUrl: string;
  pid: number | null;
  peerId?: string;
  addresses: string[];
};

type PathResult = {
  ok: boolean;
  path?: string;
  error?: string;
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

export default function SiteServicesPage() {
  const [services, setServices] = React.useState<ServiceStatus[]>([]);
  const [ipfsDetails, setIpfsDetails] =
    React.useState<IpfsDetailedStatus | null>(null);
  const [webRootDir, setWebRootDir] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<ServiceName | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copyHint, setCopyHint] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [serviceList, detailedIpfs, webDirResult] = await Promise.all([
        window.electron.ipcRenderer.invoke('services:getAll'),
        window.electron.ipcRenderer.invoke('ipfs:statusDetailed'),
        window.electron.ipcRenderer.invoke('wtb:web:getDir'),
      ]);

      setServices(serviceList as ServiceStatus[]);
      setIpfsDetails(detailedIpfs as IpfsDetailedStatus);

      const dirRes = webDirResult as PathResult;
      setWebRootDir(dirRes.ok ? (dirRes.path ?? null) : null);
      if (!dirRes.ok && dirRes.error) {
        setError(dirRes.error);
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

  const openDir = React.useCallback(async (name: ServiceName) => {
    setError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'services:openDir',
        name,
      )) as { ok: boolean; error?: string };
      if (res && typeof res === 'object' && res.ok === false) {
        throw new Error(res.error || '打开目录失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const openExternal = React.useCallback((url: string) => {
    try {
      window.electron.ipcRenderer.invoke('open-external', url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

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
  const ipfsGatewayUrl = ipfsDetails?.gatewayUrl ?? null;

  return (
    <div className="PageRoot">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">站点服务</div>
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

        <div className="SiteServicesGrid">
          <section className="SiteServicePanel">
            <div className="SiteServiceHeader">
              <div>
                <div className="ServiceTitle">Web 服务</div>
                <div className="ServiceMeta">
                  <span
                    className={
                      webRunning ? 'ServiceDot DotGreen' : 'ServiceDot DotGray'
                    }
                    aria-hidden
                  />
                  <span className="ServiceState">
                    {webRunning ? '运行中' : '未运行'}
                  </span>
                  {!yggRunning && !webRunning ? (
                    <span className="ServiceDetails">需要先启动 Yggdrasil</span>
                  ) : null}
                </div>
              </div>

              <div className="ServiceActions SiteServiceActions">
                <button
                  type="button"
                  className="ServiceGhostButton"
                  onClick={() => openDir('web')}
                >
                  查看目录
                </button>
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
                <div className="SiteInfoLabel">根目录</div>
                <div className="SiteInfoValue">{webRootDir ?? '—'}</div>
              </div>
              <div className="SiteInfoRow">
                <div className="SiteInfoLabel">状态说明</div>
                <div className="SiteInfoValue">{webService.details ?? '—'}</div>
              </div>
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
                  onClick={() => openDir('ipfs')}
                >
                  查看目录
                </button>
                <button
                  type="button"
                  className="ServiceGhostButton"
                  disabled={!ipfsGatewayUrl || ipfsService.state !== 'running'}
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
              <div className="SiteInfoRow SiteInfoColumnRow">
                <div className="SiteInfoLabel">监听地址</div>
                <div className="SiteInfoValue SiteInfoColumnValue">
                  {ipfsDetails?.addresses?.length
                    ? ipfsDetails.addresses.join('\n')
                    : '—'}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
