import * as React from 'react';

type PublicPeerNode = {
  address: string;
  protocol?: string;
  ipVersion?: 'ipv4' | 'ipv6' | 'unknown';
  region?: string;
  status?: string;
  reliability?: string;
};

type AutoPeerConfig = {
  enabled?: boolean;
  targetPeerCount?: number;
  initialDelayMs?: number;
  reconcileIntervalMs?: number;
  sampleSize?: number;
  probeAttempts?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
};

type AutoPeerEvent = {
  at: number;
  level: 'info' | 'warn';
  message: string;
};

type AutoPeerProbeSnapshot = {
  uri: string;
  region: string;
  latencyMs: number | null;
  cost: number | null;
  uptimeSec: number | null;
  score: number;
  outcome: 'selected' | 'rejected' | 'failed';
};

type AutoPeerCycleSummary = {
  reason: string;
  startedAt: number;
  finishedAt: number;
  pinnedUpCount: number;
  desiredManagedCount: number;
  currentManagedCount: number;
  selectedManagedPeers: string[];
  addedPeers: string[];
  removedPeers: string[];
  connectedPublicPeers: string[];
  managedConnectedPeers: string[];
  probeSnapshots: AutoPeerProbeSnapshot[];
  error?: string;
};

type AutoPeerStatus = {
  running: boolean;
  enabled: boolean;
  cycleInFlight: boolean;
  nextRunAt: number | null;
  lastStartedAt: number | null;
  lastCycleAt: number | null;
  lastSuccessAt: number | null;
  lastReason: string | null;
  config: AutoPeerConfig;
  pinnedPeers: string[];
  connectedPublicPeers: string[];
  managedConnectedPeers: string[];
  selectedManagedPeers: string[];
  recentEvents: AutoPeerEvent[];
  lastCycleSummary: AutoPeerCycleSummary | null;
};

type YggConfig = {
  ifMtu: number;
  tcpOnly: boolean;
  p2pEnabled: boolean;
};

type DirectPeerMode = 'auto' | 'manual' | 'disabled';

const TARGET_PEER_OPTIONS = ['3', '4', '5', '6'] as const;

const normalizeAddr = (s: string): string => s.trim();
const normalizeField = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : '';

const formatDateTime = (value: number | null): string => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('zh-CN');
  } catch {
    return '—';
  }
};

