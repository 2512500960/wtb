import * as React from 'react';

const prettyPath = (value: string | null | undefined) =>
  value || '（未设置，使用数据目录下的默认路径）';

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

type FileFilterMode = 'all' | 'converted' | 'ipfs-backed' | 'local-only';
type SettingsViewMode = 'manager' | 'simple';

type SyncContentResult = {
  thresholdBytes: number;
  scannedFiles: number;
  syncedFiles: number;
  unchangedManagedFiles: number;
  skippedSmallFiles: number;
  staleManifestEntries: number;
  syncedPaths: string[];
  stalePaths: string[];
  failures: Array<{ path: string; error: string }>;
};

type ManagedImportResult = {
  importedFiles: number;
  importedDirectories: number;
  overwrittenPaths: string[];
  paths: string[];
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

const getParentPath = (value: string): string => {
  const normalized = (value || '/').replace(/\/+$/, '') || '/';
  if (normalized === '/') return '/';

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 1) return '/';
  return `/${segments.slice(0, -1).join('/')}`;
};

const getSourceModeLabel = (mode?: LocalWebEntry['sourceMode']): string => {
  switch (mode) {
    case 'dual':
      return '双源';
    case 'ipfs-backed':
      return 'IPFS 托管';
    default:
      return '本地';
  }
};

const getStorageHint = (entry: LocalWebEntry): string => {
  if (entry.isDirectory) {
    return entry.virtual
      ? '该目录仅来自内容清单，本地磁盘上没有对应目录。'
      : '普通目录。';
  }

  if (entry.sourceMode === 'ipfs-backed') {
    return entry.localPresent === false
      ? '已写入资源清单，本地文件已删除；HTTP 访问会经由服务端 IPFS gateway 反代。'
      : '已写入资源清单；HTTP 访问会经由服务端 IPFS gateway 反代。';
  }

  if (entry.sourceMode === 'dual') {
    return '已写入资源清单，并保留本地文件；HTTP 和 IPFS 两个来源都可用。';
  }

  return '当前仍只是普通本地文件，尚未写入 IPFS 资源清单。';
};

const shortenCid = (cid: string): string => {
  if (cid.length <= 18) return cid;
  return `${cid.slice(0, 10)}...${cid.slice(-6)}`;
};

function badgeStyle(background: string, color = '#fff') {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    padding: '0 8px',
    borderRadius: 999,
    background,
    color,
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
  };
}

function getModeBadgeStyle(mode?: LocalWebEntry['sourceMode']) {
  if (mode === 'ipfs-backed') return badgeStyle('#1d6b57');
  if (mode === 'dual') return badgeStyle('#355f97');
  return badgeStyle('#6b7280');
}

function getDirectoryToggleLabel(opts: {
  directoryLoading: boolean;
  directoryExpanded: boolean;
}): string {
  if (opts.directoryLoading) return '加载中...';
  return opts.directoryExpanded ? '收起' : '展开';
}

