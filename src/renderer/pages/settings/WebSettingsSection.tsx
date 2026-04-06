import * as React from 'react';

const prettyPath = (p: string | null | undefined) =>
  p || '（未设置，使用默认）';

type LocalWebEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  cid?: string;
  sourceMode?: 'local' | 'dual' | 'ipfs-backed';
  localPresent?: boolean;
  virtual?: boolean;
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

export default function WebSettingsSection() {
  const [current, setCurrent] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [browsePath, setBrowsePath] = React.useState('/');
  const [entries, setEntries] = React.useState<LocalWebEntry[]>([]);
  const [entriesBusy, setEntriesBusy] = React.useState(false);
  const [entryBusyPath, setEntryBusyPath] = React.useState<string | null>(null);
  const [entryMessage, setEntryMessage] = React.useState<string | null>(null);

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

  const refreshEntries = React.useCallback(
    async (requestedPath?: string) => {
      const nextPath = requestedPath || browsePath || '/';
      setEntriesBusy(true);
      setEntryMessage(null);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:listEntries',
          nextPath,
        )) as {
          ok?: boolean;
          error?: string;
          path?: string;
          entries?: LocalWebEntry[];
        };
        if (!res?.ok) {
          setError(res?.error ?? '读取 Web 内容失败');
          return;
        }
        setBrowsePath(res.path || nextPath);
        setEntries(res.entries || []);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setEntriesBusy(false);
      }
    },
    [browsePath],
  );

  React.useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  React.useEffect(() => {
    refreshEntries('/').catch(() => {});
  }, [refreshEntries]);

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

  const convertEntry = React.useCallback(
    async (entry: LocalWebEntry, removeLocalFile: boolean) => {
      setError(null);
      setEntryMessage(null);
      setEntryBusyPath(entry.path);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:convertFileToIpfsSource',
          entry.path,
          { removeLocalFile },
        )) as {
          ok?: boolean;
          error?: string;
          result?: { cid?: string; sourceMode?: string };
        };
        if (!res?.ok) {
          setError(res?.error ?? '转换失败');
          return;
        }
        const sourceMode =
          res.result?.sourceMode || (removeLocalFile ? 'ipfs-backed' : 'dual');
        setEntryMessage(`已转换 ${entry.name}，模式：${sourceMode}。`);
        await refreshEntries(browsePath);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setEntryBusyPath(null);
      }
    },
    [browsePath, refreshEntries],
  );

  const parentPath = React.useMemo(() => {
    if (browsePath === '/') return null;
    const parent = browsePath
      .replace(/\/+$/, '')
      .split('/')
      .slice(0, -1)
      .join('/');
    return parent ? `${parent}/`.replace(/\/\/+/, '/') : '/';
  }, [browsePath]);

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
        {entryMessage ? (
          <div style={{ color: 'var(--success, #2e7d32)', marginTop: 8 }}>
            {entryMessage}
          </div>
        ) : null}
      </div>

      <div
        style={{
          paddingTop: 8,
          borderTop: '1px solid var(--border-color, #ddd)',
        }}
      >
        <div className="ChatTopTitleRow">
          <div className="ChatTopTitle">本地内容源管理</div>
          <div className="ChatTopActions">
            {parentPath ? (
              <button
                type="button"
                className="ServiceSecondaryButton"
                onClick={() => refreshEntries(parentPath)}
                disabled={entriesBusy || !!entryBusyPath}
                style={{ marginRight: 8 }}
              >
                返回上级
              </button>
            ) : null}
            <button
              type="button"
              className="ServiceSecondaryButton"
              onClick={() => refreshEntries(browsePath)}
              disabled={entriesBusy || !!entryBusyPath}
            >
              刷新内容
            </button>
          </div>
        </div>

        <div style={{ padding: '8px 0' }}>
          <div>当前浏览：{browsePath}</div>
          <div style={{ marginTop: 4, opacity: 0.8 }}>
            这里只允许本地管理。可将文件转成双源模式，或转成仅由本地 IPFS
            网关反代提供的 IPFS-backed 模式。
          </div>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          {entriesBusy ? <div>正在读取内容…</div> : null}
          {!entriesBusy && entries.length === 0 ? (
            <div>当前目录没有可展示条目。</div>
          ) : null}
          {entries.map((entry) => {
            const rowBusy = entryBusyPath === entry.path;
            return (
              <div
                key={entry.path}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  gap: 12,
                  alignItems: 'center',
                  padding: '10px 12px',
                  border: '1px solid var(--border-color, #ddd)',
                  borderRadius: 8,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {entry.isDirectory ? '📁' : '📄'} {entry.name}
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      opacity: 0.8,
                      wordBreak: 'break-all',
                    }}
                  >
                    {entry.path}
                    {!entry.isDirectory ? ` · ${formatBytes(entry.size)}` : ''}
                    {entry.sourceMode ? ` · 模式：${entry.sourceMode}` : ''}
                    {entry.cid ? ' · CID 已记录' : ''}
                    {entry.virtual ? ' · 虚拟目录' : ''}
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    flexWrap: 'wrap',
                    justifyContent: 'flex-end',
                  }}
                >
                  {entry.isDirectory ? (
                    <button
                      type="button"
                      className="ServiceSecondaryButton"
                      onClick={() => refreshEntries(entry.path)}
                      disabled={entriesBusy || !!entryBusyPath}
                    >
                      打开目录
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ServiceSecondaryButton"
                        onClick={() => convertEntry(entry, false)}
                        disabled={
                          rowBusy || entriesBusy || entry.localPresent === false
                        }
                      >
                        {rowBusy ? '处理中…' : '转为双源'}
                      </button>
                      <button
                        type="button"
                        className="ServiceSecondaryButton"
                        onClick={() => convertEntry(entry, true)}
                        disabled={
                          rowBusy || entriesBusy || entry.localPresent === false
                        }
                      >
                        {rowBusy ? '处理中…' : '转为 IPFS-backed'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
