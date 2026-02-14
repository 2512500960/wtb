import * as React from 'react';
import { ServiceStatus, ServiceName, serviceLabel } from '../../types/services';

export default function ServiceCardGeneric({
  svc,
  yggRunning,
  busyName,
  start,
  stop,
}: {
  svc: ServiceStatus;
  yggRunning: boolean;
  busyName: ServiceName | null;
  start: (n: ServiceName) => Promise<void>;
  stop: (n: ServiceName) => Promise<void>;
}) {
  const isBusy = busyName === svc.name;
  const running = svc.state === 'running';
  const locked = svc.name !== 'yggdrasil' && !yggRunning;
  const notImplemented =
    svc.name !== 'yggdrasil' && (svc.details ?? '').includes('not implemented');
  const disableActions = locked || notImplemented;

  let hintMessage: string;
  if (locked) {
    hintMessage = '需要先启动 Yggdrasil 服务后才能操作。';
  } else if (notImplemented) {
    hintMessage = '该服务暂未接入（后续实现）。';
  } else {
    hintMessage = '该服务逻辑后续接入。';
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

      <div className="ServiceHint">{hintMessage}</div>
    </div>
  );
}
