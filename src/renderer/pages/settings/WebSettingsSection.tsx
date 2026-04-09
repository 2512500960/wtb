import * as React from 'react';
import { FileManager } from '@cubone/react-file-manager';
import { createPortal } from 'react-dom';
import '@cubone/react-file-manager/dist/style.css';

const ROOT_MANAGER_PATH = '';

type ManagedWebEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  cid?: string;
};

type ManagerFileItem = {
  name: string;
  isDirectory: boolean;
  path: string;
  updatedAt?: string;
  size?: number;
  cid?: string;
};

type ManagedImportResult = {
  importedFiles: number;
  importedDirectories: number;
  overwrittenPaths: string[];
  paths: string[];
};

type IpfsStorageSummary = {
  running: boolean;
  repoDir: string;
  repoSizeBytes: number;
  storageMaxBytes: number | null;
  numObjects: number | null;
  diskAvailableBytes: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
};

type RepoMigrationResult = {
  fromDir: string;
  toDir: string;
  restarted: boolean;
};

type TaskProgressPayload = {
  operation:
    | 'import-files'
    | 'import-directory'
    | 'migrate-web-content'
    | 'migrate-repo';
  stage: 'running' | 'completed' | 'failed';
  current: number;
  total: number;
  message: string;
};

const toManagerPath = (webPath: string): string => {
  return webPath === '/' ? ROOT_MANAGER_PATH : webPath;
};

const fromManagerPath = (managerPath: string | null | undefined): string => {
  const value = (managerPath || '').trim();
  if (!value) return '/';
  return value.startsWith('/') ? value : `/${value}`;
};

const toManagerFile = (entry: ManagedWebEntry): ManagerFileItem => ({
  name: entry.name,
  isDirectory: entry.isDirectory,
  path: toManagerPath(entry.path),
  updatedAt: entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : undefined,
  size: entry.isDirectory ? undefined : entry.size,
  cid: entry.cid,
});

