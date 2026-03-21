import * as React from 'react';
import { Link } from 'react-router-dom';

type IndexLoadResult =
  | {
      ok: true;
      verified: boolean;
      sourceUrl: string;
      data: unknown;
    }
  | {
      ok: false;
      error: string;
    };

type IndexItem = Record<string, unknown>;

const pickString = (v: unknown): string => (typeof v === 'string' ? v : '');
const pickNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const pickBoolean = (v: unknown): boolean | null =>
  typeof v === 'boolean' ? v : null;

const formatMaybeIsoUtc = (iso: string): string => {
  const s = (iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
};

const readGeneratedAt = (data: unknown): string => {
  if (!data || typeof data !== 'object') return '';
  const obj = data as Record<string, unknown>;
  return pickString(obj.generatedAt) || pickString(obj.generated_at);
};

const readIndexArray = (data: unknown): IndexItem[] => {
  if (Array.isArray(data)) {
    return data.filter((x) => x && typeof x === 'object') as IndexItem[];
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const rows = obj.rows ?? obj.items ?? obj.data ?? obj.list;
    if (Array.isArray(rows)) {
      return rows.filter((x) => x && typeof x === 'object') as IndexItem[];
    }
    // payloadJson 字段为 base64 字符串，自动解码
    if (typeof obj.payloadJson === 'string') {
      try {
        const payloadDecoded = JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(atob(obj.payloadJson), (c) => c.charCodeAt(0)),
          ),
        );
        obj.payloadDecoded = payloadDecoded;
      } catch {
        // ignore decode errors
      }
    }
  }
  return [];
};

const normalizeItem = (
  item: IndexItem,
  idx: number,
): {
  id: string;
  title: string;
  category: string;
  url: string;
  desc: string;
  notice: string;
  onlineText: string;
} => {
  const idRaw =
    item.id ??
    item.no ??
    item.num ??
    item.index ??
    item['编号'] ??
    item['序号'];
  const id =
    pickString(idRaw) ||
    (pickNumber(idRaw) != null ? String(idRaw) : String(idx + 1));

  const url =
    pickString(item.url) ||
    pickString(item.href) ||
    pickString(item.URL) ||
    pickString(item['地址']) ||
    pickString(item['链接']);

  const title =
    pickString(item.title) ||
    pickString(item.name) ||
    pickString(item.label) ||
    pickString(item['标题']) ||
    pickString(item['名称']);

  const category =
    pickString(item.category_name) ||
    pickString(item.category) ||
    pickString(item['分类']) ||
    pickString(item['类别']);

  const desc =
    pickString(item.desc) ||
    pickString(item.description) ||
    pickString(item['说明']) ||
    pickString(item['简介']) ||
    pickString(item['描述']);

  const notice =
    pickString(item.notice) ||
    pickString(item.announcement) ||
    pickString(item['公告']) ||
    pickString(item['通知']);

  const isOnline =
    pickBoolean(item.is_online) ??
    pickBoolean(item.isOnline) ??
    pickBoolean(item.online) ??
    pickBoolean(item['在线']);
  const lastChecked =
    pickString(item.last_checked_utc) ||
    pickString(item.lastCheckedUtc) ||
    pickString(item.last_checked) ||
    pickString(item['最后检查']);
  const onlineText =
    isOnline == null
      ? '—'
      : `${isOnline ? '在线' : '离线'}${lastChecked ? `（${formatMaybeIsoUtc(lastChecked)}）` : ''}`;

  return {
    id,
    title: title || url || '—',
    category: category || '—',
    url,
    desc,
    notice,
    onlineText,
  };
};