const formatDurationMs = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${Math.round(value / 100) / 10} s`;
  return `${Math.round(value / 6000) / 10} min`;
};

const formatDurationSec = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 60) return `${Math.round(value)} s`;
  if (value < 3600) return `${Math.round((value / 60) * 10) / 10} min`;
  return `${Math.round((value / 3600) * 10) / 10} h`;
};

const clampNumber = (
  value: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const radioGroupStyle: React.CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'center',
  flexWrap: 'wrap',
};

const radioLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export default function YggdrasilPeersSettingsSection() {
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // direct peer mode
  const [directPeerMode, setDirectPeerMode] =
    React.useState<DirectPeerMode>('auto');

  // p2p + other config
  const [p2pEnabled, setP2pEnabled] = React.useState(true);
  const [ifMtu, setIfMtu] = React.useState('32768');
  const [tcpOnly, setTcpOnly] = React.useState(true);

  // peer candidates & selection
  const [candidates, setCandidates] = React.useState<PublicPeerNode[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [autoStatus, setAutoStatus] = React.useState<AutoPeerStatus | null>(
    null,
  );

  // auto config fields
  const [targetPeerCount, setTargetPeerCount] = React.useState('6');
  const [initialDelayMs, setInitialDelayMs] = React.useState('20000');
  const [reconcileIntervalMs, setReconcileIntervalMs] =
    React.useState('900000');
  const [probeIntervalMs, setProbeIntervalMs] = React.useState('1500');
  const [probeTimeoutMs, setProbeTimeoutMs] = React.useState('5000');

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      const [listRaw, selectionRaw, autoStatusRaw, yggCfg] = (await Promise.all(
        [
          window.electron.ipcRenderer.invoke('ygg:publicPeers:list'),
          window.electron.ipcRenderer.invoke('ygg:publicPeers:getSelection'),
          window.electron.ipcRenderer.invoke('ygg:autoPeer:getStatus'),
          window.electron.ipcRenderer.invoke('ygg:config:get'),
        ],
      )) as [unknown, unknown, unknown, YggConfig];

      const list: PublicPeerNode[] = Array.isArray(listRaw)
        ? (listRaw as any[])
            .filter(
              (x) =>
                x &&
                typeof x === 'object' &&
                typeof (x as any).address === 'string',
            )
            .map((x) => x as PublicPeerNode)
        : [];

      const candidateAddrSet = new Set(
        list
          .map((p) => normalizeAddr(String((p as any)?.address ?? '')))
          .filter((x) => !!x),
      );

      const selection: string[] = Array.isArray(selectionRaw)
        ? (selectionRaw as any[])
            .filter((x) => typeof x === 'string')
            .map((x) => normalizeAddr(x as string))
            .filter((x) => !!x)
        : [];

      const status =
        autoStatusRaw && typeof autoStatusRaw === 'object'
          ? (autoStatusRaw as AutoPeerStatus)
          : null;

      setCandidates(list);
      const persistedSelection = Array.from(new Set(selection));
      const normalizedSelection = persistedSelection.filter((x) =>
        candidateAddrSet.has(x),
      );

      // resolve direct peer mode from config
      let resolvedMode: DirectPeerMode = 'auto';
      if (status?.config?.enabled === false) {
        resolvedMode = persistedSelection.length > 0 ? 'manual' : 'disabled';
      }

      setSelected(normalizedSelection);
      setAutoStatus(status);
      setDirectPeerMode(resolvedMode);

      // apply auto config fields
      const cfg = status?.config;
      setTargetPeerCount(String(cfg?.targetPeerCount ?? 6));
      setInitialDelayMs(String(cfg?.initialDelayMs ?? 20000));
      setReconcileIntervalMs(String(cfg?.reconcileIntervalMs ?? 900000));
      setProbeIntervalMs(String(cfg?.probeIntervalMs ?? 1500));
      setProbeTimeoutMs(String(cfg?.probeTimeoutMs ?? 5000));

      // apply ygg config
      setIfMtu(String(yggCfg.ifMtu));
      setTcpOnly(yggCfg.tcpOnly);
      setP2pEnabled(yggCfg.p2pEnabled);

      if (!list.length) {
        setError(
          '未找到 public_peers.json（或内容为空）。请确认打包资源中包含 yggdrasil/public_peers.json。',
        );
      }
    } finally {
      // no-op
    }
  }, []);

  React.useEffect(() => {
    refresh().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [refresh]);

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);

  const toggle = (addr: string) => {
    const normalized = normalizeAddr(addr);
    if (!normalized) return;
    setSelected((prev) => {
      if (prev.includes(normalized)) {
        return prev.filter((x) => x !== normalized);
      }
      if (prev.length >= 10) return prev;
      return [...prev, normalized];
    });
  };

  const buildAutoConfigPayload = (): AutoPeerConfig => {
    const enabled = directPeerMode === 'auto';
    return {
      enabled,
      targetPeerCount: enabled ? clampNumber(targetPeerCount, 6, 3, 6) : 6,
      initialDelayMs: enabled
        ? clampNumber(initialDelayMs, 20000, 0, 600000)
        : 20000,
      reconcileIntervalMs: enabled
        ? clampNumber(reconcileIntervalMs, 900000, 10000, 86400000)
        : 900000,
      sampleSize: enabled
        ? Math.max(6, clampNumber(targetPeerCount, 6, 3, 6) * 2)
        : 12,
      probeAttempts: enabled
        ? Math.min(8, Math.max(4, clampNumber(targetPeerCount, 6, 3, 6) * 2))
        : 3,
      probeIntervalMs: enabled
        ? clampNumber(probeIntervalMs, 1500, 200, 30000)
        : 1500,
      probeTimeoutMs: enabled
        ? clampNumber(probeTimeoutMs, 5000, 500, 60000)
        : 5000,
    };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const mtu = Number(ifMtu);
      if (!Number.isFinite(mtu) || mtu < 1280 || mtu > 65535) {
        throw new Error('MTU 必须在 1280~65535 之间');
      }

      // 1. save auto peer config
      const autoPayload = buildAutoConfigPayload();
      await window.electron.ipcRenderer.invoke(
        'ygg:autoPeer:updateConfig',
        autoPayload,
      );

      // 2. save manual peer selection (if manually selected or disabled)
      if (directPeerMode !== 'auto') {
        if (
          directPeerMode === 'manual' &&
          (selected.length < 1 || selected.length > 10)
        ) {
          throw new Error('手动模式请选择 1~10 个 peer');
        }
        await window.electron.ipcRenderer.invoke(
          'ygg:publicPeers:setSelection',
          directPeerMode === 'disabled' ? [] : selected,
        );
      }

      // 3. save ygg config (p2pEnabled, ifMtu, tcpOnly)
      await window.electron.ipcRenderer.invoke('ygg:config:set', {
        ifMtu: mtu,
        tcpOnly,
        p2pEnabled,
      });

      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const renderCycleSummary = (summary: AutoPeerCycleSummary | null) => {
    if (!summary) return '—';
    const probeLines = summary.probeSnapshots.length
      ? summary.probeSnapshots
          .slice(0, 20)
          .map(
            (probe) =>
              `${probe.outcome.toUpperCase()} ${probe.region} ${probe.uri} latency=${formatDurationMs(probe.latencyMs)} cost=${probe.cost ?? '—'} uptime=${formatDurationSec(probe.uptimeSec)} score=${Math.round(probe.score)}`,
          )
          .join('\n')
      : '（本轮没有 probe 结果）';

    return [
      `reason=${summary.reason}`,
      `started=${formatDateTime(summary.startedAt)}`,
      `finished=${formatDateTime(summary.finishedAt)}`,
      `pinnedUp=${summary.pinnedUpCount}`,
      `desiredManaged=${summary.desiredManagedCount}`,
      `currentManaged=${summary.currentManagedCount}`,
      `selectedManaged=${summary.selectedManagedPeers.length ? summary.selectedManagedPeers.join('\n  ') : '—'}`,
      `added=${summary.addedPeers.length ? summary.addedPeers.join('\n  ') : '—'}`,
      `removed=${summary.removedPeers.length ? summary.removedPeers.join('\n  ') : '—'}`,
      `error=${summary.error || '—'}`,
      '',
      '[probe]',
      probeLines,
    ].join('\n');
  };

  const rows = React.useMemo(() => {
    return candidates
      .map((p) => {
        const addr = normalizeAddr(p.address);
        if (!addr) return null;
        return {
          addr,
          region: normalizeField(p.region) || '未知',
          protocol: normalizeField(p.protocol) || '-',
          ipVersion: normalizeField(p.ipVersion) || '-',
          status: normalizeField(p.status) || '-',
          reliability: normalizeField(p.reliability) || '-',
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => {
        const byRegion = a.region.localeCompare(b.region);
        if (byRegion !== 0) return byRegion;
        const byProtocol = a.protocol.localeCompare(b.protocol);
        if (byProtocol !== 0) return byProtocol;
        const byIp = a.ipVersion.localeCompare(b.ipVersion);
        if (byIp !== 0) return byIp;
        return a.addr.localeCompare(b.addr);
      });
  }, [candidates]);

  const groups = React.useMemo(
    () =>
      rows.reduce<Array<{ region: string; items: typeof rows }>>((out, row) => {
        const last = out[out.length - 1];
        if (!last || last.region !== row.region) {
          out.push({ region: row.region, items: [row] });
          return out;
        }
        last.items.push(row);
        return out;
      }, []),
    [rows],
  );

  const atMax = selected.length >= 10;
  const canSaveSelection = selected.length >= 1 && selected.length <= 10;
  const controlsDisabled = saving;

  let runningStatusLabel = '未运行';
  if (autoStatus?.cycleInFlight) {
    runningStatusLabel = '调度中';
  } else if (autoStatus?.running) {
    runningStatusLabel = '后台运行';
  }

  const directModeLabel =
    directPeerMode === 'auto'
      ? '自动调度'
      : directPeerMode === 'manual'
        ? '手动固定'
        : '已禁用';

  const sectionHeaderStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 8,
    paddingBottom: 4,
  };

  const sectionBoxStyle: React.CSSProperties = {
    border: '1px solid var(--border-color, #ddd)',
    borderRadius: 6,
    padding: 12,
    marginBottom: 16,
  };

  return (
    <div className="ChatTopPanel">
      <div className="ChatTopTitleRow">
        <div className="ChatTopTitle">Yggdrasil 设置</div>
        <div className="ChatTopActions">
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--text-hint, #000000)',
              marginRight: 8,
              display: 'inline-flex',
              alignItems: 'center',
              lineHeight: 1,
            }}
          >
            直连模式：{directModeLabel}
            {' | '}
            P2P：{p2pEnabled ? '启用' : '禁用'}
          </span>
          <button
            type="button"
            className="ServicePrimaryButton"
            onClick={save}
            disabled={
              saving || (directPeerMode === 'manual' && !canSaveSelection)
            }
            style={{ width: '120px' }}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>

      {error ? <div className="ServiceError">{error}</div> : null}

      <div className="ChatTopGrid">
        {/* ── 直连 Public Peer ── */}
        <div
          className="ChatTopItem ChatTopItemWide"
          style={{ ...sectionBoxStyle, padding: 12 }}
        >
          <div style={sectionHeaderStyle}>直连 Public Peer</div>
          <div style={radioGroupStyle}>
            <label style={radioLabelStyle}>
              <input
                type="radio"
                name="directPeerMode"
                checked={directPeerMode === 'auto'}
                onChange={() => setDirectPeerMode('auto')}
                disabled={controlsDisabled}
              />
              自动调度
            </label>
            <label style={radioLabelStyle}>
              <input
                type="radio"
                name="directPeerMode"
                checked={directPeerMode === 'manual'}
                onChange={() => setDirectPeerMode('manual')}
                disabled={controlsDisabled}
              />
              手动固定
            </label>
            <label style={radioLabelStyle}>
              <input
                type="radio"
                name="directPeerMode"
                checked={directPeerMode === 'disabled'}
                onChange={() => setDirectPeerMode('disabled')}
                disabled={controlsDisabled}
              />
              禁用
            </label>
          </div>

          {/* auto mode params */}
          {directPeerMode === 'auto' ? (
            <div style={{ marginTop: 8 }}>
              <div className="ChatStack">
                <label className="ChatStack" htmlFor="auto-target-peer-count">
                  <span className="ChatTopValue">目标总 peer 数</span>
                  <select
                    id="auto-target-peer-count"
                    className="ChatInput"
                    value={targetPeerCount}
                    onChange={(e) => setTargetPeerCount(e.target.value)}
                    disabled={controlsDisabled}
                    style={{ width: 80 }}
                  >
                    {TARGET_PEER_OPTIONS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="ChatTinyHint">
                  候选池规模和每个候选的采样次数会根据目标数量自动推导，大致按目标数量的
                  2 倍处理。
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 8,
                    marginTop: 8,
                  }}
                >
                  {[
                    {
                      label: '首次延迟 ms',
                      value: initialDelayMs,
                      setter: setInitialDelayMs,
                    },
                    {
                      label: '重平衡周期 ms',
                      value: reconcileIntervalMs,
                      setter: setReconcileIntervalMs,
                    },
                    {
                      label: '采样间隔 ms',
                      value: probeIntervalMs,
                      setter: setProbeIntervalMs,
                    },
                    {
                      label: '单步超时 ms',
                      value: probeTimeoutMs,
                      setter: setProbeTimeoutMs,
                    },
                  ].map(({ label, value, setter }) => {
                    const inputId = `auto-config-${label}`;
                    return (
                      <div key={label} className="ChatStack">
                        <label className="ChatTopValue" htmlFor={inputId}>
                          {label}
                        </label>
                        <input
                          id={inputId}
                          className="ChatInput"
                          value={value}
                          onChange={(e) => setter(e.target.value)}
                          inputMode="numeric"
                          disabled={controlsDisabled}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}

          {/* manual mode peer selection */}
          {directPeerMode === 'manual' ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 6 }}>
                <span className="ChatTopValue">
                  已选 {selected.length} / 10
                </span>
                {!canSaveSelection ? (
                  <span className="ChatTinyHint" style={{ marginLeft: 8 }}>
                    需选择 1 到 10 个节点
                  </span>
                ) : null}
              </div>
              <div className="StatusPre" style={{ maxHeight: '30vh' }}>
                {!candidates.length ? (
                  <div className="StatusEmpty">（暂无候选项）</div>
                ) : (
                  <table className="PeerSelectTable">
                    <thead>
                      <tr>
                        <th className="PeerSelectTh" scope="col">
                          勾选
                        </th>
                        <th className="PeerSelectTh" scope="col">
                          URI
                        </th>
                        <th className="PeerSelectTh" scope="col">
                          地区
                        </th>
                        <th className="PeerSelectTh" scope="col">
                          传输协议
                        </th>
                        <th className="PeerSelectTh" scope="col">
                          IP
                        </th>
                        <th className="PeerSelectTh" scope="col">
                          在线状态
                        </th>
                        <th className="PeerSelectTh" scope="col">
                          可靠度
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <React.Fragment key={g.region}>
                          <tr className="PeerSelectRegionRow">
                            <th
                              className="PeerSelectRegionCell"
                              colSpan={7}
                              scope="colgroup"
                            >
                              {g.region}
                            </th>
                          </tr>
                          {g.items.map((p) => {
                            const checked = selectedSet.has(p.addr);
                            const cbDisabled = !checked && atMax;
                            const inputId = `ygg-public-peer-${encodeURIComponent(p.addr)}`;
                            return (
                              <tr
                                key={p.addr}
                                className={
                                  checked
                                    ? 'PeerSelectRow isChecked'
                                    : 'PeerSelectRow'
                                }
                              >
                                <td className="PeerSelectTd PeerSelectTdCheck">
                                  <input
                                    id={inputId}
                                    type="checkbox"
                                    aria-label={`选择节点 ${p.addr}`}
                                    checked={checked}
                                    disabled={controlsDisabled || cbDisabled}
                                    onChange={() => toggle(p.addr)}
                                  />
                                </td>
                                <td className="PeerSelectTd PeerSelectTdAddr">
                                  <label
                                    className="PeerSelectAddrLabel"
                                    htmlFor={inputId}
                                  >
                                    {p.addr}
                                  </label>
                                </td>
                                <td className="PeerSelectTd">{p.region}</td>
                                <td className="PeerSelectTd">{p.protocol}</td>
                                <td className="PeerSelectTd">{p.ipVersion}</td>
                                <td className="PeerSelectTd">{p.status}</td>
                                <td className="PeerSelectTd">
                                  {p.reliability}
                                </td>
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="ChatTinyHint" style={{ marginTop: 4 }}>
                手动模式不会把 peer 写入 yggdrasil.conf。保存后，如果 Yggdrasil
                正在运行，会通过 addpeer/removepeer 同步运行态连接。
              </div>
            </div>
          ) : null}

          {/* disabled mode hint */}
          {directPeerMode === 'disabled' ? (
            <div className="ChatStack" style={{ marginTop: 8 }}>
              <div className="ChatTopValue">不会连接任何 public peer</div>
              <div className="ChatTinyHint">
                自动调度停止，手动 peer 列表清空；仅通过 P2P
                节点发现（如果启用）和局域网自动发现来连接其他节点。
              </div>
            </div>
          ) : null}
        </div>

        {/* ── P2P 节点发现 ── */}
        <div
          className="ChatTopItem ChatTopItemWide"
          style={{ ...sectionBoxStyle, padding: 12 }}
        >
          <div style={sectionHeaderStyle}>P2P 节点发现</div>
          <div style={radioGroupStyle}>
            <label style={radioLabelStyle}>
              <input
                type="radio"
                name="p2pEnabled"
                checked={p2pEnabled}
                onChange={() => setP2pEnabled(true)}
                disabled={controlsDisabled}
              />
              启用
            </label>
            <label style={radioLabelStyle}>
              <input
                type="radio"
                name="p2pEnabled"
                checked={!p2pEnabled}
                onChange={() => setP2pEnabled(false)}
                disabled={controlsDisabled}
              />
              禁用
            </label>
          </div>
          <div className="ChatTinyHint" style={{ marginTop: 4 }}>
            {p2pEnabled
              ? 'Yggdrasil 正常参与 P2P 网格，通过 DHT 等机制自动发现和连接其他节点。'
              : 'Yggdrasil 不启动 P2P 子系统，不会主动发现或连接其他 P2P 节点，只连接直连 Public Peer 或局域网发现节点。'}
          </div>
        </div>

        {/* ── 其他参数 ── */}
        <div
          className="ChatTopItem ChatTopItemWide"
          style={{ ...sectionBoxStyle, padding: 12 }}
        >
          <div style={sectionHeaderStyle}>其他参数</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 12,
            }}
          >
            <div className="ChatStack">
              <div className="ChatTopLabel">MTU</div>
              <input
                className="ChatInput"
                value={ifMtu}
                onChange={(e) => setIfMtu(e.target.value)}
                inputMode="numeric"
                placeholder="32768"
                disabled={controlsDisabled}
                style={{ width: 100 }}
              />
              <div className="ChatTinyHint">
                建议 1280~65535，默认 32768。重启 Yggdrasil 生效。
              </div>
            </div>
            <div className="ChatStack">
              <div className="ChatTopLabel">TCP only</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={tcpOnly}
                  onChange={(e) => setTcpOnly(e.target.checked)}
                  disabled={controlsDisabled}
                />
                <span>仅使用 TCP 传输（关闭 QUIC）</span>
              </label>
              <div className="ChatTinyHint">
                默认开启。关闭后 yggdrasil 会尝试使用 QUIC 传输。重启 Yggdrasil
                生效。
              </div>
            </div>
          </div>
        </div>

        {/* ── 状态信息 ── */}
        <div
          className="ChatTopItem ChatTopItemWide"
          style={{ padding: 0, border: 'none' }}
        >
          <div style={{ ...sectionHeaderStyle, marginTop: 4 }}>运行状态</div>
          <div className="ChatTopGrid" style={{ marginTop: 0 }}>
            <div className="ChatTopItem">
              <div className="ChatTopLabel">直连模式</div>
              <div className="ChatTopValue">{directModeLabel}</div>
            </div>
            <div className="ChatTopItem">
              <div className="ChatTopLabel">P2P 发现</div>
              <div className="ChatTopValue">{p2pEnabled ? '启用' : '禁用'}</div>
            </div>
            <div className="ChatTopItem">
              <div className="ChatTopLabel">运行状态</div>
              <div className="ChatTopValue">{runningStatusLabel}</div>
            </div>
            <div className="ChatTopItem">
              <div className="ChatTopLabel">手动固定 Peer</div>
              <div className="ChatTopValue">
                {directPeerMode === 'auto'
                  ? '自动模式下不启用'
                  : `${autoStatus?.pinnedPeers.length ?? selected.length}`}
              </div>
            </div>
            <div className="ChatTopItem">
              <div className="ChatTopLabel">动态目标数</div>
              <div className="ChatTopValue">
                {autoStatus?.config?.targetPeerCount ?? '—'}
              </div>
            </div>
            <div className="ChatTopItem">
              <div className="ChatTopLabel">当前 public 连接</div>
              <div className="ChatTopValue">
                {autoStatus?.connectedPublicPeers.length ?? 0}
              </div>
            </div>
            <div className="ChatTopItem">
              <div className="ChatTopLabel">当前动态连接</div>
              <div className="ChatTopValue">
                {autoStatus?.managedConnectedPeers.length ?? 0}
              </div>
            </div>
            <div className="ChatTopItem">
              <div className="ChatTopLabel">下一次调度</div>
              <div className="ChatTopValue">
                {formatDateTime(autoStatus?.nextRunAt ?? null)}
              </div>
            </div>
            <div className="ChatTopItem">
              <div className="ChatTopLabel">最近成功</div>
              <div className="ChatTopValue">
                {formatDateTime(autoStatus?.lastSuccessAt ?? null)}
              </div>
            </div>
          </div>

          <div
            className="ChatTopItem ChatTopItemWide"
            style={{ marginTop: 12 }}
          >
            <div className="ChatTopLabel">最近事件</div>
            <pre
              className="ChatListenPre"
              style={{ maxHeight: 120, marginTop: 4 }}
            >
              {(autoStatus?.recentEvents ?? [])
                .map(
                  (event) =>
                    `[${formatDateTime(event.at)}] ${event.level.toUpperCase()} ${event.message}`,
                )
                .join('\n') || '—'}
            </pre>
          </div>

          <div className="ChatTopItem ChatTopItemWide" style={{ marginTop: 8 }}>
            <div className="ChatTopLabel">最近一次调度摘要</div>
            <pre
              className="ChatListenPre"
              style={{ maxHeight: 200, marginTop: 4 }}
            >
              {renderCycleSummary(autoStatus?.lastCycleSummary ?? null)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
