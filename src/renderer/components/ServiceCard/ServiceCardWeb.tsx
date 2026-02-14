import * as React from 'react';
import { ServiceStatus, ServiceName, serviceLabel } from '../../types/services';

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy method
  }

  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.top = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export default function ServiceCardWeb({
  svc,
  busyName,
  start,
  stop,
  openDir,
  openExternal,
  yggRunning,
}: {
  svc: ServiceStatus;
  yggRunning: boolean;
  busyName: ServiceName | null;
  start: (n: ServiceName) => Promise<void>;
  stop: (n: ServiceName) => Promise<void>;
  openDir: (n: ServiceName) => Promise<void>;
  openExternal: (u: string) => void;
}) {
  const isBusy = busyName === svc.name;
  const running = svc.state === 'running';
  const locked = svc.name !== 'yggdrasil' && !yggRunning;
  const notImplemented =
    svc.name !== 'yggdrasil' && (svc.details ?? '').includes('not implemented');

  type CopyHint = 'copied' | 'failed' | null;
  const [copyHint, setCopyHint] = React.useState<CopyHint>(null);
  const copyHintTimerRef = React.useRef<number | null>(null);

  const webUrl =
    svc.details && svc.details.startsWith('http') ? svc.details : null;
  const disableActions = locked || notImplemented;

  React.useEffect(() => {
    return () => {
      if (copyHintTimerRef.current) {
        window.clearTimeout(copyHintTimerRef.current);
        copyHintTimerRef.current = null;
      }
    };
  }, []);

  const detailsNode = React.useMemo((): React.ReactNode => {
    if (!svc.details) return null;

    if (webUrl) {
      return (
        <>
          <button
            type="button"
            className="ServiceDetails ServiceDetailsLink"
            onClick={async () => {
              if (copyHintTimerRef.current) {
                window.clearTimeout(copyHintTimerRef.current);
                copyHintTimerRef.current = null;
              }

              const ok = await copyToClipboard(webUrl);
              setCopyHint(ok ? 'copied' : 'failed');

              copyHintTimerRef.current = window.setTimeout(() => {
                setCopyHint(null);
                copyHintTimerRef.current = null;
              }, 1200);
            }}
            title="点击复制链接"
            style={{ background: 'transparent', border: 0, padding: 0 }}
          >
            {svc.details}
          </button>

          {copyHint ? (
            <span className="ServiceCopyHint" aria-live="polite">
              {copyHint === 'copied' ? '已复制' : '复制失败'}
            </span>
          ) : null}
        </>
      );
    }

    return <span className="ServiceDetails">{svc.details}</span>;
  }, [svc.details, webUrl, copyHint]);

  let hintContent: React.ReactNode = null;
  if (locked) {
    hintContent = (
      <div className="ServiceHint">需要先启动 Yggdrasil 服务后才能操作。</div>
    );
  } else if (notImplemented) {
    hintContent = (
      <div className="ServiceHint">该服务暂未接入（后续实现）。</div>
    );
  } else {
    hintContent = (
      <div>
        <div className="ServiceMeta">
          <span
            className={running ? 'ServiceDot DotGreen' : 'ServiceDot DotGray'}
            aria-hidden
          />
          <span className="ServiceState">{running ? '运行中' : '未运行'}</span>
          {detailsNode}
        </div>
        <div className="ServiceHint">
          Web 服务仅监听 Yggdrasil
          网卡地址。点击“打开目录”后，将文件复制到该目录中；启动后可点击“查看”打开地址；其他加入YGGDRASIL网络的人可以访问这个地址（前提是他们也运行了相同的服务）。如果需要更复杂的配置或者服务，请自行搭建并将YGG网络接口的地址包含在自建服务的监听范围内
          yggdrasilctl。
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        disableActions && !running ? 'ServiceCard isDisabled' : 'ServiceCard'
      }
    >
      <div className="ServiceCardTop">
        <div>
          <div className="ServiceName">{serviceLabel[svc.name]}</div>
        </div>

        <div className="ServiceActions">
          <button
            type="button"
            className="ServiceGhostButton"
            onClick={() => openDir(svc.name)}
          >
            打开目录
          </button>

          <button
            type="button"
            className="ServiceGhostButton"
            disabled={!running || !webUrl}
            onClick={() => {
              if (!webUrl) return;
              openExternal(webUrl);
            }}
          >
            查看
          </button>

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

      {hintContent}
    </div>
  );
}
