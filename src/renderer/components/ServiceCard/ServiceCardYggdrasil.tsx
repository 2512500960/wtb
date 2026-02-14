import * as React from 'react';
import { Link } from 'react-router-dom';
import { ServiceStatus, ServiceName, serviceLabel } from '../../types/services';

export default function ServiceCardYggdrasil({
  svc,
  busyName,
  start,
  stop,
}: {
  svc: ServiceStatus;
  busyName: ServiceName | null;
  start: (n: ServiceName) => Promise<void>;
  stop: (n: ServiceName) => Promise<void>;
}) {
  const isBusy = busyName === svc.name;
  const running = svc.state === 'running';

  return (
    <div className={running ? 'ServiceCard' : 'ServiceCard'}>
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
          <Link className="ServiceGhostButton" to="/status">
            状态
          </Link>

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
        点击“启动”时会弹出 UAC。管理员权限用于创建 TUN 网卡并启动 Yggdrasil。
        请注意防火墙的配置，这需要你有一些基础的网络知识，如果不懂，上网摇人。
      </div>
    </div>
  );
}
