import * as React from 'react';

export default function LauncherTileExternalLink({
  href,
  label,
  icon,
  disabled,
  disabledHint,
}: {
  href: string;
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
        title={disabledHint ?? 'Requires Yggdrasil to be running'}
      >
        <div className="LauncherIcon" aria-hidden>
          {icon}
        </div>
        <div className="LauncherLabel">{label}</div>
        <div className="LauncherHint">Start Yggdrasil first</div>
      </div>
    );
  }

  return (
    <a
      className="LauncherTile"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
    >
      <div className="LauncherIcon" aria-hidden>
        {icon}
      </div>
      <div className="LauncherLabel">{label}</div>
    </a>
  );
}
