/**
 * 服务公告页面
 * - 发布本地服务到 libp2p gossipsub
 * - 发现并展示远程服务
 */

import * as React from 'react';
import { Link } from 'react-router-dom';

import type {
  ServiceAnnouncementStatus,
  LocalServiceConfig,
  AnnouncementSystemStatus,
} from '../types/announcements';

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

function formatTimestamp(ts: string | number): string {
  try {
    const date = typeof ts === 'string' ? new Date(ts) : new Date(ts);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

function formatTTL(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86400)} 天`;
}

export default function ServiceAnnouncementsPage() {
  const MAX_DESC_LEN = 200;

  const [status, setStatus] = React.useState<AnnouncementSystemStatus | null>(
    null,
  );
  const [localServices, setLocalServices] = React.useState<
    LocalServiceConfig[]
  >([]);
  const [discoveredServices, setDiscoveredServices] = React.useState<
    ServiceAnnouncementStatus[]
  >([]);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [showPeers, setShowPeers] = React.useState(false);

  // 新增服务表单
  const [yggIPv6, setYggIPv6] = React.useState<string>('');
  const [newServiceProtocol, setNewServiceProtocol] = React.useState(
    'http' as
      | 'http'
      | 'https'
      | 'ws'
      | 'wss'
      | 'tcp'
      | 'udp'
      | 'quic'
      | 'grpc'
      | 'grpcs',
  );
  const [newServicePort, setNewServicePort] = React.useState('');
  const [newServicePath, setNewServicePath] = React.useState('');
  const [newServiceDesc, setNewServiceDesc] = React.useState('');
  const [publishConfirmPending, setPublishConfirmPending] =
    React.useState(false);

  const running = !!status?.running;

  const copyToClipboard = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // eslint-disable-next-line no-alert
      window.prompt('复制下面内容：', text);
    }
  }, []);

  const normalizePath = (value: string): string => {
    const raw = (value ?? '').trim();
    if (!raw) return '';
    if (raw.startsWith('/') || raw.startsWith('?') || raw.startsWith('#')) {
      return raw;
    }
    return `/${raw}`;
  };

  const computedLocalUrl = React.useMemo((): string => {
    const proto = newServiceProtocol;
    const portNum = Number(newServicePort);
    if (!yggIPv6 || !proto) return '';
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      return '';
    }

    const pathPart = normalizePath(newServicePath);

    // For web-style schemes, a trailing slash is a sensible default.
    const shouldDefaultSlash =
      proto === 'http' ||
      proto === 'https' ||
      proto === 'ws' ||
      proto === 'wss';
    const finalPath = pathPart || (shouldDefaultSlash ? '/' : '');

    return `${proto}://[${yggIPv6}]:${portNum}${finalPath}`;
  }, [newServicePath, newServicePort, newServiceProtocol, yggIPv6]);

  const refreshStatus = React.useCallback(async () => {
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'announcements:status',
      )) as AnnouncementSystemStatus;
      setStatus(res);
      return res;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return {
        running: false,
        localServicesCount: 0,
        discoveredServicesCount: 0,
      } as AnnouncementSystemStatus;
    }
  }, []);

  const refreshLocalServices = React.useCallback(async () => {
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'announcements:local:list',
      )) as LocalServiceConfig[];
      setLocalServices(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshDiscoveredServices = React.useCallback(async () => {
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'announcements:discovered:list',
      )) as ServiceAnnouncementStatus[];
      setDiscoveredServices(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshAll = React.useCallback(async () => {
    const st = await refreshStatus();
    await refreshLocalServices();
    if (st.running) {
      await refreshDiscoveredServices();
    } else {
      setDiscoveredServices([]);
    }
  }, [refreshStatus, refreshLocalServices, refreshDiscoveredServices]);

  React.useEffect(() => {
    // If the form changes, require a fresh confirmation.
    setPublishConfirmPending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedLocalUrl, newServiceDesc]);

  React.useEffect(() => {
    refreshAll();

    // Auto-fill local Yggdrasil IPv6 if available.
    window.electron.ipcRenderer
      .invoke('ygg:getIPv6')
      .then((addr) => setYggIPv6(String(addr)))
      .catch(() => {
        // ignore
      });

    // 定期刷新状态与发现的服务（避免闭包里 status 变成“永远是初始值”）
    const interval = setInterval(() => {
      refreshStatus()
        .then((st) => {
          if (st.running) {
            return refreshDiscoveredServices();
          }
          setDiscoveredServices([]);
          return undefined;
        })
        .catch(() => {
          // ignore
        });
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validatePublishInput = (): { url: string; desc: string } | null => {
    const url = computedLocalUrl.trim();
    const desc = newServiceDesc.trim();
    const portNum = Number(newServicePort);

    if (!yggIPv6) {
      setError('无法获取本机 Yggdrasil IPv6 地址，请先启动 Yggdrasil');
      return null;
    }

    if (!url) {
      setError('URL 无效，请检查协议/端口/路径');
      return null;
    }

    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      setError('端口无效（1-65535）');
      return null;
    }

    if (!desc) {
      setError('服务描述不能为空');
      return null;
    }

    if (desc.length > MAX_DESC_LEN) {
      setError(`服务描述过长（最多 ${MAX_DESC_LEN} 字符）`);
      return null;
    }

    return { url, desc };
  };

  const requestPublishConfirm = () => {
    setError(null);
    const ok = validatePublishInput();
    if (!ok) return;
    setPublishConfirmPending(true);
  };

  const confirmPublish = async () => {
    const ok = validatePublishInput();
    if (!ok) {
      setPublishConfirmPending(false);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await window.electron.ipcRenderer.invoke('announcements:local:add', ok);
      setNewServiceDesc('');
      setNewServicePath('');
      setNewServicePort('');
      setPublishConfirmPending(false);
      await refreshLocalServices();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeService = async (id: string) => {
    if (
      // eslint-disable-next-line no-alert
      !window.confirm(
        '确定要撤回此服务公告吗？撤回消息将广播到网络，但已发现此服务的节点可能需要一段时间才能收到撤回消息。',
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await window.electron.ipcRenderer.invoke(
        'announcements:local:remove',
        id,
      );
      await refreshLocalServices();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openServiceUrl = (url: string) => {
    window.electron.ipcRenderer.invoke('open-external', url);
  };

  let discoveredBlock: React.ReactNode;
  if (!running) {
    discoveredBlock = (
      <div className="ServiceHint">
        公告系统未运行时不会接收远程服务；启动 Yggdrasil 后会自动启动公告后台。
      </div>
    );
  } else if (discoveredServices.length === 0) {
    discoveredBlock = (
      <div className="ServiceHint">暂无发现的服务，请等待其他节点发布。</div>
    );
  } else {
    discoveredBlock = (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="center">描述</th>
              <th align="center">URI</th>
              <th align="center">Peer</th>
              <th align="center">发布</th>
              <th align="center">TTL</th>
              <th align="center">接收</th>
              <th align="center">操作</th>
            </tr>
          </thead>
          <tbody>
            {discoveredServices.map((svc) => (
              <tr key={svc.id}>
                <td>{svc.desc}</td>
                <td style={{ wordBreak: 'break-all' }}>{svc.url}</td>
                <td style={{ wordBreak: 'break-all' }}>{svc.peerId}</td>
                <td>{formatTimestamp(svc.ts)}</td>
                <td>{formatTTL(svc.ttl)}</td>
                <td>{formatTimestamp(svc.receivedAt)}</td>
                <td>
                  <button
                    type="button"
                    className="ServiceGhostButton"
                    style={{ width: 90 }}
                    onClick={() => copyToClipboard(svc.url)}
                  >
                    复制URL
                  </button>
                  <button
                    type="button"
                    className="ServiceGhostButton"
                    onClick={() => openServiceUrl(svc.url)}
                    style={{ marginLeft: 8 }}
                  >
                    打开
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="PageRoot">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">服务公告</div>
      </div>

      <div className="PageBody">
        <div className="StatusControls">
          <div className="StatusSummary">
            状态：{running ? '运行中' : '未启动'}
            {status?.peerId ? `，Peer：${status.peerId}` : ''}
          </div>
          <button
            type="button"
            className="ServiceGhostButton"
            onClick={refreshAll}
            disabled={busy}
          >
            刷新
          </button>
        </div>

        {status?.running ? (
          <div className="ServiceHint">
            <div>
              Topic：{status.subscribedTopic || '（未订阅）'}
              {typeof status.peers?.length === 'number'
                ? `，已知 peers：${status.peers.length}`
                : ''}
              {typeof status.peerConnections?.length === 'number'
                ? `，活跃连接：${status.peerConnections.length}`
                : ''}
              <button
                type="button"
                className="ServiceGhostButton"
                style={{ marginLeft: 10, width: 120 }}
                onClick={() => setShowPeers(true)}
              >
                查看连接
              </button>
            </div>
          </div>
        ) : null}

        <ModalShell
          open={showPeers}
          onClose={() => setShowPeers(false)}
          title="公告系统连接详情"
        >
          {status?.running ? (
            <div className="PageBody" style={{ margin: 0 }}>
              {status.listenAddrs && status.listenAddrs.length > 0 ? (
                <div style={{ wordBreak: 'break-all' }}>
                  Listen：{status.listenAddrs.join(' , ')}
                </div>
              ) : null}

              {status.peerConnections && status.peerConnections.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  <div>连接详情（peerId / remoteAddr）：</div>
                  <div style={{ marginTop: 4 }}>
                    {status.peerConnections.map((pc) => (
                      <div
                        key={pc.peerId}
                        style={{ wordBreak: 'break-all', marginTop: 2 }}
                      >
                        {pc.peerId}
                        {pc.addrs && pc.addrs.length > 0
                          ? `  @  ${pc.addrs.join(' , ')}`
                          : ''}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 10 }}>
                  当前没有活跃连接；在没有任何连接的情况下，gossipsub
                  不会收到其他节点的公告。
                </div>
              )}
            </div>
          ) : (
            <div className="ServiceHint">公告系统未运行</div>
          )}
        </ModalShell>

        <div className="ServiceHint">
          公告系统会订阅统一 Topic，接收其他客户端发布的服务信息；
          本机填写并“发布”后，会自动周期性重发。
          <div style={{ marginTop: 6 }}>
            公告后台会在 Yggdrasil 运行后自动启动，无需手动点击“启动”。
          </div>
        </div>

        {error ? <div className="ServiceError">错误：{error}</div> : null}

        <div className="ServiceSection">
          <div className="ServiceHeader">
            <div className="ServiceTitle">发布本地服务</div>
          </div>

          <div className="ChatStack">
            <div className="ChatTinyHint">
              本机 Yggdrasil IPv6：
              {yggIPv6 || '（未获取；请先启动 Yggdrasil）'}
            </div>

            <div className="ChatRow">
              <select
                id="newServiceProtocol"
                className="ChatInput"
                value={newServiceProtocol}
                onChange={(e) =>
                  setNewServiceProtocol(
                    e.target.value as typeof newServiceProtocol,
                  )
                }
                disabled={busy}
              >
                <option value="http">http</option>
                <option value="https">https</option>
                <option value="ws">websocket (ws)</option>
                <option value="wss">websocket (wss)</option>
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
                <option value="quic">quic</option>
                <option value="grpc">grpc</option>
                <option value="grpcs">grpcs</option>
              </select>
              <input
                id="newServicePort"
                type="text"
                className="ChatInput"
                placeholder="端口，例如 8080"
                value={newServicePort}
                onChange={(e) => setNewServicePort(e.target.value)}
                disabled={busy}
              />
            </div>

            <input
              id="newServicePath"
              type="text"
              className="ChatInput"
              placeholder="路径（可选），例如 /api 或 ?token=..."
              value={newServicePath}
              onChange={(e) => setNewServicePath(e.target.value)}
              disabled={busy}
            />

            <input
              id="newServiceDesc"
              type="text"
              className="ChatInput"
              placeholder={`服务描述（最多 ${MAX_DESC_LEN} 字符）`}
              value={newServiceDesc}
              onChange={(e) => setNewServiceDesc(e.target.value)}
              disabled={busy}
              maxLength={MAX_DESC_LEN}
            />
            <div className="ChatTinyHint">
              URL：{computedLocalUrl || '（请输入协议与端口）'}
              <span style={{ marginLeft: 12 }}>
                {newServiceDesc.length}/{MAX_DESC_LEN}
              </span>
            </div>

            <div className="ChatRow">
              {publishConfirmPending ? (
                <>
                  <button
                    type="button"
                    className="ServicePrimaryButton"
                    onClick={confirmPublish}
                    disabled={busy}
                  >
                    {busy ? '发布中…' : '确认发布'}
                  </button>
                  <button
                    type="button"
                    className="ServiceGhostButton"
                    onClick={() => setPublishConfirmPending(false)}
                    disabled={busy}
                    style={{ marginLeft: 8 }}
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="ServicePrimaryButton"
                  onClick={requestPublishConfirm}
                  disabled={busy || !computedLocalUrl || !newServiceDesc.trim()}
                >
                  发布
                </button>
              )}
              <div className="ChatTinyHint">
                发布后会自动签名并广播（支持撤回）。
              </div>
            </div>
          </div>
        </div>

        <div className="ServiceSection">
          <div className="ServiceHeader">
            <div className="ServiceTitle">
              本机发布的服务（{localServices.length}）
            </div>
          </div>

          {localServices.length === 0 ? (
            <div className="ServiceHint">暂无本地发布的服务。</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th align="left">描述</th>
                    <th align="left">URI</th>
                    <th align="left">seq</th>
                    <th align="left">最后发布</th>
                    <th align="left">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {localServices.map((svc) => (
                    <tr key={svc.id}>
                      <td>{svc.desc}</td>
                      <td style={{ wordBreak: 'break-all' }}>{svc.url}</td>
                      <td>{svc.seq}</td>
                      <td>
                        {svc.lastPublishedAt
                          ? formatTimestamp(svc.lastPublishedAt)
                          : '-'}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="ServiceGhostButton"
                          onClick={() => copyToClipboard(svc.url)}
                          disabled={busy}
                          style={{ marginLeft: 8, width: 90 }}
                        >
                          复制URL
                        </button>
                        <button
                          type="button"
                          className="ServiceGhostButton"
                          onClick={() => openServiceUrl(svc.url)}
                          disabled={busy}
                          style={{ marginLeft: 8 }}
                        >
                          打开
                        </button>
                        <button
                          type="button"
                          className="ServiceDangerButton"
                          onClick={() => removeService(svc.id)}
                          disabled={busy}
                          style={{ marginLeft: 8 }}
                        >
                          撤回
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="ServiceSection">
          <div className="ServiceHeader">
            <div className="ServiceTitle">
              发现的其他设备服务（{discoveredServices.length}）
            </div>
          </div>

          {discoveredBlock}
        </div>
      </div>
    </div>
  );
}
