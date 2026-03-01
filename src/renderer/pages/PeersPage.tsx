import * as React from 'react';
import { Link } from 'react-router-dom';

type YggdrasilCtlCommand = 'getpeersjson' | 'getp2ppeersjson';
const SHOW_TRANSPORTS_ADDRESS = false;
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
};

type P2PTransportPeer = {
  peer_id?: string;
  inbound_conns?: number;
  outbound_conns?: number;
  remote_addrs?: string[];
  ygg_session_active?: boolean;
  rendezvous_seen?: boolean;
  rendezvous_connected?: boolean;
  last_rendezvous_seen_at?: string;
  last_rendezvous_connect_at?: string;
};

type P2PGetPeersResult = {
  enabled?: boolean;
  local_peer_id?: string;
  rendezvous_tags?: string[];
  transport_peers?: P2PTransportPeer[];
  ygg_peers?: Array<
    Pick<
      P2PTransportPeer,
      | 'peer_id'
      | 'inbound_conns'
      | 'outbound_conns'
      | 'ygg_session_active'
      | 'rendezvous_seen'
      | 'rendezvous_connected'
      | 'last_rendezvous_seen_at'
      | 'last_rendezvous_connect_at'
    >
  >;
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

const countFromYggCtlStdoutP2PPeer = (stdout: string): number | null => {
  const data = tryParseJson(stdout);
  if (data == null) return null;
  // check if data has ygg_peers field and is an array
  if (
    typeof data === 'object' &&
    data !== null &&
    'ygg_peers' in data &&
    Array.isArray((data as Record<string, unknown>).ygg_peers)
  ) {
    return ((data as Record<string, unknown>).ygg_peers as unknown[]).length;
  }
  return null;
};

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

function boolText(v: boolean | undefined): string {
  if (typeof v !== 'boolean') return '—';
  return v ? '是' : '否';
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
    }, 5000);
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
                        <th className="WebsiteIndexHeadCell">Inbound</th>
                        <th className="WebsiteIndexHeadCell">Cost</th>
                        <th className="WebsiteIndexHeadCell">Latency</th>
                        <th className="WebsiteIndexHeadCell">Uptime</th>
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
                              {boolText(p.inbound)}
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

                  {p2pParsed.transport_peers &&
                  SHOW_TRANSPORTS_ADDRESS &&
                  p2pParsed.transport_peers.length ? (
                    <>
                      <div className="StatusBlockTitle">transport_peers</div>
                      <div className="WebsiteIndexTableWrapper">
                        <table className="WebsiteIndexTable">
                          <thead>
                            <tr>
                              <th className="WebsiteIndexHeadCell">Peer ID</th>
                              <th className="WebsiteIndexHeadCell">In</th>
                              <th className="WebsiteIndexHeadCell">Out</th>
                              <th className="WebsiteIndexHeadCell">
                                Remote Addrs
                              </th>
                              <th className="WebsiteIndexHeadCell">
                                Ygg Active
                              </th>
                              <th className="WebsiteIndexHeadCell">RV Seen</th>
                              <th className="WebsiteIndexHeadCell">
                                RV Connected
                              </th>
                              <th className="WebsiteIndexHeadCell">
                                Last Seen
                              </th>
                              <th className="WebsiteIndexHeadCell">
                                Last Connect
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {p2pParsed.transport_peers.map((p) => (
                              <tr
                                key={`p2p:${p.peer_id ?? ''}|${
                                  p.remote_addrs?.join('|') ?? ''
                                }`}
                              >
                                <td
                                  className="WebsiteIndexCell"
                                  style={{ wordBreak: 'break-all' }}
                                >
                                  {p.peer_id ?? '—'}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {typeof p.inbound_conns === 'number'
                                    ? p.inbound_conns
                                    : '—'}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {typeof p.outbound_conns === 'number'
                                    ? p.outbound_conns
                                    : '—'}
                                </td>
                                <td
                                  className="WebsiteIndexCell"
                                  style={{
                                    wordBreak: 'break-all',
                                    whiteSpace: 'pre-wrap',
                                  }}
                                >
                                  {p.remote_addrs?.length
                                    ? p.remote_addrs.join('\n')
                                    : '—'}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {boolText(p.ygg_session_active)}
                                </td>
                                <td className="WebsiteIndexCell">
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
                                </td>
                                <td
                                  className="WebsiteIndexCell"
                                  style={{ wordBreak: 'break-all' }}
                                >
                                  {p.last_rendezvous_connect_at ?? '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : null}

                  {p2pParsed.ygg_peers && p2pParsed.ygg_peers.length ? (
                    <>
                      <div className="StatusBlockTitle">ygg_peers</div>
                      <div className="WebsiteIndexTableWrapper">
                        <table className="WebsiteIndexTable">
                          <thead>
                            <tr>
                              <th className="WebsiteIndexHeadCell">Peer ID</th>
                              <th className="WebsiteIndexHeadCell">In</th>
                              <th className="WebsiteIndexHeadCell">Out</th>
                              <th className="WebsiteIndexHeadCell">
                                Ygg Active
                              </th>
                              <th className="WebsiteIndexHeadCell">RV Seen</th>
                              <th className="WebsiteIndexHeadCell">
                                RV Connected
                              </th>
                              <th className="WebsiteIndexHeadCell">
                                Last Seen
                              </th>
                              <th className="WebsiteIndexHeadCell">
                                Last Connect
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {p2pParsed.ygg_peers.map((p) => (
                              <tr key={`ygg:${p.peer_id ?? 'unknown'}`}>
                                <td
                                  className="WebsiteIndexCell"
                                  style={{ wordBreak: 'break-all' }}
                                >
                                  {p.peer_id ?? '—'}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {typeof p.inbound_conns === 'number'
                                    ? p.inbound_conns
                                    : '—'}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {typeof p.outbound_conns === 'number'
                                    ? p.outbound_conns
                                    : '—'}
                                </td>
                                <td className="WebsiteIndexCell">
                                  {boolText(p.ygg_session_active)}
                                </td>
                                <td className="WebsiteIndexCell">
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
                                </td>
                                <td
                                  className="WebsiteIndexCell"
                                  style={{ wordBreak: 'break-all' }}
                                >
                                  {p.last_rendezvous_connect_at ?? '—'}
                                </td>
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
