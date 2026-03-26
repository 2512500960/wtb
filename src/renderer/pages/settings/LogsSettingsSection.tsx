import * as React from 'react';

const prettyPath = (p: string | null | undefined) => p || '（不可用）';

export default function LogsSettingsSection() {
  const [pathStr, setPathStr] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'logs:getMainLogPath',
      )) as any;
      if (res && res.ok) setPathStr(res.path ?? null);
      else setError(res?.error ?? '未知错误');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  React.useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const copyPath = async () => {
    try {
      if (!pathStr) return;
      await navigator.clipboard.writeText(pathStr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openContaining = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'logs:openContainingFolder',
      )) as any;
      if (!res || !res.ok) setError(res?.error ?? '无法打开文件夹');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ChatTopPanel">
      <div className="ChatTopTitleRow">
        <div className="ChatTopTitle">日志文件</div>
        <div className="ChatTopActions">
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={refresh}
            style={{ marginRight: 8 }}
          >
            刷新
          </button>
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={copyPath}
            disabled={!pathStr}
            style={{ marginRight: 8 }}
          >
            复制路径
          </button>
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={openContaining}
            disabled={!pathStr || busy}
          >
            打开所在文件夹
          </button>
        </div>
      </div>

      <div style={{ padding: '10px 0' }}>
        <div>主进程日志：{prettyPath(pathStr)}</div>
        {error ? (
          <div style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</div>
        ) : null}
      </div>
    </div>
  );
}
