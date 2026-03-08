import * as React from 'react';

type PublicPeerNode = {
  address: string;
  protocol?: string;
  ipVersion?: 'ipv4' | 'ipv6' | 'unknown';
  region?: string;
  status?: string;
  reliability?: string;
};

const normalizeAddr = (s: string): string => s.trim();
const normalizeField = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : '';

export default function YggdrasilPeersSettingsSection() {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [candidates, setCandidates] = React.useState<PublicPeerNode[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [listRaw, selectionRaw] = (await Promise.all([
        window.electron.ipcRenderer.invoke('ygg:publicPeers:list'),
        window.electron.ipcRenderer.invoke('ygg:publicPeers:getSelection'),
      ])) as [unknown, unknown];

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

      setCandidates(list);
      setSelected(
        Array.from(new Set(selection)).filter((x) => candidateAddrSet.has(x)),
      );

      if (!list.length) {
        setError(
          '未找到 public_peers.json（或内容为空）。请确认打包资源中包含 yggdrasil/public_peers.json。',
        );
      }
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    refresh().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    });
  }, [refresh]);

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);

  const toggle = (addr: string) => {
    const a = normalizeAddr(addr);
    if (!a) return;
    setSelected((prev) => {
      if (prev.includes(a)) return prev.filter((x) => x !== a);
      if (prev.length >= 10) return prev;
      return [...prev, a];
    });
  };

  const canSave = selected.length >= 1 && selected.length <= 10;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.electron.ipcRenderer.invoke(
        'ygg:publicPeers:setSelection',
        selected,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ChatTopPanel">
      <div className="ChatTopTitleRow">
        <div className="ChatTopTitle">Yggdrasil 公共 Peer 选择</div>
        <div className="ChatTopActions">
          <button
            type="button"
            className="ServiceGhostButton"
            onClick={async () => {
              setError(null);
              try {
                await refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
            disabled={busy}
          >
            刷新
          </button>
        </div>
      </div>

      {error ? <div className="ServiceError">{error}</div> : null}

      <div className="ChatTopGrid">
        <div className="ChatTopItem">
          <div className="ChatTopLabel">已选数量</div>
          <div className="ChatTopValue">{selected.length} / 10</div>
        </div>

        <div className="ChatTopItem">
          <div className="ChatTopLabel">保存</div>
          <div className="ChatRow">
            <button
              type="button"
              className="ServicePrimaryButton"
              onClick={save}
              disabled={busy || !canSave}
            >
              确认
            </button>
          </div>
        </div>

        <div className="ChatTopItem ChatTopItemWide">
          <div className="ChatTopLabel">候选列表（public_peers.json）</div>
          <div className="StatusPre" style={{ maxHeight: '42vh' }}>
            {!candidates.length ? (
              <div className="StatusEmpty">（暂无候选项）</div>
            ) : (
              (() => {
                const rows = candidates
                  .map((p) => {
                    const addr = normalizeAddr(p.address);
                    if (!addr) return null;
                    const region = normalizeField(p.region) || '未知';
                    const protocol = normalizeField(p.protocol) || '-';
                    const ipVersion = normalizeField(p.ipVersion) || '-';
                    const status = normalizeField(p.status) || '-';
                    const reliability = normalizeField(p.reliability) || '-';
                    return {
                      addr,
                      region,
                      protocol,
                      ipVersion,
                      status,
                      reliability,
                    };
                  })
                  .filter((x): x is NonNullable<typeof x> => x != null)
                  .sort((a, b) => {
                    const r = a.region.localeCompare(b.region);
                    if (r !== 0) return r;
                    const p = a.protocol.localeCompare(b.protocol);
                    if (p !== 0) return p;
                    const ip = a.ipVersion.localeCompare(b.ipVersion);
                    if (ip !== 0) return ip;
                    return a.addr.localeCompare(b.addr);
                  });

                const groups: Array<{ region: string; items: typeof rows }> =
                  [];
                for (const row of rows) {
                  const last = groups[groups.length - 1];
                  if (!last || last.region !== row.region) {
                    groups.push({ region: row.region, items: [row] });
                  } else {
                    last.items.push(row);
                  }
                }

                const atMax = selected.length >= 10;

                return (
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
                                    checked={checked}
                                    disabled={busy || disabled}
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
                );
              })()
            )}
          </div>

          <div className="ChatTinyHint">
            说明：可选择 1~10 个。保存后写入 wtb.conf，并在下次启动/启动
            Yggdrasil 前更新 yggdrasil.conf 的 Peers。
          </div>
        </div>
      </div>
    </div>
  );
}
