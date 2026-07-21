import * as React from 'react';
import { Link } from 'react-router-dom';
import './NetworkVisualizePage.css';
import type { YggdrasilCtlResult } from '../types/yggdrasilctl';

type RouteTableProbe = {
  rtt_ema?: number;
  loss_ema?: number;
  samples: number;
  successes: number;
  failures: number;
  updated_ago: number;
};

type RouteTableNextHop = {
  address: string;
  key: string;
  port: number;
  priority: number;
  cost: number;
  distance: number;
  latency: number;
  selected?: boolean;
  peer_probe?: RouteTableProbe;
};

type RouteTableEntry = {
  address: string;
  key: string;
  path: number[];
  sequence: number;
  self_distance: number;
  path_probe?: RouteTableProbe;
  next_hops: RouteTableNextHop[];
};

type RouteTableData = {
  summary: {
    routing_entries: number;
    path_entries: number;
    route_table_entries: number;
  };
  entries: RouteTableEntry[];
};

type SelfData = {
  build_name?: string;
  build_version?: string;
  key?: string;
  address?: string;
  routing_entries?: number;
  subnet?: string;
};

type YggPeerItem = {
  remote?: string;
  up?: boolean;
  inbound?: boolean;
  address?: string;
  key?: string;
  port?: number;
  cost?: number;
  bytes_recvd?: number;
  bytes_sent?: number;
  uptime?: number;
  latency?: number;
};

type P2PPeer = {
  peer_id?: string;
  uri?: string;
  up?: boolean;
  inbound?: boolean;
  inbound_conns?: number;
  outbound_conns?: number;
  ygg_session_active?: boolean;
  rendezvous_seen?: boolean;
  rendezvous_connected?: boolean;
  last_rendezvous_seen_at?: string;
  last_rendezvous_connect_at?: string;
  remote_addrs?: string[];
  address?: string;
  key?: string;
  port?: number;
  cost?: number;
  bytes_recvd?: number;
  bytes_sent?: number;
  uptime?: number;
  latency?: number;
};

type P2PData = {
  enabled?: boolean;
  local_peer_id?: string;
  rendezvous_tags?: string[];
  seen_peers?: P2PPeer[];
  transport_peers?: P2PPeer[];
  ygg_peers?: P2PPeer[];
  now?: string;
  note?: string;
};

const REFRESH_INTERVAL_MS = 15000;

