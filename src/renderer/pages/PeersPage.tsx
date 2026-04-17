import * as React from 'react';
import { Link } from 'react-router-dom';

type YggdrasilCtlCommand = 'getpeersjson' | 'getp2ppeersjson';
type YggdrasilCtlResult = {
  ok: boolean;
  command: YggdrasilCtlCommand;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

type YggGetPeersItem = {
  remote?: string;
  up?: boolean;
  inbound?: boolean;
  address?: string;
  key?: string;
  port?: number;
  priority?: number;
  cost?: number;
  bytes_recvd?: number;
  bytes_sent?: number;
  uptime?: number;
  latency?: number;
  last_error?: string;
  last_error_time?: string;
};

type P2PPeerBase = {
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
};

type P2PSeenPeer = P2PPeerBase;

type P2PTransportPeer = P2PPeerBase & {
  remote_addrs?: string[];
};

type P2PYggPeer = P2PPeerBase & YggGetPeersItem;

type P2PGetPeersResult = {
  enabled?: boolean;
  local_peer_id?: string;
  rendezvous_tags?: string[];
  seen_peers?: P2PSeenPeer[];
  transport_peers?: P2PTransportPeer[];
  ygg_peers?: P2PYggPeer[];
  now?: string;
  note?: string;
};

function tryParseJson(input: string): unknown | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

const countFromYggCtlStdoutTranditionalPeer = (
  stdout: string,
): number | null => {
  const data = tryParseJson(stdout);
  if (data == null) return null;
  // data is object, use peers field of it
  const obj = data as Record<string, unknown>;
  const peers = obj.peers ?? obj.Peers;
  if (Array.isArray(peers)) {
    // count peers that are "up"; tolerate boolean, numeric and string representations
    const filterData = peers.filter(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'up' in item &&
        (item as Record<string, unknown>).up,
    );
    // console.log('Filtered peers with up=true:', filterData);
    return filterData.length;
  }
  return null;
};

function prettyStdout(stdout: string): string {
  const data = tryParseJson(stdout);
  if (data == null) return String(stdout ?? '');
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(stdout ?? '');
  }
}

function parseGetPeers(stdout: string): YggGetPeersItem[] | null {
  const data = tryParseJson(stdout);
  if (!data) return null;

  if (Array.isArray(data)) return data as YggGetPeersItem[];

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const peers = obj.peers ?? obj.Peers;
    if (Array.isArray(peers)) return peers as YggGetPeersItem[];
  }

  return null;
}

function parseP2PPeers(stdout: string): P2PGetPeersResult | null {
  const data = tryParseJson(stdout);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data as P2PGetPeersResult;
}

function countFromYggCtlStdoutP2PPeer(stdout: string): number | null {
  const data = parseP2PPeers(stdout);
  if (!data) return null;

  if (Array.isArray(data.ygg_peers)) return data.ygg_peers.length;
  if (Array.isArray(data.transport_peers)) return data.transport_peers.length;
  if (Array.isArray(data.seen_peers)) return data.seen_peers.length;

  return null;
}

function formatDurationSeconds(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  if (mins < 60) return `${mins}m ${sec}s`;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  return `${hours}h ${m}m`;
}

function formatLatency(latency: number | undefined): string {
  if (typeof latency !== 'number' || !Number.isFinite(latency)) return '—';
  // yggdrasilctl latency 常见是纳秒；这里做一个简单的启发式格式化
  if (latency >= 1_000_000) {
    const ms = latency / 1_000_000;
    return `${Math.round(ms)}ms`;
  }
  return `${Math.round(latency)}ns`;
}

function formatDirection(inbound: boolean | undefined): string {
  if (typeof inbound !== 'boolean') return '—';
  return inbound ? 'IN' : 'OUT';
}

