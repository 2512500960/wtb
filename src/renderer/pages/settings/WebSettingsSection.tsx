import * as React from 'react';

const prettyPath = (p: string | null | undefined) =>
  p || '（未设置，使用默认）';

export default function WebSettingsSection() {
  const [current, setCurrent] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'wtb:web:getDir',
      )) as any;
      if (res && res.ok) setCurrent(res.path ?? null);
      else setError(res?.error ?? '未知错误');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  React.useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const choose = async () => {
    setError(null);
    try {
      const pick = (await window.electron.ipcRenderer.invoke(
        'dialog:selectDirectory',
      )) as any;
      if (!pick || !pick.ok) return;
      setBusy(true);
      const setRes = (await window.electron.ipcRenderer.invoke(
        'wtb:web:setDir',
        pick.path,
      )) as any;
      if (setRes && setRes.ok) setCurrent(setRes.path ?? null);
      else setError(setRes?.error ?? '保存失败');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearOverride = async () => {
    setError(null);
    setBusy(true);
    try {
      const setRes = (await window.electron.ipcRenderer.invoke(
        'wtb:web:setDir',
        null,
      )) as any;
      if (setRes && setRes.ok) setCurrent(setRes.path ?? null);
      else setError(setRes?.error ?? '保存失败');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openDir = async () => {
    try {
      await window.electron.ipcRenderer.invoke('services:openDir', 'web');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="ChatTopPanel">
      <div className="ChatTopTitleRow">
        <div className="ChatTopTitle">Web 静态文件目录</div>
        <div className="ChatTopActions">
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={choose}
            disabled={busy}
            style={{ marginRight: 8 }}
          >
            选择目录
          </button>
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={openDir}
            disabled={busy}
            style={{ marginRight: 8 }}
          >
            打开目录
          </button>
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={clearOverride}
            disabled={busy}
          >
            清除覆盖
          </button>
        </div>
      </div>

      <div style={{ padding: '10px 0' }}>
        <div>当前设置：{prettyPath(current)}</div>
        {error ? (
          <div style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</div>
        ) : null}
      </div>
    </div>
  );
}