function tryParseJson(input: string): unknown | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function decodeSafe(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function formatNs(ns: number | undefined): string {
  if (typeof ns !== 'number' || !Number.isFinite(ns) || ns <= 0) return '-';
  if (ns < 1e3) return `${ns}ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(1)}us`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(1)}ms`;
  if (ns < 60e9) return `${(ns / 1e9).toFixed(2)}s`;
  return `${(ns / 60e9).toFixed(1)}m`;
}

function formatSeconds(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return '-';
  if (value < 60) return `${value.toFixed(1)}s`;
  if (value < 3600) return `${(value / 60).toFixed(1)}m`;
  return `${(value / 3600).toFixed(1)}h`;
}

function formatNumber(value: number | undefined): string | number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function esc(input: unknown): string {
  return String(input ?? '');
}

function renderBadge(
  text: string,
  tone: 'ok' | 'warn' | 'off',
): React.ReactNode {
  return <span className={`nv-badge ${tone}`}>{esc(text)}</span>;
}

function renderProbe(probe: RouteTableProbe | undefined): string {
  if (!probe) return '-';
  return [
    probe.rtt_ema != null ? `RTT ${formatNs(probe.rtt_ema)}` : null,
    probe.loss_ema != null ? `loss ${Number(probe.loss_ema).toFixed(3)}` : null,
    `ok ${formatNumber(probe.successes)}`,
    `fail ${formatNumber(probe.failures)}`,
    `age ${formatNs(probe.updated_ago)}`,
  ]
    .filter(Boolean)
    .join(' | ');
}

function renderPeerProbe(probe: RouteTableProbe | undefined): string {
  if (!probe) return '-';
  return [
    probe.rtt_ema != null ? `RTT ${formatNs(probe.rtt_ema)}` : null,
    probe.loss_ema != null ? `loss ${Number(probe.loss_ema).toFixed(3)}` : null,
    `ok ${formatNumber(probe.successes)}`,
    `fail ${formatNumber(probe.failures)}`,
  ]
    .filter(Boolean)
    .join(' | ');
}

function renderSummaryCard(
  label: string,
  value: string,
  meta?: string,
): React.ReactNode {
  return (
    <article className="nv-summary-card">
      <p className="nv-label">{esc(label)}</p>
      <p className="nv-value">{esc(value)}</p>
      {meta ? <p className="nv-meta">{esc(meta)}</p> : null}
    </article>
  );
}

function SummaryCards({
  self,
  peers,
  routes,
  p2p,
  routeFilter,
}: {
  self: SelfData | null;
  peers: YggPeerItem[] | null;
  routes: RouteTableData | null;
  p2p: P2PData | null;
  routeFilter: string;
}) {
  const upPeers = (peers ?? []).filter((p) => p.up).length;
  const filteredRoutes =
    routes?.entries?.filter(
      (e) =>
        !routeFilter ||
        e.address.includes(routeFilter) ||
        e.key.includes(routeFilter),
    ) ?? [];

  return (
    <div className="nv-summary-grid">
      {renderSummaryCard('本机', self?.address ?? '-', self?.subnet ?? '-')}
      {renderSummaryCard(
        '路由条目',
        String(formatNumber(routes?.summary?.routing_entries ?? 0)),
        `table ${formatNumber(routes?.summary?.route_table_entries ?? 0)}`,
      )}
      {renderSummaryCard(
        '直连 Peer',
        String(formatNumber(peers?.length ?? 0)),
        `${upPeers} up`,
      )}
      {renderSummaryCard(
        '过滤路由',
        String(formatNumber(filteredRoutes.length)),
        routeFilter || 'all',
      )}
      {renderSummaryCard(
        'Seen P2P',
        String(formatNumber(p2p?.seen_peers?.length ?? 0)),
        (p2p?.local_peer_id ?? '-').slice(0, 12) + '…',
      )}
      {renderSummaryCard(
        'P2P Ygg',
        String(formatNumber(p2p?.ygg_peers?.length ?? 0)),
        `${formatNumber(p2p?.transport_peers?.length ?? 0)} transport`,
      )}
    </div>
  );
}

function SelfInfo({ self }: { self: SelfData | null }) {
  if (!self) {
    return <div className="nv-empty">getself 没有返回数据。</div>;
  }
  const kv = (k: string, v: React.ReactNode): React.ReactNode => (
    <article className="nv-kv-card" key={k}>
      <p className="nv-kv-label">{k}</p>
      <p className="nv-kv-value">{v}</p>
    </article>
  );

  return (
    <div className="nv-self-grid">
      {kv('Address', esc(self.address))}
      {kv('Subnet', esc(self.subnet))}
      {kv('Public Key', esc(self.key))}
      {kv('路由条目', formatNumber(self.routing_entries))}
      {kv(
        'Build',
        `${esc(self.build_name ?? 'unknown')} / ${esc(
          self.build_version ?? 'unknown',
        )}`,
      )}
    </div>
  );
}

function RouteCardList({
  entries,
  keyToUri,
}: {
  entries: RouteTableEntry[];
  keyToUri: Map<string, string>;
}) {
  if (!entries.length) {
    return <div className="nv-empty">没有路由表条目。</div>;
  }
  return (
    <div className="nv-route-list">
      {entries.map((entry, i) => {
        const pathProbeChip = entry.path_probe ? (
          <span className="nv-chip">
            path probe {renderProbe(entry.path_probe)}
          </span>
        ) : (
          <span className="nv-chip">path probe -</span>
        );
        return (
          <article className="nv-route-card" key={entry.address + i}>
            <div className="nv-route-header">
              <div>
                <div className="nv-route-address">{esc(entry.address)}</div>
                <div className="nv-route-key">{esc(entry.key)}</div>
                <div className="nv-route-meta">
                  <span className="nv-chip">
                    seq {formatNumber(entry.sequence)}
                  </span>
                  <span className="nv-chip">
                    self dist {formatNumber(entry.self_distance)}
                  </span>
                  {pathProbeChip}
                </div>
              </div>
            </div>
            <div className="nv-path-string">
              path {(entry.path ?? []).join(' → ')}
            </div>
            <div className="nv-next-hop-grid">
              {entry.next_hops.map((hop) => (
                <div
                  className={`nv-next-hop${hop.selected ? ' selected' : ''}`}
                  key={hop.key + hop.port}
                >
                  <h4>{esc(hop.address || hop.key)}</h4>
                  {/* key 不显示
                  <div className="nv-muted">{esc(hop.key)}</div>
                  */}
                  {(() => {
                    const uri = keyToUri.get(hop.key);
                    return uri ? (
                      <div className="nv-muted">{decodeSafe(uri)}</div>
                    ) : null;
                  })()}
                  <dl>
                    <dt>Port</dt>
                    <dd>{formatNumber(hop.port)}</dd>
                    <dt>Priority</dt>
                    <dd>{formatNumber(hop.priority)}</dd>
                    <dt>Cost</dt>
                    <dd>{formatNumber(hop.cost)}</dd>
                    <dt>Distance</dt>
                    <dd>{formatNumber(hop.distance)}</dd>
                    <dt>Link RTT</dt>
                    <dd>{formatNs(hop.latency)}</dd>
                  </dl>
                  <div className="nv-next-hop-probe">
                    <span className="nv-probe-label">Peer probe</span>
                    <span>{renderPeerProbe(hop.peer_probe)}</span>
                  </div>
                </div>
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function DirectPeersTable({ peers }: { peers: YggPeerItem[] | null }) {
  if (!peers || !peers.length) {
    return <div className="nv-empty">没有直连 Yggdrasil peers。</div>;
  }
  return (
    <div className="nv-table-wrap">
      <table className="nv-table">
        <thead>
          <tr>
            <th>State</th>
            <th>Address</th>
            <th>Key</th>
            <th>Port</th>
            <th>Cost</th>
            <th>Latency</th>
            <th>Uptime</th>
            <th>URI</th>
          </tr>
        </thead>
        <tbody>
          {peers.map((peer, i) => (
            <tr key={peer.key ?? i}>
              <td>
                {peer.up
                  ? renderBadge('up', 'ok')
                  : renderBadge('down', 'warn')}
              </td>
              <td className="mono">{esc(peer.address)}</td>
              <td className="mono">{esc(peer.key)}</td>
              <td>{formatNumber(peer.port)}</td>
              <td>{formatNumber(peer.cost)}</td>
              <td>{formatNs(peer.latency)}</td>
              <td>{formatSeconds(peer.uptime)}</td>
              <td className="mono">{esc(peer.remote)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function P2PState({ p2p }: { p2p: P2PData | null }) {
  if (!p2p) {
    return <div className="nv-empty">getp2ppeers 没有返回数据。</div>;
  }

  const mapRows = (items: P2PPeer[] | undefined) =>
    (items ?? []).map((peer, i) => ({
      peer_id: esc(peer.peer_id),
      uri: esc(peer.uri ? decodeSafe(String(peer.uri)) : undefined),
      ygg: peer.ygg_session_active
        ? renderBadge('活跃', 'ok')
        : renderBadge('等待', 'off'),
      io: `${formatNumber(peer.inbound_conns)} / ${formatNumber(peer.outbound_conns)}`,
      address: esc(peer.address),
      remote_addrs: esc((peer.remote_addrs ?? []).join(' ')),
      seen: esc(formatTimestamp(peer.last_rendezvous_seen_at)),
      connected: esc(formatTimestamp(peer.last_rendezvous_connect_at)),
      _key: peer.peer_id ?? `row-${i}`,
    }));

  const renderPeerTable = (items: P2PPeer[] | undefined, emptyText: string) => {
    const rows = mapRows(items);
    if (!rows.length) {
      return <div className="nv-empty">{emptyText}</div>;
    }
    return (
      <div className="nv-table-wrap">
        <table className="nv-table">
          <thead>
            <tr>
              <th>Peer ID</th>
              <th>URI</th>
              <th>Ygg</th>
              <th>In / Out</th>
              <th>Address</th>
              <th>Remote Addrs</th>
              <th>Last Seen</th>
              <th>Last Conn</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row._key}>
                <td className="mono">{row.peer_id}</td>
                <td className="mono">{row.uri}</td>
                <td>{row.ygg}</td>
                <td>{row.io}</td>
                <td className="mono">{row.address}</td>
                <td className="mono">{row.remote_addrs}</td>
                <td>{row.seen}</td>
                <td>{row.connected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <>
      <div className="nv-p2p-grid">
        <details className="nv-p2p-details">
          <summary>
            Seen Peers
            <span className="nv-p2p-count">
              {formatNumber(p2p.seen_peers?.length ?? 0)} 个
            </span>
          </summary>
          <div className="nv-p2p-body">
            {renderPeerTable(p2p.seen_peers, '没有 seen peers。')}
          </div>
        </details>
        <details className="nv-p2p-details">
          <summary>
            Transport Peers
            <span className="nv-p2p-count">
              {formatNumber(p2p.transport_peers?.length ?? 0)} 个
            </span>
          </summary>
          <div className="nv-p2p-body">
            {renderPeerTable(p2p.transport_peers, '没有 transport peers。')}
          </div>
        </details>
        <details className="nv-p2p-details">
          <summary>
            P2P Ygg Peers
            <span className="nv-p2p-count">
              {formatNumber(p2p.ygg_peers?.length ?? 0)} 个
            </span>
          </summary>
          <div className="nv-p2p-body">
            {renderPeerTable(p2p.ygg_peers, '没有 p2p ygg peers。')}
          </div>
        </details>
      </div>
      {p2p.note ? (
        <div className="nv-section-hint" style={{ marginTop: 12 }}>
          {esc(p2p.note)}
        </div>
      ) : null}
    </>
  );
}

function RawJsonSection({
  results,
}: {
  results: Record<string, YggdrasilCtlResult | null>;
}) {
  const entries = Object.entries(results).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    <div>
      {entries.map(([cmd, result]) => (
        <details className="nv-details" key={cmd}>
          <summary>
            {cmd} {result && !result.ok ? '(error)' : ''}
          </summary>
          <pre>
            {result
              ? (() => {
                  const data = tryParseJson(result.stdout);
                  try {
                    return JSON.stringify(data ?? result.stdout, null, 2);
                  } catch {
                    return String(result.stdout ?? '');
                  }
                })()
              : '—'}
          </pre>
        </details>
      ))}
    </div>
  );
}

export default function NetworkVisualizePage() {
  const [self, setSelf] = React.useState<SelfData | null>(null);
  const [peers, setPeers] = React.useState<YggPeerItem[] | null>(null);
  const [p2p, setP2p] = React.useState<P2PData | null>(null);
  const [routes, setRoutes] = React.useState<RouteTableData | null>(null);
  const [allResults, setAllResults] = React.useState<
    Record<string, YggdrasilCtlResult | null>
  >({});

  const keyToUriRef = React.useRef<Map<string, string>>(new Map());

  const [routeFilter, setRouteFilter] = React.useState('');
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = React.useState<string | null>(null);

  const runIdRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setBusy(true);
    setError(null);

    const commands = [
      'getselfjson',
      'getpeersjson',
      'getp2ppeersjson',
      'getRouteTable',
    ] as const;

    const results: Record<string, YggdrasilCtlResult | null> = {};

    try {
      const settled = await Promise.allSettled(
        commands.map(async (cmd) => {
          const res = (await window.electron.ipcRenderer.invoke(
            'yggdrasilctl:run',
            cmd,
          )) as YggdrasilCtlResult;
          return { cmd, res };
        }),
      );

      const errors: string[] = [];

      for (const s of settled) {
        if (s.status === 'rejected') {
          errors.push(String(s.reason));
          continue;
        }
        const { cmd, res } = s.value;
        results[cmd] = res;
        if (!res.ok) {
          errors.push(`${cmd}: ${res.stderr || 'unknown error'}`);
        }
      }

      if (runIdRef.current !== runId) return;

      if (errors.length && commands.every((c) => !results[c]?.ok)) {
        setError(errors.join(' | '));
      } else if (errors.length) {
        setError(errors.join(' | '));
      }

      const selfRes = results['getselfjson'];
      if (selfRes?.ok) {
        const data = tryParseJson(selfRes.stdout);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          setSelf(data as SelfData);
        }
      }

      const peersRes = results['getpeersjson'];
      if (peersRes?.ok) {
        const data = tryParseJson(peersRes.stdout);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const obj = data as Record<string, unknown>;
          const peersArr = obj.peers ?? obj.Peers;
          if (Array.isArray(peersArr)) {
            setPeers(peersArr as YggPeerItem[]);
          }
        }
      } else {
        setPeers(null);
      }

      const p2pRes = results['getp2ppeersjson'];
      if (p2pRes?.ok) {
        const data = tryParseJson(p2pRes.stdout);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          setP2p(data as P2PData);
        }
      } else {
        setP2p(null);
      }

      const keyToUri = new Map<string, string>();
      {
        const peersRes = results['getpeersjson'];
        if (peersRes?.ok) {
          const data = tryParseJson(peersRes.stdout);
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            const obj = data as Record<string, unknown>;
            const arr = obj.peers ?? obj.Peers;
            if (Array.isArray(arr)) {
              for (const p of arr) {
                if (p && typeof p === 'object') {
                  const pi = p as Record<string, unknown>;
                  if (pi.key && pi.remote) {
                    keyToUri.set(String(pi.key), decodeSafe(String(pi.remote)));
                  }
                }
              }
            }
          }
        }
      }
      {
        const p2pRes = results['getp2ppeersjson'];
        if (p2pRes?.ok) {
          const data = tryParseJson(p2pRes.stdout);
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            const obj = data as Record<string, unknown>;
            const yggPeers = obj.ygg_peers;
            if (Array.isArray(yggPeers)) {
              for (const p of yggPeers) {
                if (p && typeof p === 'object') {
                  const pi = p as Record<string, unknown>;
                  if (pi.key && pi.uri) {
                    keyToUri.set(String(pi.key), decodeSafe(String(pi.uri)));
                  }
                }
              }
            }
          }
        }
      }
      keyToUriRef.current = keyToUri;

      const routeRes = results['getRouteTable'];
      if (routeRes?.ok) {
        const data = tryParseJson(routeRes.stdout);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          setRoutes(data as RouteTableData);
        }
      } else {
        setRoutes(null);
      }

      setAllResults(results);
      setLastRefresh(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } catch (e) {
      if (runIdRef.current === runId) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (runIdRef.current === runId) {
        setBusy(false);
      }
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = window.setInterval(() => {
      refresh().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, refresh]);

  React.useEffect(() => {
    const handleFind = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        document.body.focus();
        const win = window as Window & {
          find?: (
            text?: string,
            caseSensitive?: boolean,
            backwards?: boolean,
            wrap?: boolean,
            wholeWord?: boolean,
            searchInFrames?: boolean,
            showDialog?: boolean,
          ) => boolean;
        };
        if (win.find) {
          win.find(undefined, false, false, true, false, true, true);
        }
      }
    };
    window.addEventListener('keydown', handleFind);
    return () => window.removeEventListener('keydown', handleFind);
  }, []);

  const handleFilterKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        refresh();
      }
    },
    [refresh],
  );

  const filteredEntries = React.useMemo(() => {
    if (!routes?.entries) return [];
    if (!routeFilter) return routes.entries;
    return routes.entries.filter(
      (e) => e.address.includes(routeFilter) || e.key.includes(routeFilter),
    );
  }, [routes, routeFilter]);

  return (
    <div className="PageRoot nv-page">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">Yggdrasil Route 表</div>
      </div>

      <div className="PageBody">
        <div className="nv-controls">
          <input
            type="text"
            placeholder="地址或公钥前缀过滤路由..."
            value={routeFilter}
            onChange={(e) => setRouteFilter(e.target.value)}
            onKeyDown={handleFilterKeyDown}
          />
          <button
            type="button"
            className="nv-btn"
            onClick={refresh}
            disabled={busy}
          >
            {busy ? '刷新中…' : '立即刷新'}
          </button>
          <label className="nv-toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span>自动刷新</span>
          </label>
          <span className="nv-status-line">
            {lastRefresh ? `上次刷新 ${lastRefresh}` : '等待首次快照…'}
          </span>
        </div>

        {error ? <div className="nv-error">{error}</div> : null}

        <SummaryCards
          self={self}
          peers={peers}
          routes={routes}
          p2p={p2p}
          routeFilter={routeFilter}
        />

        <div className="nv-section">
          <div className="nv-section-title">本机信息</div>
          <SelfInfo self={self} />
        </div>

        <div className="nv-section">
          <div className="nv-section-title">路由表</div>
          {routes?.summary ? (
            <div className="nv-section-hint">
              共 {formatNumber(routes.summary.routing_entries)} 条路由条目，
              路径 {formatNumber(routes.summary.path_entries)} 条， 路由表{' '}
              {formatNumber(routes.summary.route_table_entries)} 条
              {routeFilter ? `（过滤后显示 ${filteredEntries.length} 条）` : ''}
            </div>
          ) : null}
          <RouteCardList
            entries={filteredEntries}
            keyToUri={keyToUriRef.current}
          />
        </div>

        <div className="nv-section">
          <div className="nv-section-title">直连 Peers</div>
          <DirectPeersTable peers={peers} />
        </div>

        <div className="nv-section">
          <div className="nv-section-title">P2P 状态</div>
          <P2PState p2p={p2p} />
        </div>

        <div className="nv-section">
          <div className="nv-section-title">原始数据</div>
          <RawJsonSection results={allResults} />
        </div>
      </div>
    </div>
  );
}
