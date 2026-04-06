import * as React from 'react';
import { Link } from 'react-router-dom';

import type {
  RemoteResourceFetchResult,
  RemoteResourcePreparedEntry,
  RemoteResourceSource,
} from '../../types/remote_resources';

function isVideo(mime?: string): boolean {
  return (mime || '').startsWith('video/');
}

function isAudio(mime?: string): boolean {
  return (mime || '').startsWith('audio/');
}

function isImage(mime?: string): boolean {
  return (mime || '').startsWith('image/');
}

function isPdf(mime?: string): boolean {
  return (mime || '') === 'application/pdf';
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function isLargeFile(entry: RemoteResourcePreparedEntry): boolean {
  return entry.size >= 5 * 1024 * 1024;
}

function getEntrySourceBucket(entry: RemoteResourcePreparedEntry): string {
  if (isVideo(entry.mime) || isAudio(entry.mime)) return 'media';
  if (isImage(entry.mime)) return 'image';
  if (isPdf(entry.mime)) return 'document';
  if (isLargeFile(entry)) return 'large';
  return 'generic';
}

function getSourceLabel(source: RemoteResourceSource): string {
  return source === 'ipfs' ? 'IPFS' : 'HTTP';
}

export default function RemoteResourcesPage() {
  const [baseUrlInput, setBaseUrlInput] = React.useState('');
  const [currentPath, setCurrentPath] = React.useState('/');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<RemoteResourceFetchResult | null>(
    null,
  );
  const [selectedEntry, setSelectedEntry] = React.useState<RemoteResourcePreparedEntry | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewSource, setPreviewSource] = React.useState<'http' | 'ipfs' | null>(null);
  const [previewNotice, setPreviewNotice] = React.useState<string | null>(null);
  const [copyHint, setCopyHint] = React.useState<string | null>(null);
  const [sessionSourcePreferences, setSessionSourcePreferences] = React.useState<
    Record<string, RemoteResourceSource>
  >({});

  const getSourcePreferenceKey = React.useCallback(
    (entry: RemoteResourcePreparedEntry, baseUrl: string) => {
      return `${baseUrl}|${getEntrySourceBucket(entry)}`;
    },
    [],
  );

  const chooseSourceForEntry = React.useCallback(
    (entry: RemoteResourcePreparedEntry, baseUrl: string) => {
      const preferenceKey = getSourcePreferenceKey(entry, baseUrl);
      const preferred = sessionSourcePreferences[preferenceKey];
      if (preferred === 'ipfs' && entry.ipfsUrl) {
        return {
          source: 'ipfs' as const,
          url: entry.ipfsUrl,
          notice: '本次会话已提升同类资源的 IPFS 优先级。',
        };
      }

      if (preferred === 'http') {
        return {
          source: 'http' as const,
          url: entry.httpUrl,
          notice: '本次会话检测到同类资源更适合先走 HTTP。',
        };
      }

      return {
        source: entry.preferredSource,
        url: entry.preferredUrl,
        notice: entry.recommendedReason,
      };
    },
    [getSourcePreferenceKey, sessionSourcePreferences],
  );

  const updateSessionSourcePreference = React.useCallback(
    (entry: RemoteResourcePreparedEntry, baseUrl: string, source: RemoteResourceSource) => {
      const preferenceKey = getSourcePreferenceKey(entry, baseUrl);
      setSessionSourcePreferences((current) => {
        if (current[preferenceKey] === source) return current;
        return {
          ...current,
          [preferenceKey]: source,
        };
      });
    },
    [getSourcePreferenceKey],
  );

  const loadManifest = React.useCallback(
    async (baseUrl: string, requestedPath: string) => {
      setBusy(true);
      setError(null);
      setPreviewNotice(null);
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'remote-resources:fetchManifest',
          baseUrl,
          requestedPath,
        )) as RemoteResourceFetchResult;
        setResult(res);
        setCurrentPath(res.path);
        setSelectedEntry(null);
        setPreviewUrl(null);
        setPreviewSource(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const openPreview = React.useCallback((entry: RemoteResourcePreparedEntry) => {
    if (!result) return;
    const next = chooseSourceForEntry(entry, result.baseUrl);
    setSelectedEntry(entry);
    setPreviewNotice(next.notice);
    setPreviewUrl(next.url);
    setPreviewSource(next.source);
  }, [chooseSourceForEntry, result]);

  const handlePreviewSuccess = React.useCallback(() => {
    if (!selectedEntry || !result || !previewSource) return;

    if (previewSource === 'ipfs' && selectedEntry.ipfsUrl) {
      updateSessionSourcePreference(selectedEntry, result.baseUrl, 'ipfs');
      setPreviewNotice('IPFS 可用，当前会话后续同类资源将优先尝试 IPFS。');
      return;
    }

    if (previewSource === 'http' && selectedEntry.ipfsUrl) {
      updateSessionSourcePreference(selectedEntry, result.baseUrl, 'http');
    }
  }, [previewSource, result, selectedEntry, updateSessionSourcePreference]);

  const handlePreviewError = React.useCallback(() => {
    if (
      selectedEntry &&
      result &&
      previewSource === 'ipfs' &&
      selectedEntry.fallbackUrl &&
      previewUrl !== selectedEntry.fallbackUrl
    ) {
      updateSessionSourcePreference(selectedEntry, result.baseUrl, 'http');
      setPreviewUrl(selectedEntry.fallbackUrl);
      setPreviewSource('http');
      setPreviewNotice('IPFS 访问失败，已自动回退到 HTTP，并降低当前会话同类资源的 IPFS 优先级。');
      return;
    }
    setPreviewNotice('资源加载失败。');
  }, [previewSource, previewUrl, result, selectedEntry, updateSessionSourcePreference]);

  const copyCid = React.useCallback(async (cid: string) => {
    const ok = await copyText(cid);
    setCopyHint(ok ? 'CID 已复制' : '复制失败');
    window.setTimeout(() => setCopyHint(null), 1200);
  }, []);

  const parentPath = React.useMemo(() => {
    if (currentPath === '/') return null;
    const up = currentPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    return up ? `${up}/`.replace(/\/\/+/, '/') : '/';
  }, [currentPath]);

  return (
    <div className="LauncherRoot">
      <div className="ServiceHeader">
        <div className="ServiceTitle">WTB 远程内容</div>
        <Link className="ServiceGhostButton" to="/">
          返回首页
        </Link>
      </div>

      <div className="ServiceHint">
        输入远端 WTB 服务地址。目录清单始终通过 HTTP 获取；媒体和大文件会优先尝试本地 IPFS gateway，失败后自动回退到 HTTP。
      </div>

      <div className="ResourceToolbar">
        <input
          className="ChatInput"
          placeholder="例如 http://[200:xxxx:...]:8137"
          value={baseUrlInput}
          onChange={(e) => setBaseUrlInput(e.target.value)}
          disabled={busy}
        />
        <input
          className="ChatInput"
          placeholder="目录路径，例如 / 或 /video"
          value={currentPath}
          onChange={(e) => setCurrentPath(e.target.value || '/')}
          disabled={busy}
        />
        <button
          type="button"
          className="ServicePrimaryButton"
          disabled={busy}
          onClick={() => loadManifest(baseUrlInput, currentPath)}
        >
          {busy ? '加载中…' : '加载资源'}
        </button>
      </div>

      {error ? <div className="ServiceError">{error}</div> : null}
      {copyHint ? <div className="ServiceHint">{copyHint}</div> : null}

      {result ? (
        <>
          <div className="ServiceHint">
            当前目录：{result.path}
            <br />
            清单地址：{result.manifestUrl}
            <br />
            本地 IPFS：{result.localIpfs.running ? '运行中' : '未运行'}
            {result.localIpfs.connected.length > 0 ? (
              <>
                <br />
                已尝试连接远端 IPFS 地址：{result.localIpfs.connected.length} 条成功
              </>
            ) : null}
            {result.localIpfs.failed.length > 0 ? (
              <>
                <br />
                远端 IPFS 地址连接失败：{result.localIpfs.failed.length} 条
              </>
            ) : null}
          </div>

          <div className="ResourceLayout">
            <div className="ResourceListCard">
              <div className="ServiceTitle" style={{ fontSize: 16 }}>
                资源列表
              </div>
              {parentPath ? (
                <button
                  type="button"
                  className="ServiceGhostButton"
                  style={{ marginTop: 10 }}
                  onClick={() => loadManifest(baseUrlInput, parentPath)}
                >
                  返回上级目录
                </button>
              ) : null}
              <div className="ResourceList">
                {result.entries.map((entry) => (
                  <div key={`${entry.path}-${entry.name}`} className="ResourceRow">
                    <div className="ResourceMetaBlock">
                      <div className="ResourceName">
                        {entry.isDirectory ? '📁' : '📄'} {entry.name}
                      </div>
                      <div className="ServiceHint">
                        {entry.path}
                        {entry.isDirectory
                          ? ''
                          : ` · ${entry.mime || '未知类型'} · ${entry.size} bytes`}
                        {entry.cid ? ' · CID 可用' : ''}
                        {!entry.isDirectory
                          ? ` · 推荐源：${getSourceLabel(entry.recommendedSource)}`
                          : ''}
                      </div>
                      {!entry.isDirectory ? (
                        <div className="ServiceHint">
                          可用源：{entry.availableSources.map(getSourceLabel).join(' / ')}
                          {' · '}
                          {entry.recommendedReason}
                        </div>
                      ) : null}
                    </div>
                    <div className="ResourceActions">
                      {entry.isDirectory ? (
                        <button
                          type="button"
                          className="ServiceGhostButton"
                          onClick={() => loadManifest(baseUrlInput, entry.path)}
                        >
                          打开目录
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="ServiceGhostButton"
                            onClick={() => openPreview(entry)}
                          >
                            预览
                          </button>
                          <button
                            type="button"
                            className="ServiceGhostButton"
                            onClick={() =>
                              window.electron.ipcRenderer.invoke(
                                'open-external',
                                entry.httpUrl,
                              )
                            }
                          >
                            HTTP
                          </button>
                          <button
                            type="button"
                            className="ServiceGhostButton"
                            disabled={!entry.ipfsUrl}
                            onClick={() => {
                              if (!entry.ipfsUrl) return;
                              window.electron.ipcRenderer.invoke(
                                'open-external',
                                entry.ipfsUrl,
                              );
                            }}
                          >
                            IPFS
                          </button>
                          <button
                            type="button"
                            className="ServiceGhostButton"
                            disabled={!entry.cid}
                            onClick={() => {
                              if (!entry.cid) return;
                              copyCid(entry.cid).catch(() => {
                                // ignore
                              });
                            }}
                          >
                            复制 CID
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="ResourcePreviewCard">
              <div className="ServiceTitle" style={{ fontSize: 16 }}>
                预览区
              </div>
              {!selectedEntry || !previewUrl ? (
                <div className="ServiceHint">选择一个文件后在这里预览。</div>
              ) : (
                <>
                  <div className="ServiceHint" style={{ marginBottom: 10 }}>
                    当前资源：{selectedEntry.name}
                    <br />
                    当前来源：{previewSource === 'ipfs' ? 'IPFS' : 'HTTP'}
                    <br />
                    推荐来源：{getSourceLabel(selectedEntry.recommendedSource)}
                    {previewNotice ? (
                      <>
                        <br />
                        {previewNotice}
                      </>
                    ) : null}
                  </div>
                  {isVideo(selectedEntry.mime) ? (
                    <video
                      key={previewUrl}
                      className="ResourceVideo"
                      controls
                      src={previewUrl}
                      onLoadedData={handlePreviewSuccess}
                      onError={handlePreviewError}
                    />
                  ) : null}
                  {isAudio(selectedEntry.mime) ? (
                    <audio
                      key={previewUrl}
                      controls
                      src={previewUrl}
                      onLoadedData={handlePreviewSuccess}
                      onError={handlePreviewError}
                      style={{ width: '100%' }}
                    />
                  ) : null}
                  {isImage(selectedEntry.mime) ? (
                    <img
                      key={previewUrl}
                      className="ResourceImage"
                      src={previewUrl}
                      alt={selectedEntry.name}
                      onLoad={handlePreviewSuccess}
                      onError={handlePreviewError}
                    />
                  ) : null}
                  {isPdf(selectedEntry.mime) ? (
                    <iframe
                      key={previewUrl}
                      className="ResourceFrame"
                      src={previewUrl}
                      title={selectedEntry.name}
                      onLoad={handlePreviewSuccess}
                    />
                  ) : null}
                  {!isVideo(selectedEntry.mime) &&
                  !isAudio(selectedEntry.mime) &&
                  !isImage(selectedEntry.mime) &&
                  !isPdf(selectedEntry.mime) ? (
                    <div className="ServiceHint">
                      当前类型不做内嵌预览，可使用上方 HTTP 或 IPFS 按钮打开。
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
