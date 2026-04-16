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

type AutoConfigField = {
  label: string;
  value: string;
  setter: React.Dispatch<React.SetStateAction<string>>;
};

type PeerMode = 'auto' | 'manual' | 'p2p';

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

export default function YggdrasilPeersSettingsSection() {
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [candidates, setCandidates] = React.useState<PublicPeerNode[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [mode, setMode] = React.useState<PeerMode>('auto');
  const [autoStatus, setAutoStatus] = React.useState<AutoPeerStatus | null>(
    null,
  );

  const [targetPeerCount, setTargetPeerCount] = React.useState('6');
  const [initialDelayMs, setInitialDelayMs] = React.useState('20000');
  const [reconcileIntervalMs, setReconcileIntervalMs] =
    React.useState('900000');
  const [probeIntervalMs, setProbeIntervalMs] = React.useState('1500');
  const [probeTimeoutMs, setProbeTimeoutMs] = React.useState('5000');

  const autoConfigFields: AutoConfigField[] = [
    { label: '首次延迟 ms', value: initialDelayMs, setter: setInitialDelayMs },
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
    { label: '单步超时 ms', value: probeTimeoutMs, setter: setProbeTimeoutMs },
  ];

  const applyConfigToForm = React.useCallback(
    (cfg: AutoPeerConfig | undefined) => {
      setTargetPeerCount(String(cfg?.targetPeerCount ?? 6));
      setInitialDelayMs(String(cfg?.initialDelayMs ?? 20000));
      setReconcileIntervalMs(String(cfg?.reconcileIntervalMs ?? 900000));
      setProbeIntervalMs(String(cfg?.probeIntervalMs ?? 1500));
      setProbeTimeoutMs(String(cfg?.probeTimeoutMs ?? 5000));
    },
    [],
  );

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      const [listRaw, selectionRaw, autoStatusRaw] = (await Promise.all([
        window.electron.ipcRenderer.invoke('ygg:publicPeers:list'),
        window.electron.ipcRenderer.invoke('ygg:publicPeers:getSelection'),
        window.electron.ipcRenderer.invoke('ygg:autoPeer:getStatus'),
      ])) as [unknown, unknown, unknown];

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
      let resolvedMode: PeerMode = 'auto';
      if (status?.config?.enabled === false) {
        resolvedMode = persistedSelection.length > 0 ? 'manual' : 'p2p';
      }

      setSelected(normalizedSelection);
      setAutoStatus(status);
      applyConfigToForm(status?.config);
      setMode(resolvedMode);

      if (!list.length) {
        setError(
          '未找到 public_peers.json（或内容为空）。请确认打包资源中包含 yggdrasil/public_peers.json。',
        );
      }
    } finally {
      // no-op
    }
  }, [applyConfigToForm]);

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
    return {
      enabled: mode === 'auto',
      targetPeerCount: clampNumber(targetPeerCount, 6, 3, 6),
      initialDelayMs: clampNumber(initialDelayMs, 20000, 0, 600000),
      reconcileIntervalMs: clampNumber(
        reconcileIntervalMs,
        900000,
        10000,
        86400000,
      ),
      sampleSize: Math.max(6, clampNumber(targetPeerCount, 6, 3, 6) * 2),
      probeAttempts: Math.min(
        8,
        Math.max(4, clampNumber(targetPeerCount, 6, 3, 6) * 2),
      ),
      probeIntervalMs: clampNumber(probeIntervalMs, 1500, 200, 30000),
      probeTimeoutMs: clampNumber(probeTimeoutMs, 5000, 500, 60000),
    };
  };

  const saveCurrentMode = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = buildAutoConfigPayload();
      const configResult = (await window.electron.ipcRenderer.invoke(
        'ygg:autoPeer:updateConfig',
        payload,
      )) as { status?: AutoPeerStatus };

      if (configResult?.status) {
        setAutoStatus(configResult.status);
        applyConfigToForm(configResult.status.config);
      }

      if (mode !== 'auto') {
        if (
          mode === 'manual' &&
          (selected.length < 1 || selected.length > 10)
        ) {
          throw new Error('手动模式请选择 1~10 个 peer');
        }
        await window.electron.ipcRenderer.invoke(
          'ygg:publicPeers:setSelection',
          mode === 'p2p' ? [] : selected,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }

    refresh().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
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
  const autoPageActive = mode === 'auto';
  const manualPageActive = mode === 'manual';
  const p2pPageActive = mode === 'p2p';
  const canSaveSelection = selected.length >= 1 && selected.length <= 10;
  let saveButtonLabel = '保存纯 P2P 模式';
  if (mode === 'auto') {
    saveButtonLabel = '保存自动模式';
  } else if (mode === 'manual') {
    saveButtonLabel = '保存手动模式';
  }
  const manualSelectionHint =
    manualPageActive && !canSaveSelection ? '需选择 1 到 10 个节点' : null;
  const controlsDisabled = saving;
  let runningStatusLabel = '未运行';
  let currentModeLabel = '纯 P2P 模式';
  if (mode === 'auto') {
    currentModeLabel = '自动调度模式';
  } else if (mode === 'manual') {
    currentModeLabel = '手动固定模式';
  }
  if (autoStatus?.cycleInFlight) {
    runningStatusLabel = '调度中';
  } else if (autoStatus?.running) {
    runningStatusLabel = '后台运行';
  }

  return (
    <div className="ChatTopPanel">
      <div className="ChatTopTitleRow">
        <div className="ChatTopTitle">Yggdrasil Peer 模式设置</div>
        <div className="ChatTopActions">
          <select
            className="ChatInput"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as PeerMode);
            }}
            style={{ width: '120px' }}
            disabled={saving}
          >
            <option value="auto">自动模式</option>
            <option value="manual">手动模式</option>
            <option value="p2p">纯 P2P</option>
          </select>
          <button
            type="button"
            className="ServicePrimaryButton"
            onClick={saveCurrentMode}
            style={{ width: '140px' }}
            disabled={saving || (manualPageActive && !canSaveSelection)}
          >
            {saving ? '保存中...' : saveButtonLabel}
          </button>
          {manualSelectionHint ? (
            <div className="ChatTinyHint">{manualSelectionHint}</div>
          ) : null}
        </div>
      </div>

      {error ? <div className="ServiceError">{error}</div> : null}

      <div className="ChatTopGrid">
        <div className="ChatTopItem">
          <div className="ChatTopLabel">当前模式</div>
          <div className="ChatStack">
            <div className="ChatTopValue">{currentModeLabel}</div>
            <div className="ChatTinyHint">
              模式切换请使用顶部下拉框，再点击顶部保存按钮生效。
            </div>
          </div>
        </div>

        <div className="ChatTopItem">
          <div className="ChatTopLabel">运行状态</div>
          <div className="ChatTopValue">{runningStatusLabel}</div>
        </div>

        <div className="ChatTopItem">
          <div className="ChatTopLabel">手动固定 Peer</div>
          <div className="ChatTopValue">
            {mode === 'auto'
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

        {autoPageActive ? (
          <div className="ChatTopItem ChatTopItemWide">
            <div className="ChatTopLabel">自动模式页面</div>
            <div className="ChatStack">
              <div className="ChatTopValue">
                自动模式只通过 addpeer/removepeer 管理运行态 public
                peers，不会把 peer 列表写进 yggdrasil.conf。
              </div>
              <label className="ChatStack" htmlFor="auto-target-peer-count">
                <span className="ChatTopValue">目标总 peer 数</span>
                <select
                  id="auto-target-peer-count"
                  className="ChatInput"
                  value={targetPeerCount}
                  onChange={(e) => setTargetPeerCount(e.target.value)}
                  disabled={controlsDisabled}
                >
                  {TARGET_PEER_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <div className="ChatTinyHint">
                候选池规模和每个候选的采样次数会根据目标数量自动推导，
                大致按目标数量的 2 倍处理。
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: 8,
                }}
              >
                {autoConfigFields.map(({ label, value, setter }) => {
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

            <div className="ChatTinyHint">
              自动模式会从 public_peers.json 中动态挑选节点。手动模式和纯 P2P
              模式里保存的节点在自动模式下只会被排除，不会被自动调度直接采用。
            </div>
          </div>
        ) : null}

        <div className="ChatTopItem ChatTopItemWide">
          <div className="ChatTopLabel">最近事件</div>
          <pre className="ChatListenPre" style={{ maxHeight: 150 }}>
            {(autoStatus?.recentEvents ?? [])
              .map(
                (event) =>
                  `[${formatDateTime(event.at)}] ${event.level.toUpperCase()} ${event.message}`,
              )
              .join('\n') || '—'}
          </pre>
        </div>

        <div className="ChatTopItem ChatTopItemWide">
          <div className="ChatTopLabel">最近一次调度摘要</div>
          <pre className="ChatListenPre" style={{ maxHeight: 260 }}>
            {renderCycleSummary(autoStatus?.lastCycleSummary ?? null)}
          </pre>
        </div>

        {manualPageActive ? (
          <>
            <div className="ChatTopItem">
              <div className="ChatTopLabel">已选固定数量</div>
              <div className="ChatTopValue">{selected.length} / 10</div>
            </div>

            <div className="ChatTopItem ChatTopItemWide">
              <div className="ChatTopLabel">手动模式页面</div>
              <div className="StatusPre" style={{ maxHeight: '42vh' }}>
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
                            const disabled = !checked && atMax;
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
                                    disabled={controlsDisabled || disabled}
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

              <div className="ChatTinyHint">
                手动模式同样不会把 peer 写入 yggdrasil.conf。保存后，如果
                Yggdrasil 正在运行，会直接通过 addpeer/removepeer
                把运行态连接同步到你当前选择的节点集合。
              </div>
            </div>
          </>
        ) : null}

        {p2pPageActive ? (
          <div className="ChatTopItem ChatTopItemWide">
            <div className="ChatTopLabel">纯 P2P 模式页面</div>
            <div className="ChatStack">
              <div className="ChatTopValue">
                纯 P2P 模式当前等价于 0 个手动固定 public peer。
              </div>
              <div className="ChatTinyHint">
                保存后会停止自动 public peer 调度，并清空当前保存的手动 public
                peer 选择；运行中的 public 连接也会同步移除，仅保留 P2P 侧连接。
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