export default function WebSettingsSection() {
  const [current, setCurrent] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [viewMode, setViewMode] = React.useState<SettingsViewMode>('manager');
  const [focusedPath, setFocusedPath] = React.useState('/');
  const [treeEntries, setTreeEntries] = React.useState<
    Record<string, LocalWebEntry[]>
  >({});
  const [loadingPaths, setLoadingPaths] = React.useState<
    Record<string, boolean>
  >({});
  const [expandedPaths, setExpandedPaths] = React.useState<
    Record<string, boolean>
  >({ '/': true });
  const [entryBusyPath, setEntryBusyPath] = React.useState<string | null>(null);
  const [entryMessage, setEntryMessage] = React.useState<string | null>(null);
  const [copyHint, setCopyHint] = React.useState<string | null>(null);
  const [filterMode, setFilterMode] = React.useState<FileFilterMode>('all');
  const [syncBusy, setSyncBusy] = React.useState(false);
  const [managerBusy, setManagerBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'wtb:web:getDir',
      )) as {
        ok?: boolean;
        path?: string | null;
        error?: string;
      };
      if (res?.ok) setCurrent(res.path ?? null);
      else setError(res?.error ?? '未知错误');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadDirectory = React.useCallback(
    async (requestedPath?: string, options?: { focus?: boolean }) => {
      const nextPath = requestedPath || '/';
      setLoadingPaths((currentLoading) => ({
        ...currentLoading,
        [nextPath]: true,
      }));
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

        const resolvedPath = res.path || nextPath;
        setTreeEntries((currentEntries) => ({
          ...currentEntries,
          [resolvedPath]: res.entries || [],
        }));
        if (options?.focus !== false) {
          setFocusedPath(resolvedPath);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingPaths((currentLoading) => ({
          ...currentLoading,
          [nextPath]: false,
        }));
      }
    },
    [],
  );

  React.useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  React.useEffect(() => {
    loadDirectory('/', { focus: true }).catch(() => {});
  }, [loadDirectory]);

  const choose = async () => {
    setError(null);
    try {
      const pick = (await window.electron.ipcRenderer.invoke(
        'dialog:selectDirectory',
      )) as {
        ok?: boolean;
        canceled?: boolean;
        path?: string;
      };
      if (!pick?.ok) return;
      setBusy(true);
      const setRes = (await window.electron.ipcRenderer.invoke(
        'wtb:web:setDir',
        pick.path,
      )) as {
        ok?: boolean;
        path?: string | null;
        error?: string;
      };
      if (setRes?.ok) {
        setCurrent(setRes.path ?? null);
        await loadDirectory('/', { focus: true });
      } else {
        setError(setRes?.error ?? '保存失败');
      }
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
      )) as {
        ok?: boolean;
        path?: string | null;
        error?: string;
      };
      if (setRes?.ok) {
        setCurrent(setRes.path ?? null);
        await loadDirectory('/', { focus: true });
      } else {
        setError(setRes?.error ?? '保存失败');
      }
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

  const syncSimpleModeContent = React.useCallback(async () => {
    setError(null);
    setEntryMessage(null);
    setSyncBusy(true);

    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'wtb:web:syncContentWithIpfs',
      )) as {
        ok?: boolean;
        error?: string;
        result?: SyncContentResult;
      };

      if (!res?.ok || !res.result) {
        setError(res?.error ?? '同步站点内容失败');
        return;
      }

      await loadDirectory('/', { focus: true });

      const summary = [
        `已扫描 ${res.result.scannedFiles} 个文件`,
        `新同步 ${res.result.syncedFiles} 个大文件`,
        `已跟踪且未变化 ${res.result.unchangedManagedFiles} 个`,
      ];

      if (res.result.staleManifestEntries > 0) {
        summary.push(
          `检测到 ${res.result.staleManifestEntries} 个已删除或移走的已跟踪文件`,
        );
      }
      if (res.result.failures.length > 0) {
        summary.push(`有 ${res.result.failures.length} 个文件同步失败`);
      }

      setEntryMessage(`${summary.join('；')}。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncBusy(false);
    }
  }, [loadDirectory]);

  const copyCid = React.useCallback(async (cid: string) => {
    try {
      await navigator.clipboard.writeText(cid);
      setCopyHint('CID 已复制');
    } catch {
      setCopyHint('复制失败');
    }
    window.setTimeout(() => setCopyHint(null), 1200);
  }, []);

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
          result?: {
            cid?: string;
            sourceMode?: string;
            removedLocalFile?: boolean;
          };
        };
        if (!res?.ok) {
          setError(res?.error ?? '转换失败');
          return;
        }

        const sourceMode =
          res.result?.sourceMode || (removeLocalFile ? 'ipfs-backed' : 'dual');
        const removedText = res.result?.removedLocalFile
          ? '已删除本地文件。'
          : '已保留本地文件。';
        const cidText = res.result?.cid ? ` CID：${res.result.cid}` : '';
        setEntryMessage(
          `已将 ${entry.name} 转为 ${getSourceModeLabel(
            sourceMode as LocalWebEntry['sourceMode'],
          )}。${removedText}${cidText}`,
        );

        const parentPath = getParentPath(entry.path);
        await loadDirectory(parentPath, {
          focus: focusedPath === parentPath || focusedPath === entry.path,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setEntryBusyPath(null);
      }
    },
    [focusedPath, loadDirectory],
  );

  const refreshExpandedDirectories = React.useCallback(async () => {
    const paths = Array.from(
      new Set<string>([
        '/',
        ...Object.keys(expandedPaths).filter((path) => expandedPaths[path]),
      ]),
    );

    await Promise.all(
      paths.map(async (path) => {
        await loadDirectory(path, { focus: path === focusedPath });
      }),
    );
  }, [expandedPaths, focusedPath, loadDirectory]);

  const toggleDirectory = React.useCallback(
    async (entry: LocalWebEntry) => {
      if (!entry.isDirectory) return;

      const expanded = !!expandedPaths[entry.path];
      setExpandedPaths((currentExpanded) => ({
        ...currentExpanded,
        [entry.path]: !expanded,
      }));
      setFocusedPath(entry.path);

      if (!expanded) {
        await loadDirectory(entry.path, { focus: false });
      }
    },
    [expandedPaths, loadDirectory],
  );

  const rootEntries = treeEntries['/'] || [];

  const loadedEntries = React.useMemo(() => {
    const allEntries = Object.values(treeEntries).flat();
    const uniqueEntries = new Map<string, LocalWebEntry>();
    allEntries.forEach((entry) => {
      uniqueEntries.set(entry.path, entry);
    });
    return [...uniqueEntries.values()];
  }, [treeEntries]);

  const loadedStats = React.useMemo(() => {
    const files = loadedEntries.filter((entry) => !entry.isDirectory);
    return {
      directories: loadedEntries.filter((entry) => entry.isDirectory).length,
      files: files.length,
      converted: files.filter(
        (entry) => entry.sourceMode && entry.sourceMode !== 'local',
      ).length,
      ipfsBacked: files.filter((entry) => entry.sourceMode === 'ipfs-backed')
        .length,
      dual: files.filter((entry) => entry.sourceMode === 'dual').length,
      localOnly: files.filter(
        (entry) => !entry.sourceMode || entry.sourceMode === 'local',
      ).length,
      withCid: files.filter((entry) => !!entry.cid).length,
      localRemoved: files.filter((entry) => entry.localPresent === false)
        .length,
    };
  }, [loadedEntries]);

  const focusedEntry = React.useMemo(() => {
    return loadedEntries.find((entry) => entry.path === focusedPath) || null;
  }, [focusedPath, loadedEntries]);

  const focusedDirectoryPath = React.useMemo(() => {
    if (!focusedEntry) return focusedPath === '/' ? '/' : getParentPath(focusedPath);
    return focusedEntry.isDirectory ? focusedEntry.path : getParentPath(focusedEntry.path);
  }, [focusedEntry, focusedPath]);

  const refreshManagedDirectory = React.useCallback(
    async (nextFocusedDirectoryPath: string) => {
      const paths = Array.from(
        new Set<string>([
          '/',
          nextFocusedDirectoryPath || '/',
          ...Object.keys(expandedPaths).filter((path) => expandedPaths[path]),
        ]),
      );

      await Promise.all(
        paths.map(async (path) => {
          await loadDirectory(path, { focus: false });
        }),
      );
      setFocusedPath(nextFocusedDirectoryPath || '/');
    },
    [expandedPaths, loadDirectory],
  );

  const createDirectoryInManager = React.useCallback(
    async (targetDirectoryPath: string) => {
      const directoryName = window.prompt('请输入新目录名称');
      if (!directoryName) return;

      setError(null);
      setEntryMessage(null);
      setManagerBusy(true);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:createDirectory',
          targetDirectoryPath,
          directoryName,
        )) as {
          ok?: boolean;
          error?: string;
          result?: { path: string; created: boolean };
        };

        if (!res?.ok || !res.result) {
          setError(res?.error ?? '新建目录失败');
          return;
        }

        await refreshManagedDirectory(targetDirectoryPath);
        setEntryMessage(
          res.result.created
            ? `已创建目录 ${res.result.path}`
            : `目录已存在：${res.result.path}`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setManagerBusy(false);
      }
    },
    [refreshManagedDirectory],
  );

  const importFilesIntoManager = React.useCallback(
    async (targetDirectoryPath: string) => {
      setError(null);
      setEntryMessage(null);
      setManagerBusy(true);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:pickAndImportFiles',
          targetDirectoryPath,
        )) as {
          ok?: boolean;
          canceled?: boolean;
          error?: string;
          result?: ManagedImportResult;
        };

        if (res?.canceled) return;
        if (!res?.ok || !res.result) {
          setError(res?.error ?? '导入文件失败');
          return;
        }

        await refreshManagedDirectory(targetDirectoryPath);
        setEntryMessage(
          `已导入 ${res.result.importedFiles} 个文件到 ${targetDirectoryPath}${
            res.result.overwrittenPaths.length
              ? `，覆盖 ${res.result.overwrittenPaths.length} 个同名路径`
              : ''
          }。`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setManagerBusy(false);
      }
    },
    [refreshManagedDirectory],
  );

  const importDirectoryIntoManager = React.useCallback(
    async (targetDirectoryPath: string) => {
      setError(null);
      setEntryMessage(null);
      setManagerBusy(true);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:pickAndImportDirectory',
          targetDirectoryPath,
        )) as {
          ok?: boolean;
          canceled?: boolean;
          error?: string;
          result?: ManagedImportResult;
        };

        if (res?.canceled) return;
        if (!res?.ok || !res.result) {
          setError(res?.error ?? '导入目录失败');
          return;
        }

        await refreshManagedDirectory(targetDirectoryPath);
        setEntryMessage(
          `已导入目录，新增 ${res.result.importedDirectories} 个目录、${res.result.importedFiles} 个文件。`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setManagerBusy(false);
      }
    },
    [refreshManagedDirectory],
  );

  const replaceManagedFileEntry = React.useCallback(
    async (entry: LocalWebEntry) => {
      setError(null);
      setEntryMessage(null);
      setManagerBusy(true);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:replaceFile',
          entry.path,
        )) as {
          ok?: boolean;
          canceled?: boolean;
          error?: string;
          result?: ManagedImportResult;
        };

        if (res?.canceled) return;
        if (!res?.ok || !res.result) {
          setError(res?.error ?? '替换文件失败');
          return;
        }

        await refreshManagedDirectory(getParentPath(entry.path));
        setEntryMessage(`已替换 ${entry.path}。`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setManagerBusy(false);
      }
    },
    [refreshManagedDirectory],
  );

  const deleteManagedEntry = React.useCallback(
    async (entry: LocalWebEntry) => {
      const confirmed = window.confirm(
        `确定要删除 ${entry.isDirectory ? '目录' : '文件'} ${entry.path} 吗？`,
      );
      if (!confirmed) return;

      setError(null);
      setEntryMessage(null);
      setManagerBusy(true);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:deleteEntry',
          entry.path,
        )) as {
          ok?: boolean;
          error?: string;
          result?: { removedPaths: string[] };
        };

        if (!res?.ok || !res.result) {
          setError(res?.error ?? '删除失败');
          return;
        }

        const nextDirectory = entry.isDirectory
          ? getParentPath(entry.path)
          : getParentPath(entry.path);
        await refreshManagedDirectory(nextDirectory);
        setEntryMessage(`已删除 ${res.result.removedPaths.length} 个条目。`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setManagerBusy(false);
      }
    },
    [refreshManagedDirectory],
  );

  const shouldDisplayEntry = React.useCallback(
    (entry: LocalWebEntry): boolean => {
      if (entry.isDirectory) return true;

      switch (filterMode) {
        case 'converted':
          return !!entry.sourceMode && entry.sourceMode !== 'local';
        case 'ipfs-backed':
          return entry.sourceMode === 'ipfs-backed';
        case 'local-only':
          return !entry.sourceMode || entry.sourceMode === 'local';
        default:
          return true;
      }
    },
    [filterMode],
  );

  const renderEntryRow = React.useCallback(
    (entry: LocalWebEntry, depth: number): React.ReactNode => {
      const rowBusy = entryBusyPath === entry.path;
      const directoryExpanded =
        entry.isDirectory && !!expandedPaths[entry.path];
      const directoryLoading = !!loadingPaths[entry.path];
      const isFocused = focusedPath === entry.path;

      return (
        <React.Fragment key={entry.path}>
          <div
            onClick={() => setFocusedPath(entry.path)}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              gap: 12,
              alignItems: 'center',
              padding: '10px 12px',
              border: '1px solid var(--border-color, #ddd)',
              borderRadius: 8,
              background: isFocused
                ? 'rgba(64, 132, 244, 0.08)'
                : 'transparent',
              marginLeft: depth * 18,
              cursor: 'pointer',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minWidth: 0,
                }}
              >
                {entry.isDirectory ? (
                  <button
                    type="button"
                    className="ServiceGhostButton"
                    onClick={() => {
                      toggleDirectory(entry).catch(() => {});
                    }}
                    disabled={directoryLoading || !!entryBusyPath}
                    style={{ minWidth: 34, padding: '0 8px' }}
                  >
                    {directoryExpanded ? 'v' : '>'}
                  </button>
                ) : (
                  <div
                    style={{ width: 34, textAlign: 'center', opacity: 0.55 }}
                  >
                    *
                  </div>
                )}

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>
                    {entry.isDirectory ? '[DIR]' : '[FILE]'} {entry.name}
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      opacity: 0.8,
                      wordBreak: 'break-all',
                      fontSize: 12,
                    }}
                  >
                    {entry.path}
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  marginTop: 8,
                }}
              >
                <span
                  style={badgeStyle(entry.isDirectory ? '#506174' : '#3c4b60')}
                >
                  {entry.isDirectory ? '目录' : formatBytes(entry.size)}
                </span>
                <span style={getModeBadgeStyle(entry.sourceMode)}>
                  {getSourceModeLabel(entry.sourceMode)}
                </span>
                {entry.cid ? (
                  <span style={badgeStyle('#7a4f18')} title={entry.cid}>
                    CID {shortenCid(entry.cid)}
                  </span>
                ) : null}
                {!entry.isDirectory ? (
                  <span
                    style={
                      entry.localPresent === false
                        ? badgeStyle('#7a1f32')
                        : badgeStyle('#2f6a37')
                    }
                  >
                    {entry.localPresent === false ? '本地已删除' : '本地存在'}
                  </span>
                ) : null}
                {entry.virtual ? (
                  <span style={badgeStyle('#6a3e82')}>虚拟目录</span>
                ) : null}
              </div>

              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.82 }}>
                {getStorageHint(entry)}
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
                <>
                  <button
                    type="button"
                    className="ServiceSecondaryButton"
                    onClick={() => {
                      toggleDirectory(entry).catch(() => {});
                    }}
                    disabled={directoryLoading || !!entryBusyPath}
                  >
                    {getDirectoryToggleLabel({
                      directoryLoading,
                      directoryExpanded,
                    })}
                  </button>
                  <button
                    type="button"
                    className="ServiceSecondaryButton"
                    onClick={() => {
                      loadDirectory(entry.path, { focus: true }).catch(
                        () => {},
                      );
                    }}
                    disabled={directoryLoading || !!entryBusyPath}
                  >
                    刷新
                  </button>
                  {!entry.virtual ? null : (
                    <button
                      type="button"
                      className="ServiceSecondaryButton"
                      onClick={() => {
                        deleteManagedEntry(entry).catch(() => {});
                      }}
                      disabled={directoryLoading || managerBusy || !!entryBusyPath}
                    >
                      删除
                    </button>
                  )}
                </>
              ) : (
                <>
                  {entry.sourceMode === 'local' && entry.localPresent !== false ? (
                    <button
                      type="button"
                      className="ServiceSecondaryButton"
                      onClick={() => {
                        convertEntry(entry, true).catch(() => {});
                      }}
                      disabled={rowBusy || !!entryBusyPath || managerBusy}
                      title="把现有本地文件迁入 IPFS，并删除站点目录中的物理副本"
                    >
                      {rowBusy ? '处理中...' : '迁入 IPFS'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ServiceSecondaryButton"
                    onClick={() => {
                      replaceManagedFileEntry(entry).catch(() => {});
                    }}
                    disabled={rowBusy || !!entryBusyPath || managerBusy}
                  >
                    替换
                  </button>
                  <button
                    type="button"
                    className="ServiceSecondaryButton"
                    onClick={() => {
                      deleteManagedEntry(entry).catch(() => {});
                    }}
                    disabled={rowBusy || !!entryBusyPath || managerBusy}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    className="ServiceSecondaryButton"
                    disabled={!entry.cid}
                    onClick={() => {
                      if (!entry.cid) return;
                      copyCid(entry.cid).catch(() => {});
                    }}
                  >
                    复制 CID
                  </button>
                </>
              )}
            </div>
          </div>

          {entry.isDirectory && directoryExpanded ? (
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              {directoryLoading ? (
                <div style={{ marginLeft: depth * 18 + 20, opacity: 0.72 }}>
                  正在加载 {entry.path} ...
                </div>
              ) : null}
              {!directoryLoading &&
              (treeEntries[entry.path] || []).length === 0 ? (
                <div style={{ marginLeft: depth * 18 + 20, opacity: 0.72 }}>
                  当前目录为空。
                </div>
              ) : null}
              {!directoryLoading
                ? (treeEntries[entry.path] || [])
                    .filter((child) => shouldDisplayEntry(child))
                    .map((child) => renderEntryRow(child, depth + 1))
                : null}
            </div>
          ) : null}
        </React.Fragment>
      );
    },
    [
      convertEntry,
      copyCid,
      deleteManagedEntry,
      entryBusyPath,
      expandedPaths,
      focusedPath,
      loadDirectory,
      loadingPaths,
      managerBusy,
      replaceManagedFileEntry,
      shouldDisplayEntry,
      toggleDirectory,
      treeEntries,
    ],
  );

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
        <div style={{ marginTop: 8, opacity: 0.82, lineHeight: 1.6 }}>
          判断规则：只要文件显示为“双源”或“IPFS 托管”，并且同时带有
          CID，就说明服务端资源清单已经记录了它。双源会保留本地文件；IPFS
          托管则可以通过删除本地文件来节省磁盘空间。
        </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            marginTop: 10,
          }}
        >
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={() => setViewMode('manager')}
            disabled={viewMode === 'manager'}
          >
            管理模式
          </button>
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={() => setViewMode('simple')}
            disabled={viewMode === 'simple'}
          >
            简单模式
          </button>
        </div>
        {error ? (
          <div style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</div>
        ) : null}
        {entryMessage ? (
          <div style={{ color: 'var(--success, #2e7d32)', marginTop: 8 }}>
            {entryMessage}
          </div>
        ) : null}
        {copyHint ? (
          <div style={{ color: 'var(--success, #2e7d32)', marginTop: 8 }}>
            {copyHint}
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 10,
          }}
        >
          <span style={badgeStyle('#3c4b60')}>
            目录 {loadedStats.directories}
          </span>
          <span style={badgeStyle('#3c4b60')}>文件 {loadedStats.files}</span>
          <span style={badgeStyle('#355f97')}>
            已转换 {loadedStats.converted}
          </span>
          <span style={badgeStyle('#1d6b57')}>
            IPFS 托管 {loadedStats.ipfsBacked}
          </span>
          <span style={badgeStyle('#4d6386')}>双源 {loadedStats.dual}</span>
          <span style={badgeStyle('#7a4f18')}>CID {loadedStats.withCid}</span>
          <span style={badgeStyle('#7a1f32')}>
            本地已删除 {loadedStats.localRemoved}
          </span>
        </div>
      </div>

      {viewMode === 'simple' ? (
        <div
          style={{
            paddingTop: 8,
            borderTop: '1px solid var(--border-color, #ddd)',
            display: 'grid',
            gap: 12,
          }}
        >
          <div className="ChatTopTitleRow">
            <div className="ChatTopTitle">简单模式</div>
            <div className="ChatTopActions">
              <button
                type="button"
                className="ServiceSecondaryButton"
                onClick={openDir}
                disabled={busy || syncBusy}
                style={{ marginRight: 8 }}
              >
                在资源管理器中打开目录
              </button>
              <button
                type="button"
                className="ServiceSecondaryButton"
                onClick={() => {
                  syncSimpleModeContent().catch(() => {});
                }}
                disabled={busy || syncBusy || !!entryBusyPath}
              >
                {syncBusy ? '同步中...' : '保存内容更改'}
              </button>
            </div>
          </div>

          <div style={{ opacity: 0.86, lineHeight: 1.7 }}>
            <span>
              适合继续在系统资源管理器里维护站点文件。你可以先直接新增、替换、覆盖内容，再回到这里点
              “保存内容更改”。
            </span>
            <span>
              {[
                'WTB 会重新扫描目录，并把尚未纳入资源清单的大文件自动补成“双源”条目，',
                '保留本地文件同时写入 CID。',
              ].join('')}
            </span>
          </div>

          <div style={{ opacity: 0.78, fontSize: 12, lineHeight: 1.7 }}>
            当前实现不会替你自动执行删除确认或目录级差异合并；如果简单模式检测到某些已跟踪文件在本地不存在，
            会在同步结果里提示。更完整的新建目录、上传、替换、删除，建议直接切到上面的管理模式做。
          </div>

          <div
            style={{
              display: 'grid',
              gap: 8,
              padding: '12px',
              border: '1px solid var(--border-color, #ddd)',
              borderRadius: 8,
              background: 'rgba(0, 0, 0, 0.08)',
            }}
          >
            <div style={{ fontWeight: 600 }}>后续方向</div>
            <div style={{ fontSize: 12, opacity: 0.82, lineHeight: 1.7 }}>
              <span>
                {[
                  '简单模式现在定位为兼容入口。',
                  '如果你仍想保留外部编辑习惯，可以继续用它做快速同步。',
                ].join('')}
              </span>
              <span>
                站内统一文件管理已经开始落到这页里，后续会继续往“单一 IPFS 存储事实来源”的方向收敛，而不是再单独强化资源管理器工作流。
              </span>
            </div>
          </div>
        </div>
      ) : null}

      <div
        style={{
          paddingTop: 8,
          borderTop: '1px solid var(--border-color, #ddd)',
          display: viewMode === 'manager' ? 'block' : 'none',
        }}
      >
        <div className="ChatTopTitleRow">
          <div className="ChatTopTitle">管理模式 / 站内文件管理</div>
          <div className="ChatTopActions">
            <button
              type="button"
              className="ServiceSecondaryButton"
              onClick={() => {
                createDirectoryInManager(focusedDirectoryPath).catch(() => {});
              }}
              disabled={managerBusy || syncBusy || !!entryBusyPath}
              style={{ marginRight: 8 }}
            >
              新建目录
            </button>
            <button
              type="button"
              className="ServiceSecondaryButton"
              onClick={() => {
                importFilesIntoManager(focusedDirectoryPath).catch(() => {});
              }}
              disabled={managerBusy || syncBusy || !!entryBusyPath}
              style={{ marginRight: 8 }}
            >
              上传文件
            </button>
            <button
              type="button"
              className="ServiceSecondaryButton"
              onClick={() => {
                importDirectoryIntoManager(focusedDirectoryPath).catch(() => {});
              }}
              disabled={managerBusy || syncBusy || !!entryBusyPath}
              style={{ marginRight: 8 }}
            >
              导入目录
            </button>
            {focusedEntry && focusedEntry.path !== '/' ? (
              <button
                type="button"
                className="ServiceSecondaryButton"
                onClick={() => {
                  deleteManagedEntry(focusedEntry).catch(() => {});
                }}
                disabled={managerBusy || syncBusy || !!entryBusyPath}
                style={{ marginRight: 8 }}
              >
                删除当前选中
              </button>
            ) : null}
            <button
              type="button"
              className="ServiceSecondaryButton"
              onClick={() => {
                loadDirectory('/', { focus: true }).catch(() => {});
              }}
              disabled={!!entryBusyPath || !!loadingPaths['/'] || managerBusy}
              style={{ marginRight: 8 }}
            >
              刷新根目录
            </button>
            <button
              type="button"
              className="ServiceSecondaryButton"
              onClick={() => {
                refreshExpandedDirectories().catch(() => {});
              }}
              disabled={!!entryBusyPath || managerBusy}
            >
              刷新已展开目录
            </button>
          </div>
        </div>

        <div style={{ padding: '8px 0' }}>
          <div>当前选中：{focusedEntry ? focusedEntry.path : focusedPath}</div>
          <div style={{ marginTop: 4, opacity: 0.8 }}>
            当前操作目录：{focusedDirectoryPath}
          </div>
          <div style={{ marginTop: 4, opacity: 0.8 }}>
            这里已经按站内文件管理来组织：新增目录、上传文件、导入目录、替换、删除都直接写入站点内容清单。新导入的内容默认直接落成 IPFS 托管，不再要求你先把文件放进站点目录再二次转换。
          </div>
          {focusedEntry && !focusedEntry.isDirectory ? (
            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                marginTop: 10,
              }}
            >
              <button
                type="button"
                className="ServiceSecondaryButton"
                onClick={() => {
                  replaceManagedFileEntry(focusedEntry).catch(() => {});
                }}
                disabled={managerBusy || !!entryBusyPath}
              >
                替换当前文件
              </button>
              <button
                type="button"
                className="ServiceSecondaryButton"
                onClick={() => {
                  deleteManagedEntry(focusedEntry).catch(() => {});
                }}
                disabled={managerBusy || !!entryBusyPath}
              >
                删除当前文件
              </button>
            </div>
          ) : null}
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              marginTop: 10,
            }}
          >
            <button
              type="button"
              className="ServiceSecondaryButton"
              onClick={() => setFilterMode('all')}
              disabled={filterMode === 'all'}
            >
              全部
            </button>
            <button
              type="button"
              className="ServiceSecondaryButton"
              onClick={() => setFilterMode('converted')}
              disabled={filterMode === 'converted'}
            >
              仅看已转换
            </button>
            <button
              type="button"
              className="ServiceSecondaryButton"
              onClick={() => setFilterMode('ipfs-backed')}
              disabled={filterMode === 'ipfs-backed'}
            >
              仅看 IPFS 托管
            </button>
            <button
              type="button"
              className="ServiceSecondaryButton"
              onClick={() => setFilterMode('local-only')}
              disabled={filterMode === 'local-only'}
            >
              仅看本地
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          {loadingPaths['/'] && rootEntries.length === 0 ? (
            <div>正在加载根目录...</div>
          ) : null}
          {!loadingPaths['/'] &&
          rootEntries.filter((entry) => shouldDisplayEntry(entry)).length ===
            0 ? (
            <div>当前根目录下没有符合条件的条目。</div>
          ) : null}
          {rootEntries
            .filter((entry) => shouldDisplayEntry(entry))
            .map((entry) => renderEntryRow(entry, 0))}
        </div>
      </div>
    </div>
  );
}