function formatNumber(value: number | undefined): string | number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value;
}

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }

  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  let digits = 2;
  if (value >= 100) {
    digits = 0;
  } else if (value >= 10) {
    digits = 1;
  }

  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatPeerUri(uri: string | undefined): string {
  if (!uri) return '—';
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

function renderP2PIdentity(peer: P2PPeerBase) {
  return (
    <>
      <div style={{ wordBreak: 'break-all' }}>{peer.peer_id ?? '—'}</div>
      {peer.uri ? (
        <div
          style={{
            marginTop: 4,
            fontSize: 12,
            opacity: 0.72,
            wordBreak: 'break-all',
          }}
        >
          {formatPeerUri(peer.uri)}
        </div>
      ) : null}
    </>
  );
}

function StatusBadge({ res }: { res: YggdrasilCtlResult | null }) {
  if (!res) return <span className="StatusOk">等待</span>;
  if (res.ok) return <span className="StatusOk">OK</span>;
  return <span className="StatusBad">ERROR</span>;
}

export default function PeersPage({ embedded }: { embedded: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [peersRes, setPeersRes] = React.useState<YggdrasilCtlResult | null>(
    null,
  );
  const [p2pRes, setP2pRes] = React.useState<YggdrasilCtlResult | null>(null);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [peersRaw, p2pRaw] = await Promise.all([
        window.electron.ipcRenderer.invoke('yggdrasilctl:run', 'getpeersjson'),
        window.electron.ipcRenderer.invoke(
          'yggdrasilctl:run',
          'getp2ppeersjson',
        ),
      ]);
      setPeersRes(peersRaw as YggdrasilCtlResult);
      setP2pRes(p2pRaw as YggdrasilCtlResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPeersRes(null);
      setP2pRes(null);
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      refresh().catch(() => {
        // ignore
      });
    }, 20000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const peersCount = peersRes?.ok
    ? countFromYggCtlStdoutTranditionalPeer(peersRes.stdout)
    : null;
  const p2pCount = p2pRes?.ok
    ? countFromYggCtlStdoutP2PPeer(p2pRes.stdout)
    : null;

  const peersParsed = peersRes?.ok ? parseGetPeers(peersRes.stdout) : null;
  const p2pParsed = p2pRes?.ok ? parseP2PPeers(p2pRes.stdout) : null;
  const p2pEnabledText = React.useMemo(() => {
    const v = p2pParsed?.enabled;
    if (typeof v !== 'boolean') return '—';
    return v ? '是' : '否';
  }, [p2pParsed?.enabled]);
  const p2pCountsText = React.useMemo(() => {
    return `ygg_peers：${p2pParsed?.ygg_peers?.length ?? 0}`;
  }, [p2pParsed?.ygg_peers?.length]);

  const content = (
    <>
      <div className="StatusControls">
        <div className="StatusSummary">
          直连 Peer：{peersCount ?? '—'}，P2P Peer：{p2pCount ?? '—'}
          {busy ? '（刷新中…）' : ''}
        </div>
        <button
          type="button"
          className="ServiceGhostButton"
          onClick={refresh}
          disabled={busy}
        >
          {busy ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error ? <div className="ServiceError">{error}</div> : null}

      <div className="StatusBlocks">
        <div className="StatusBlock">
          <div className="StatusBlockHeader">
            <div className="StatusBlockTitle">
              getpeers <span className="StatusBlockDesc">- 当前直连 peers</span>
            </div>
            <StatusBadge res={peersRes} />
          </div>

          {peersRes ? (
            <div className="StatusMeta">
              <span>exit={peersRes.exitCode ?? '-'}</span>
              <span>耗时={peersRes.durationMs}ms</span>
            </div>
          ) : null}

          {peersRes && (peersRes.stderr ?? '').trim() ? (
            <div className="StatusIO">
              <div className="StatusBlockTitle">stderr</div>
              <pre className="StatusPre">{peersRes.stderr}</pre>
            </div>
          ) : null}

          {peersRes && (peersRes.stdout ?? '').trim() ? (
            <div className="StatusIO">
              <div className="StatusBlockTitle">stdout</div>
              {peersParsed && peersParsed.length ? (
                <div className="WebsiteIndexTableWrapper">
                  <table className="WebsiteIndexTable">
                    <thead>
                      <tr>
                        <th className="WebsiteIndexHeadCell">Up</th>
                        <th className="WebsiteIndexHeadCell">Remote</th>
                        <th className="WebsiteIndexHeadCell">Address</th>
                        <th className="WebsiteIndexHeadCell">Direction</th>
                        <th className="WebsiteIndexHeadCell">Cost</th>
                        <th className="WebsiteIndexHeadCell">Latency</th>
                        <th className="WebsiteIndexHeadCell">Uptime</th>
                        <th className="WebsiteIndexHeadCell">Received</th>
                        <th className="WebsiteIndexHeadCell">Sent</th>
                        <th className="WebsiteIndexHeadCell">Last Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {peersParsed
                        .slice()
                        .sort((a, b) => {
                          const au = a.up ? 1 : 0;
                          const bu = b.up ? 1 : 0;
                          return bu - au;
                        })
                        .map((p) => (
                          <tr
                            key={`peer:${p.remote ?? ''}|${p.key ?? ''}|${
                              p.address ?? ''
                            }|${p.port ?? ''}`}
                          >
                            <td className="WebsiteIndexCell">
                              {p.up ? '✅' : '❌'}
                            </td>
                            <td
                              className="WebsiteIndexCell"
                              style={{ wordBreak: 'break-all' }}
                            >
                              {p.remote ?? '—'}
                            </td>
                            <td
                              className="WebsiteIndexCell"
                              style={{ wordBreak: 'break-all' }}
                            >
                              {p.address ?? '—'}
                            </td>
                            <td className="WebsiteIndexCell">
                              {formatDirection(p.inbound)}
                            </td>
                            <td className="WebsiteIndexCell">
                              {typeof p.cost === 'number' ? p.cost : '—'}
                            </td>
                            <td className="WebsiteIndexCell">
                              {formatLatency(p.latency)}
                            </td>
                            <td className="WebsiteIndexCell">
                              {formatDurationSeconds(p.uptime)}
                            </td>
                            <td className="WebsiteIndexCell">
                              {formatBytes(p.bytes_recvd)}
                            </td>
                            <td className="WebsiteIndexCell">
                              {formatBytes(p.bytes_sent)}
                            </td>
                            <td
                              className="WebsiteIndexCell"
                              style={{ wordBreak: 'break-word' }}
                            >
                              {p.last_error ?? (p.up ? '—' : '')}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <pre className="StatusPre">{prettyStdout(peersRes.stdout)}</pre>
              )}
            </div>
          ) : (
            <div className="StatusEmpty">无输出</div>
          )}
        </div>

        <div className="StatusBlock" style={{ visibility: 'visible' }}>
          <div className="StatusBlockHeader">
            <div className="StatusBlockTitle">
              getp2ppeersjson{' '}
              <span className="StatusBlockDesc">- libp2p peers</span>
            </div>
            <StatusBadge res={p2pRes} />
          </div>

          {p2pRes ? (
            <div className="StatusMeta">
              <span>exit={p2pRes.exitCode ?? '-'}</span>
              <span>耗时={p2pRes.durationMs}ms</span>
            </div>
          ) : null}

          {p2pRes && (p2pRes.stderr ?? '').trim() ? (
            <div className="StatusIO">
              <div className="StatusBlockTitle">stderr</div>
              <pre className="StatusPre">{p2pRes.stderr}</pre>
            </div>
          ) : null}

          {p2pRes && (p2pRes.stdout ?? '').trim() ? (
            <div className="StatusIO">
              <div className="StatusBlockTitle">stdout</div>
              {p2pParsed ? (
                <>
                  <div className="ServiceHint" style={{ marginTop: 0 }}>
                    <div>
                      enabled：{p2pEnabledText}
                      {p2pParsed.local_peer_id
                        ? `，local_peer_id：${p2pParsed.local_peer_id}`
                        : ''}
                    </div>
                    <div style={{ marginTop: 6 }}>{p2pCountsText}</div>
                    {p2pParsed.rendezvous_tags &&
                    p2pParsed.rendezvous_tags.length ? (
                      <div style={{ marginTop: 6, wordBreak: 'break-all' }}>
                        rendezvous_tags：{p2pParsed.rendezvous_tags.join(' , ')}
                      </div>
                    ) : null}
                    {p2pParsed.note ? (
                      <div style={{ marginTop: 6 }}>{p2pParsed.note}</div>
                    ) : null}
                  </div>

                  {p2pParsed.ygg_peers && p2pParsed.ygg_peers.length ? (
                    <>
                      <div className="StatusBlockTitle">ygg_peers</div>
                      <div className="WebsiteIndexTableWrapper">
                        <table className="WebsiteIndexTable">
                          <thead>
                            <tr>
                              <th className="WebsiteIndexHeadCell">Peer</th>
                              {/* <th className="WebsiteIndexHeadCell">Up</th> */}
                              <th className="WebsiteIndexHeadCell">
                                Direction
                              </th>
                              <th className="WebsiteIndexHeadCell">Address</th>
                              <th className="WebsiteIndexHeadCell">Cost</th>
                              <th className="WebsiteIndexHeadCell">Latency</th>
                              <th className="WebsiteIndexHeadCell">Uptime</th>
                              <th className="WebsiteIndexHeadCell">Received</th>
                              <th className="WebsiteIndexHeadCell">Sent</th>
                              {/* <th className="WebsiteIndexHeadCell">Out</th>
                              <th className="WebsiteIndexHeadCell">
                                Ygg Active
                              </th> */}
                              {/* <th className="WebsiteIndexHeadCell">RV Seen</th>
                              <th className="WebsiteIndexHeadCell">
                                RV Connected
                              </th>
                              <th className="WebsiteIndexHeadCell">
                                Last Seen
                              </th>
                              <th className="WebsiteIndexHeadCell">
                                Last Connect
                              </th>
                              <th className="WebsiteIndexHeadCell">
                                Last Error
                              </th> */}
                            </tr>
                          </thead>
                          <tbody>
                            {p2pParsed.ygg_peers.map((p) => (
                              <tr key={`ygg:${p.peer_id ?? 'unknown'}`}>
                                <td className="WebsiteIndexCell">
                                  {renderP2PIdentity(p)}
                                </td>
                                {/* <td className="WebsiteIndexCell">
                                  {boolText(p.up)}
                                </td> */}
                                <td className="WebsiteIndexCell">
                                  {formatDirection(p.inbound)}
                                </td>
                                <td
                                  className="WebsiteIndexCell"
                                  style={{ wordBreak: 'break-all' }}
                                >
                                  {p.address ?? '—'}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {formatNumber(p.cost)}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {formatLatency(p.latency)}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {formatDurationSeconds(p.uptime)}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {formatBytes(p.bytes_recvd)}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {formatBytes(p.bytes_sent)}
                                </td>
                                {/* <td className="WebsiteIndexCell">
                                  {boolText(p.ygg_session_active)}
                                </td> */}
                                {/* <td className="WebsiteIndexCell">
                                  {boolText(p.rendezvous_seen)}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {boolText(p.rendezvous_connected)}
                                </td>
                                <td
                                  className="WebsiteIndexCell"
                                  style={{ wordBreak: 'break-all' }}
                                >
                                  {p.last_rendezvous_seen_at ?? '—'}
                                </td> */}
                                {/* <td
                                  className="WebsiteIndexCell"
                                  style={{ wordBreak: 'break-all' }}
                                >
                                  {p.last_rendezvous_connect_at ?? '—'}
                                </td>
                                <td
                                  className="WebsiteIndexCell"
                                  style={{ wordBreak: 'break-word' }}
                                >
                                  {p.last_error ?? p.last_error_time ?? '—'}
                                </td> */}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : null}
                </>
              ) : (
                <pre className="StatusPre">{prettyStdout(p2pRes.stdout)}</pre>
              )}
            </div>
          ) : (
            <div className="StatusEmpty">无输出</div>
          )}
        </div>
      </div>
    </>
  );

  if (embedded) {
    return <div className="PageBody">{content}</div>;
  }

  return (
    <div className="PageRoot">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">Peers 信息</div>
      </div>
      <div className="PageBody">{content}</div>
    </div>
  );
}
