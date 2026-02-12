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

  const onClick = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      try {
        // Use IPC to ask main process to open the URL in-app
        window.electron.ipcRenderer.invoke('open-in-app', href);
      } catch {
        // Fallback to window.open if IPC not available
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    },
    [href],
  );

  return (
    <button className="LauncherTile" type="button" onClick={onClick} aria-label={label}>
      <div className="LauncherIcon" aria-hidden>
        {icon}
      </div>
      <div className="LauncherLabel">{label}</div>
    </button>
  );
}