export default function YggWebsiteIndexPage() {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = React.useState<string>('');
  const [generatedAt, setGeneratedAt] = React.useState<string>('');
  const [verified, setVerified] = React.useState<boolean | null>(null);
  const [items, setItems] = React.useState<IndexItem[]>([]);
  const [query, setQuery] = React.useState('');
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  const openExternal = React.useCallback((url: string) => {
    if (!url.trim()) return;
    try {
      window.electron.ipcRenderer.invoke('open-external', url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const load = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const resRaw = (await window.electron.ipcRenderer.invoke(
        'ygg:index:load',
      )) as unknown;
      const res = resRaw as IndexLoadResult;
      if (!res || typeof res !== 'object') {
        throw new Error('索引返回格式异常');
      }
      if ('ok' in res && res.ok === true) {
        setSourceUrl(res.sourceUrl);
        setGeneratedAt(readGeneratedAt(res.data));
        setVerified(Boolean(res.verified));
        setItems(readIndexArray(res.data));
        return;
      }
      if ('ok' in res && res.ok === false && 'error' in res) {
        throw new Error(String((res as { error: unknown }).error));
      }
      throw new Error('索引返回格式异常');
    } catch (e) {
      setItems([]);
      setSourceUrl('');
      setGeneratedAt('');
      setVerified(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        if (searchInputRef.current) {
          searchInputRef.current.focus();
          searchInputRef.current.select();
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, []);

  return (
    <div className="PageRoot">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">功能网站索引</div>
      </div>

      <div className="PageBody" style={{ userSelect: 'text' }}>
        <div className="StatusControls">
          <div className="StatusSummary">
            {busy ? (
              '加载中…'
            ) : (
              <>
                {`共 ${items.length || 0} 条`}
                {generatedAt
                  ? `（更新时间：${formatMaybeIsoUtc(generatedAt)}）`
                  : ''}
                {sourceUrl ? `（${sourceUrl}）` : ''}
                {verified === false ? '（未验签）' : ''}
              </>
            )}
          </div>
          <button
            type="button"
            className="ServiceGhostButton"
            onClick={load}
            disabled={busy}
          >
            {busy ? '刷新中…' : '刷新'}
          </button>
        </div>

        <div className="WebsiteIndexSearchRow">
          <span className="WebsiteIndexSearchLabel">搜索：</span>
          <input
            ref={searchInputRef}
            type="text"
            className="WebsiteIndexSearchInput"
            placeholder="按 Ctrl+F 快速定位，支持在 # / 标题 / 分类 / URL / 说明 / 公告 中模糊匹配"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="ServiceGhostButton WebsiteIndexClearButton"
              onClick={() => setQuery('')}
            >
              清空
            </button>
          ) : null}
        </div>

        {error ? <div className="ServiceError">{error}</div> : null}

        {!busy && !error && items.length === 0 ? (
          <div className="StatusEmpty">暂无数据</div>
        ) : null}

        <div className="WebsiteIndexTableWrapper">
          <table className="WebsiteIndexTable">
            <thead>
              <tr>
                <th className="WebsiteIndexHeadCell WebsiteIndexId">#</th>
                <th className="WebsiteIndexHeadCell">标题</th>
                <th className="WebsiteIndexHeadCell">分类</th>
                <th className="WebsiteIndexHeadCell">URL</th>
                <th className="WebsiteIndexHeadCell">说明</th>
                <th className="WebsiteIndexHeadCell">状态</th>
                <th className="WebsiteIndexHeadCell">公告</th>
                <th className="WebsiteIndexHeadCell WebsiteIndexActions">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const n = normalizeItem(it, idx);
                const q = query.trim().toLowerCase();
                if (
                  q &&
                  ![n.id, n.title, n.category, n.url, n.desc, n.notice]
                    .join('\n')
                    .toLowerCase()
                    .includes(q)
                ) {
                  return null;
                }
                return (
                  <tr key={n.id}>
                    <td className="WebsiteIndexCell WebsiteIndexId">#{n.id}</td>
                    <td className="WebsiteIndexCell">{n.title || '—'}</td>
                    <td className="WebsiteIndexCell">{n.category || '—'}</td>
                    <td className="WebsiteIndexCell WebsiteIndexUrl">
                      <div className="WebsiteIndexUrlText">{n.url || '—'}</div>
                    </td>
                    <td className="WebsiteIndexCell WebsiteIndexDesc">
                      {n.desc || '—'}
                    </td>
                    <td className="WebsiteIndexCell">{n.onlineText}</td>
                    <td className="WebsiteIndexCell WebsiteIndexNotice">
                      {n.notice || '—'}
                    </td>
                    <td className="WebsiteIndexCell WebsiteIndexActions">
                      <button
                        type="button"
                        className="ServiceGhostButton"
                        onClick={() => openExternal(n.url)}
                        disabled={!n.url.trim()}
                      >
                        打开
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
