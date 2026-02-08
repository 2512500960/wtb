import * as React from 'react';
import { ServiceStatus, ServiceName, serviceLabel } from '../../types/services';

export default function ServiceCardWeb({
  svc,
  busyName,
  start,
  stop,
  openExternal,
  yggRunning,
}: {
  svc: ServiceStatus;
  yggRunning: boolean;
  busyName: ServiceName | null;
  start: (n: ServiceName) => Promise<void>;
  stop: (n: ServiceName) => Promise<void>;
  openExternal: (u: string) => void;
}) {
  const isBusy = busyName === svc.name;
  const running = svc.state === 'running';
  const locked = svc.name !== 'yggdrasil' && !yggRunning;
  const notImplemented = svc.name !== 'yggdrasil' && (svc.details ?? '').includes('not implemented');

  const webUrl = svc.details && svc.details.startsWith('http') ? svc.details : null;

  const disableActions = locked || notImplemented;

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

      {locked ? (
        <div className="ServiceHint">需要先启动 Yggdrasil 服务后才能操作。</div>
      ) : notImplemented ? (
        <div className="ServiceHint">该服务暂未接入（后续实现）。</div>
      ) : (
        <div>
                    <div className="ServiceMeta">
            <span
              className={running ? 'ServiceDot DotGreen' : 'ServiceDot DotGray'}
              aria-hidden
            />
            <span className="ServiceState">{running ? '运行中' : '未运行'}</span>
            {svc.details ? <span className="ServiceDetails">{svc.details}</span> : null}
          </div>
                  <div className="ServiceHint">
          Web 服务仅监听 Yggdrasil 网卡地址。启动后可点击“查看”打开地址。
        </div>
        </div>

      )}
    </div>
  );
}
