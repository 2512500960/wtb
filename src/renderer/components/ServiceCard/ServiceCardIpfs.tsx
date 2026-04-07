import * as React from 'react';
import { ServiceStatus, ServiceName, serviceLabel } from '../../types/services';

type IpfsDetailedStatus = {
  running: boolean;
  repoDir: string;
  apiUrl: string;
  gatewayUrl: string;
  pid: number | null;
  peerId?: string;
  addresses: string[];
};

type PickAndAddResult =
  | { ok: true; cid: string; path: string }
  | { ok: false; canceled?: boolean; error?: string };

async function copyToClipboard(text: string): Promise<boolean> {
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

export default function ServiceCardIpfs({
  svc,
  busyName,
  start,
  stop,
  openDir,
  openExternal,
}: {
  svc: ServiceStatus;
  busyName: ServiceName | null;
  start: (n: ServiceName) => Promise<void>;
  stop: (n: ServiceName) => Promise<void>;
  openDir: (n: ServiceName) => Promise<void>;
  openExternal: (u: string) => void;
}) {
  const isBusy = busyName === svc.name;
  const running = svc.state === 'running';
  const [details, setDetails] = React.useState<IpfsDetailedStatus | null>(null);
  const [loadingDetails, setLoadingDetails] = React.useState(false);
  const [publishBusy, setPublishBusy] = React.useState(false);
  const [publishError, setPublishError] = React.useState<string | null>(null);
  const [publishResult, setPublishResult] = React.useState<{
    cid: string;
    path: string;
  } | null>(null);
  const [copyHint, setCopyHint] = React.useState<'copied' | 'failed' | null>(
    null,
  );

  const refreshDetailedStatus = React.useCallback(async () => {
    setLoadingDetails(true);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'ipfs:statusDetailed',
      )) as IpfsDetailedStatus;
      setDetails(res);
    } catch {
      setDetails(null);
    } finally {
      setLoadingDetails(false);
    }
  }, []);

  React.useEffect(() => {
    refreshDetailedStatus();
  }, [refreshDetailedStatus, running]);

  React.useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => {
      refreshDetailedStatus();
    }, 8000);
    return () => window.clearInterval(id);
  }, [refreshDetailedStatus, running]);

  const gatewayUrl = details?.gatewayUrl ?? null;
  const peerId = details?.peerId ?? null;

  const copyText = React.useCallback(async (text: string) => {
    const ok = await copyToClipboard(text);
    setCopyHint(ok ? 'copied' : 'failed');
    window.setTimeout(() => setCopyHint(null), 1200);
  }, []);

  const publishPath = React.useCallback(async () => {
    setPublishBusy(true);
    setPublishError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'ipfs:pickAndAddPath',
      )) as PickAndAddResult;

      if (!res.ok) {
        if (!res.canceled) {
          throw new Error(res.error || '导入到 IPFS 失败');
        }
        return;
      }

      setPublishResult({
        cid: res.cid,
        path: res.path,
      });
      refreshDetailedStatus().catch(() => {
        // ignore
      });
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : String(error));
    } finally {
      setPublishBusy(false);
    }
  }, [refreshDetailedStatus]);

  return (
    <div className="ServiceCard">
      <div className="ServiceCardTop">
        <div>
          <div className="ServiceName">{serviceLabel[svc.name]}</div>
          <div className="ServiceMeta">
            <span
              className={running ? 'ServiceDot DotGreen' : 'ServiceDot DotGray'}
              aria-hidden
            />
            <span className="ServiceState">
              {running ? '运行中' : '未运行'}
            </span>
            {svc.details ? (
              <span className="ServiceDetails">{svc.details}</span>
            ) : null}
          </div>
        </div>

        <div className="ServiceActions">
          <button
            type="button"
            className="ServiceGhostButton"
            onClick={() => openDir('ipfs')}
          >
            打开目录
          </button>

          <button
            type="button"
            className="ServiceGhostButton"
            disabled={!gatewayUrl || !running}
            onClick={() => {
              if (!gatewayUrl) return;
              openExternal(gatewayUrl);
            }}
          >
            打开 Gateway
          </button>

          {running ? (
            <button
              type="button"
              className="ServiceDangerButton"
              disabled={isBusy}
              onClick={() => stop(svc.name)}
            >
              {isBusy ? '处理中…' : '停止'}
            </button>
          ) : (
            <button
              type="button"
              className="ServicePrimaryButton"
              disabled={isBusy}
              onClick={() => start(svc.name)}
            >
              {isBusy ? '处理中…' : '启动'}
            </button>
          )}
        </div>
      </div>

      <div className="ServiceHint">
        IPFS
        服务用于内容寻址缓存与大文件分发；当前默认随应用自动启动，也可独立于
        Yggdrasil 运行。
        {loadingDetails ? ' 正在刷新状态…' : ''}
      </div>

      <div className="ServiceHint" style={{ marginTop: 8, userSelect: 'text' }}>
        <div>API：{details?.apiUrl ?? 'http://127.0.0.1:5001'}</div>
        <div>Gateway：{gatewayUrl ?? 'http://127.0.0.1:8080'}</div>
        <div>Peer ID：{peerId || '—'}</div>
      </div>

      <div
        className="ServiceActions"
        style={{ marginTop: 10, flexWrap: 'wrap' }}
      >
        <button
          type="button"
          className="ServiceGhostButton"
          disabled={publishBusy}
          onClick={publishPath}
        >
          {publishBusy ? '导入中…' : '导入文件/目录'}
        </button>
        <button
          type="button"
          className="ServiceGhostButton"
          disabled={!publishResult?.cid}
          onClick={() => {
            if (!publishResult?.cid) return;
            copyText(publishResult.cid).catch(() => {
              // ignore
            });
          }}
        >
          复制 CID
        </button>
        <button
          type="button"
          className="ServiceGhostButton"
          disabled={!publishResult?.cid || !gatewayUrl}
          onClick={() => {
            if (!publishResult?.cid || !gatewayUrl) return;
            openExternal(`${gatewayUrl}/ipfs/${publishResult.cid}`);
          }}
        >
          打开 CID
        </button>
      </div>

      {publishResult ? (
        <div
          className="ServiceHint"
          style={{ marginTop: 10, userSelect: 'text' }}
        >
          <div>CID：{publishResult.cid}</div>
          <div>路径：{publishResult.path}</div>
          {copyHint ? (
            <div>{copyHint === 'copied' ? '已复制' : '复制失败'}</div>
          ) : null}
        </div>
      ) : null}

      {publishError ? (
        <div
          className="ServiceError"
          style={{ marginTop: 10, marginBottom: 0 }}
        >
          {publishError}
        </div>
      ) : null}
    </div>
  );
}