const formatBytes = (bytes: number | null | undefined): string => {
  if (!Number.isFinite(bytes) || bytes == null || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

const formatPercent = (
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): string => {
  if (
    !Number.isFinite(numerator) ||
    numerator == null ||
    !Number.isFinite(denominator) ||
    denominator == null ||
    denominator <= 0
  ) {
    return '—';
  }

  return `${((numerator / denominator) * 100).toFixed(1)}%`;
};

const getProgressLabel = (state: {
  storageBusy: boolean;
  loadingEntries: boolean;
  operationBusy: boolean;
  taskProgress: TaskProgressPayload | null;
}): string => {
  if (state.taskProgress?.message) return state.taskProgress.message;
  if (state.operationBusy) return '正在处理站点内容…';
  if (state.storageBusy) return '正在读取 IPFS 存储信息…';
  if (state.loadingEntries) return '正在刷新文件列表…';
  return '';
};

const getProgressPercent = (
  taskProgress: TaskProgressPayload | null,
): number | null => {
  if (!taskProgress) return null;
  if (taskProgress.stage === 'completed') return 100;
  if (taskProgress.total <= 0) return null;
  const ratio = (taskProgress.current / taskProgress.total) * 100;
  return Math.max(0, Math.min(100, ratio));
};

export default function WebSettingsSection() {
  const fileManagerThemeRef = React.useRef<HTMLDivElement | null>(null);
  const [loadingEntries, setLoadingEntries] = React.useState(false);
  const [storageBusy, setStorageBusy] = React.useState(false);
  const [operationBusy, setOperationBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [copyHint, setCopyHint] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<ManagedWebEntry[]>([]);
  const [storageSummary, setStorageSummary] =
    React.useState<IpfsStorageSummary | null>(null);
  const [currentManagerPath, setCurrentManagerPath] =
    React.useState(ROOT_MANAGER_PATH);
  const [selectedFiles, setSelectedFiles] = React.useState<ManagerFileItem[]>(
    [],
  );
  const [managerResetKey, setManagerResetKey] = React.useState(0);
  const [taskProgress, setTaskProgress] =
    React.useState<TaskProgressPayload | null>(null);
  const [toolbarActionsHost, setToolbarActionsHost] =
    React.useState<HTMLElement | null>(null);

  const refreshStorageSummary = React.useCallback(async () => {
    setStorageBusy(true);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'ipfs:storageSummary',
      )) as IpfsStorageSummary;
      setStorageSummary(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStorageBusy(false);
    }
  }, []);

  const refreshEntries = React.useCallback(
    async (options?: { migrate?: boolean; resetPath?: boolean }) => {
      setLoadingEntries(true);
      try {
        if (options?.migrate) {
          const migrateRes = (await window.electron.ipcRenderer.invoke(
            'wtb:web:migrateToManagedIpfs',
          )) as {
            ok?: boolean;
            error?: string;
            result?: { migratedFiles: number; migratedDirectories: number };
          };
          if (!migrateRes?.ok) {
            setError(migrateRes?.error ?? '同步现有内容到 IPFS 失败');
          } else if (migrateRes.result) {
            const { migratedFiles, migratedDirectories } = migrateRes.result;
            if (migratedFiles > 0 || migratedDirectories > 0) {
              setMessage(
                `已同步 ${migratedFiles} 个文件、${migratedDirectories} 个目录到统一 IPFS 内容存储。`,
              );
            }
          }
        }

        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:listAllEntries',
        )) as {
          ok?: boolean;
          error?: string;
          entries?: ManagedWebEntry[];
        };
        if (!res?.ok) {
          setError(res?.error ?? '读取站点内容失败');
          return;
        }

        setEntries(res.entries || []);
        if (options?.resetPath) {
          setCurrentManagerPath(ROOT_MANAGER_PATH);
          setManagerResetKey((value) => value + 1);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingEntries(false);
      }
    },
    [],
  );

  const refreshAll = React.useCallback(
    async (options?: { migrate?: boolean; resetPath?: boolean }) => {
      setError(null);
      await refreshEntries(options);
      await refreshStorageSummary();
    },
    [refreshEntries, refreshStorageSummary],
  );

  React.useEffect(() => {
    refreshAll({ migrate: true, resetPath: true }).catch(() => {
      // ignore
    });
  }, [refreshAll]);

  React.useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on(
      'wtb:web:taskProgress',
      (payload) => {
        setTaskProgress(payload as TaskProgressPayload);
      },
    );

    return () => {
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    if (!taskProgress || taskProgress.stage === 'running') {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setTaskProgress((current) => {
        if (!current || current.stage === 'running') {
          return current;
        }
        return null;
      });
    }, 2400);

    return () => {
      window.clearTimeout(timer);
    };
  }, [taskProgress]);

  React.useEffect(() => {
    const container = fileManagerThemeRef.current;
    if (!container) {
      setToolbarActionsHost(null);
      return undefined;
    }

    const syncToolbarHost = () => {
      const nextHost = container.querySelector(
        '.toolbar .fm-toolbar > div:first-child',
      );
      setToolbarActionsHost(nextHost instanceof HTMLElement ? nextHost : null);
    };

    syncToolbarHost();

    const observer = new MutationObserver(() => {
      syncToolbarHost();
    });

    observer.observe(container, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
    };
  }, [managerResetKey]);

  const managerFiles = React.useMemo(
    () => entries.map(toManagerFile),
    [entries],
  );

  const selectedEntryPaths = React.useMemo(
    () => selectedFiles.map((file) => fromManagerPath(file.path)),
    [selectedFiles],
  );

  const selectedEntries = React.useMemo(
    () => entries.filter((entry) => selectedEntryPaths.includes(entry.path)),
    [entries, selectedEntryPaths],
  );

  const fileCount = React.useMemo(
    () => entries.filter((entry) => !entry.isDirectory).length,
    [entries],
  );

  const directoryCount = React.useMemo(
    () => entries.filter((entry) => entry.isDirectory).length,
    [entries],
  );

  const cidCount = React.useMemo(
    () => entries.filter((entry) => !entry.isDirectory && !!entry.cid).length,
    [entries],
  );

  const managedContentBytes = React.useMemo(
    () =>
      entries.reduce((totalBytes, entry) => {
        return entry.isDirectory ? totalBytes : totalBytes + (entry.size || 0);
      }, 0),
    [entries],
  );

  const selectedCidCount = React.useMemo(
    () => selectedEntries.filter((entry) => !!entry.cid).length,
    [selectedEntries],
  );

  const currentWebPath = React.useMemo(
    () => fromManagerPath(currentManagerPath),
    [currentManagerPath],
  );

  const quotaPercent = React.useMemo(
    () =>
      formatPercent(
        storageSummary?.repoSizeBytes,
        storageSummary?.storageMaxBytes,
      ),
    [storageSummary],
  );

  const diskPercent = React.useMemo(
    () =>
      formatPercent(
        storageSummary?.diskUsedBytes,
        storageSummary?.diskTotalBytes,
      ),
    [storageSummary],
  );

  const importFiles = React.useCallback(async () => {
    setError(null);
    setMessage(null);
    setOperationBusy(true);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'wtb:web:pickAndImportFiles',
        currentWebPath,
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
      await refreshAll();
      setMessage(
        `已导入 ${res.result.importedFiles} 个文件${
          res.result.overwrittenPaths.length
            ? `，覆盖 ${res.result.overwrittenPaths.length} 个同名路径`
            : ''
        }。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOperationBusy(false);
    }
  }, [currentWebPath, refreshAll]);

  const importDirectory = React.useCallback(async () => {
    setError(null);
    setMessage(null);
    setOperationBusy(true);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'wtb:web:pickAndImportDirectory',
        currentWebPath,
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
      await refreshAll();
      setMessage(
        `已导入目录，新增 ${res.result.importedDirectories} 个目录、${res.result.importedFiles} 个文件。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOperationBusy(false);
    }
  }, [currentWebPath, refreshAll]);

  const refreshManagedContent = React.useCallback(async () => {
    await refreshAll({ migrate: true });
  }, [refreshAll]);

  const copyCid = React.useCallback(async () => {
    const cid = selectedEntries.find((entry) => !!entry.cid)?.cid;
    if (!cid) return;

    try {
      await navigator.clipboard.writeText(cid);
      setCopyHint('CID 已复制');
    } catch {
      setCopyHint('复制失败');
    }
    window.setTimeout(() => setCopyHint(null), 1200);
  }, [selectedEntries]);

  const migrateRepoDirectory = React.useCallback(async () => {
    setError(null);
    setMessage(null);
    setOperationBusy(true);
    try {
      const pick = (await window.electron.ipcRenderer.invoke(
        'dialog:selectDirectory',
      )) as {
        ok?: boolean;
        canceled?: boolean;
        path?: string;
      };
      if (!pick?.ok || pick.canceled || !pick.path) {
        return;
      }

      const res = (await window.electron.ipcRenderer.invoke(
        'ipfs:migrateRepoDir',
        pick.path,
      )) as {
        ok?: boolean;
        error?: string;
        result?: RepoMigrationResult;
      };
      if (!res?.ok || !res.result) {
        setError(res?.error ?? '迁移 IPFS 数据目录失败');
        return;
      }

      await refreshStorageSummary();
      setMessage(
        `已将 IPFS 数据目录迁移到 ${res.result.toDir}${
          res.result.restarted ? '，并自动恢复 IPFS 服务。' : '。'
        }`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOperationBusy(false);
    }
  }, [refreshStorageSummary]);

  const handleCreateFolder = React.useCallback(
    async (name: string, parentFolder?: { path?: string }) => {
      setError(null);
      setMessage(null);
      setOperationBusy(true);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:createDirectory',
          fromManagerPath(parentFolder?.path || currentManagerPath),
          name,
        )) as {
          ok?: boolean;
          error?: string;
          result?: { path: string; created: boolean };
        };
        if (!res?.ok || !res.result) {
          setError(res?.error ?? '新建目录失败');
          return;
        }
        await refreshAll();
        setMessage(
          res.result.created
            ? `已创建目录 ${res.result.path}`
            : `目录已存在：${res.result.path}`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setOperationBusy(false);
      }
    },
    [currentManagerPath, refreshAll],
  );

  const handleRename = React.useCallback(
    async (file: { path: string }, newName: string) => {
      setError(null);
      setMessage(null);
      setOperationBusy(true);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:renameEntry',
          fromManagerPath(file.path),
          newName,
        )) as {
          ok?: boolean;
          error?: string;
          result?: { toPath: string };
        };
        if (!res?.ok || !res.result) {
          setError(res?.error ?? '重命名失败');
          return;
        }
        await refreshAll();
        setMessage(`已重命名为 ${res.result.toPath}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setOperationBusy(false);
      }
    },
    [refreshAll],
  );

  const handleDelete = React.useCallback(
    async (files: Array<{ path: string; name: string }>) => {
      if (!files.length) return;

      setError(null);
      setMessage(null);
      setOperationBusy(true);
      try {
        await Promise.all(
          files.map(async (file) => {
            const res = (await window.electron.ipcRenderer.invoke(
              'wtb:web:deleteEntry',
              fromManagerPath(file.path),
            )) as {
              ok?: boolean;
              error?: string;
            };
            if (!res?.ok) {
              throw new Error(res?.error ?? `删除失败：${file.name}`);
            }
          }),
        );
        await refreshAll();
        setMessage(`已删除 ${files.length} 个条目。`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setOperationBusy(false);
      }
    },
    [refreshAll],
  );

  const handlePaste = React.useCallback(
    async (
      files: Array<{ path: string }>,
      destinationFolder: { path?: string },
      operationType: 'copy' | 'move',
    ) => {
      if (!files.length) return;

      setError(null);
      setMessage(null);
      setOperationBusy(true);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'wtb:web:pasteEntries',
          files.map((file) => fromManagerPath(file.path)),
          fromManagerPath(destinationFolder?.path || currentManagerPath),
          operationType,
        )) as {
          ok?: boolean;
          error?: string;
          result?: { operationType: 'copy' | 'move' };
        };
        if (!res?.ok || !res.result) {
          setError(res?.error ?? '粘贴失败');
          return;
        }
        await refreshAll();
        setMessage(
          `${res.result.operationType === 'move' ? '已移动' : '已复制'} ${
            files.length
          } 个条目。`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setOperationBusy(false);
      }
    },
    [currentManagerPath, refreshAll],
  );

  const progressLabel = getProgressLabel({
    storageBusy,
    loadingEntries,
    operationBusy,
    taskProgress,
  });
  const progressPercent = getProgressPercent(taskProgress);
  const busy = storageBusy || loadingEntries || operationBusy;

  return (
    <div className="ChatTopPanel">
      <div className="ChatTopTitleRow">
        <div className="ChatTopTitle">Web IPFS 文件管理</div>
        <div className="ChatTopActions">
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={() => {
              refreshManagedContent().catch(() => {
                // ignore
              });
            }}
            disabled={busy}
          >
            {busy ? '处理中…' : '刷新内容'}
          </button>
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={() => {
              migrateRepoDirectory().catch(() => {
                // ignore
              });
            }}
            disabled={busy}
          >
            迁移数据目录
          </button>
          <button
            type="button"
            className="ServiceSecondaryButton"
            onClick={() => {
              copyCid().catch(() => {
                // ignore
              });
            }}
            disabled={selectedCidCount === 0}
          >
            复制选中 CID
          </button>
        </div>
      </div>

      <div style={{ padding: '10px 0' }}>
        <div style={{ marginTop: 8, opacity: 0.82, lineHeight: 1.7 }}>
          页面现在围绕统一 IPFS
          存储工作：上传文件和上传目录已经并入文件管理器工具栏，但实际导入仍然走后台
          IPC，避免把 Kubo 相关重活放在 renderer 线程里阻塞界面。
        </div>
        <div style={{ marginTop: 8, opacity: 0.82, lineHeight: 1.7 }}>
          组件自带的删除确认已经保留，所以页面外层不再重复确认。文件管理器里看到的上传入口现在只是统一触发桌面端选择器和后台导入管道，不会退回浏览器内
          HTTP 直传；导入和迁移任务的进度也继续沿着这条后台任务链回传到页面。
        </div>

        {error ? (
          <div style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</div>
        ) : null}
        {message ? (
          <div style={{ color: 'var(--success, #7ee0a5)', marginTop: 8 }}>
            {message}
          </div>
        ) : null}
        {copyHint ? (
          <div style={{ color: 'var(--success, #7ee0a5)', marginTop: 8 }}>
            {copyHint}
          </div>
        ) : null}
        {progressLabel ? (
          <div className="WebStorageProgress" style={{ marginTop: 12 }}>
            <div
              className={`WebStorageProgressBar${
                progressPercent == null
                  ? ' WebStorageProgressBarIndeterminate'
                  : ''
              }`}
            >
              {progressPercent != null ? (
                <div
                  className="WebStorageProgressBarFill"
                  style={{ width: `${progressPercent}%` }}
                />
              ) : null}
            </div>
            <div className="WebStorageProgressText">{progressLabel}</div>
          </div>
        ) : null}

        <div className="WebStorageGrid" style={{ marginTop: 14 }}>
          <div className="WebStorageCard">
            <div className="WebStorageLabel">站点内容</div>
            <div className="WebStorageValue">
              {formatBytes(managedContentBytes)}
            </div>
            <div className="WebStorageMeta">
              文件 {fileCount}，目录 {directoryCount}，CID {cidCount}
            </div>
          </div>

          <div className="WebStorageCard">
            <div className="WebStorageLabel">IPFS Repo 已用</div>
            <div className="WebStorageValue">
              {formatBytes(storageSummary?.repoSizeBytes)}
            </div>
            <div className="WebStorageMeta">
              对象数 {storageSummary?.numObjects ?? '—'}
            </div>
          </div>

          <div className="WebStorageCard">
            <div className="WebStorageLabel">IPFS 配额</div>
            <div className="WebStorageValue">
              {storageSummary?.storageMaxBytes != null
                ? `${formatBytes(storageSummary.repoSizeBytes)} / ${formatBytes(
                    storageSummary.storageMaxBytes,
                  )}`
                : '未配置'}
            </div>
            <div className="WebStorageMeta">占比 {quotaPercent}</div>
          </div>

          <div className="WebStorageCard">
            <div className="WebStorageLabel">所在磁盘</div>
            <div className="WebStorageValue">
              {formatBytes(storageSummary?.diskAvailableBytes)} 可用
            </div>
            <div className="WebStorageMeta">
              已用 {formatBytes(storageSummary?.diskUsedBytes)} / 总计{' '}
              {formatBytes(storageSummary?.diskTotalBytes)}，占比 {diskPercent}
            </div>
          </div>

          <div className="WebStorageCard WebStorageCardWide">
            <div className="WebStorageLabel">数据目录</div>
            <div className="WebStorageValue WebStorageValuePath">
              {storageSummary?.repoDir ?? '—'}
            </div>
            <div className="WebStorageMeta">
              当前目录 {currentWebPath}，已选 {selectedFiles.length}，IPFS 服务
              {storageSummary?.running ? '运行中' : '未运行'}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          paddingTop: 8,
          borderTop: '1px solid var(--border-color, #000000)',
          display: 'grid',
          gap: 12,
        }}
      >
        <div className="ChatTopTitleRow">
          <div className="ChatTopTitle">站点内容</div>
        </div>

        <div style={{ opacity: 0.8, lineHeight: 1.6 }}>
          文件管理器负责目录浏览、重命名、删除、拖拽移动和复制。上传文件和上传目录现在也已经收进工具栏，依旧触发后台
          IPC 任务，避免和当前的桌面端导入管道分叉。
        </div>

        <div
          ref={fileManagerThemeRef}
          className="WebFileManagerTheme"
          style={{ minHeight: 720 }}
        >
          <FileManager
            key={managerResetKey}
            // className="WebSettingsFileManager"
            files={managerFiles}
            initialPath={currentManagerPath}
            onFolderChange={setCurrentManagerPath}
            onSelectionChange={(files: ManagerFileItem[]) =>
              setSelectedFiles(files)
            }
            onCreateFolder={handleCreateFolder}
            onRename={handleRename}
            onDelete={handleDelete}
            onPaste={handlePaste}
            onRefresh={() => {
              refreshManagedContent().catch(() => {
                // ignore
              });
            }}
            onFileOpen={(file: ManagerFileItem) => {
              if (file.isDirectory) {
                setCurrentManagerPath(file.path);
              }
            }}
            isLoading={busy}
            // layout="list"
            enableFilePreview={false}
            height="720px"
            width="100%"
            language="zh-CN"
            primaryColor="var(--primary-color, #000000)"
            permissions={{
              create: true,
              upload: true,
              move: true,
              copy: true,
              rename: true,
              download: true,
              delete: true,
            }}
            onError={(nextError: { message?: string }) => {
              if (nextError?.message) {
                setError(nextError.message);
              }
            }}
            formatDate={(value: string | Date) => {
              const date = value instanceof Date ? value : new Date(value);
              return Number.isNaN(date.getTime())
                ? ''
                : date.toLocaleString('zh-CN', { hour12: false });
            }}
          />
          {toolbarActionsHost
            ? createPortal(
                <>
                  <button
                    type="button"
                    className="item-action WebFileManagerToolbarAction"
                    onClick={() => {
                      importFiles().catch(() => {
                        // ignore
                      });
                    }}
                    disabled={busy}
                  >
                    <span>上传文件</span>
                  </button>
                  <button
                    type="button"
                    className="item-action WebFileManagerToolbarAction"
                    onClick={() => {
                      importDirectory().catch(() => {
                        // ignore
                      });
                    }}
                    disabled={busy}
                  >
                    <span>上传目录</span>
                  </button>
                </>,
                toolbarActionsHost,
              )
            : null}
        </div>
      </div>
    </div>
  );
}
