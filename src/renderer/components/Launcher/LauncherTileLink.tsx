import * as React from 'react';
import { Link } from 'react-router-dom';

export default function LauncherTileLink({
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
