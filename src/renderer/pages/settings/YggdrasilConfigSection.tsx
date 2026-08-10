import * as React from 'react';

type YggConfig = {
  ifMtu: number;
  tcpOnly: boolean;
  yamuxStreamWindowKb: number;
  quicOnly: boolean;
  preferIpv6: boolean;
};

export default function YggdrasilConfigSection() {
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [config, setConfig] = React.useState<YggConfig | null>(null);
  const [ifMtu, setIfMtu] = React.useState('');
  const [tcpOnly, setTcpOnly] = React.useState(true);
  const [yamuxStreamWindowKb, setYamuxStreamWindowKb] = React.useState('16384');
  const [quicOnly, setQuicOnly] = React.useState(false);
  const [preferIpv6, setPreferIpv6] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'ygg:config:get',
      )) as YggConfig;
      setConfig(res);
      setIfMtu(String(res.ifMtu));
      setTcpOnly(res.tcpOnly);
      setYamuxStreamWindowKb(String(res.yamuxStreamWindowKb));
      setQuicOnly(res.quicOnly);
      setPreferIpv6(res.preferIpv6);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  React.useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const mtu = Number(ifMtu);
      if (!Number.isFinite(mtu) || mtu < 1280 || mtu > 65535) {
        throw new Error('MTU 必须在 1280~65535 之间');
      }

      await window.electron.ipcRenderer.invoke('ygg:config:set', {
        ifMtu: mtu,
        tcpOnly,
        yamuxStreamWindowKb: Number(yamuxStreamWindowKb),
        quicOnly,
        preferIpv6,
      });

      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ChatTopPanel">
      <div className="ChatTopTitleRow">
        <div className="ChatTopTitle">Yggdrasil 参数配置</div>
        <div className="ChatTopActions">
          <button
            type="button"
            className="ServicePrimaryButton"
            onClick={save}
            disabled={saving}
            style={{ width: '140px' }}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>

      {error ? <div className="ServiceError">{error}</div> : null}

      <div className="ChatTopGrid">
        <div className="ChatTopItem">
          <div className="ChatTopLabel">MTU</div>
          <div className="ChatStack">
            <input
              className="ChatInput"
              value={ifMtu}
              onChange={(e) => setIfMtu(e.target.value)}
              inputMode="numeric"
              placeholder="32768"
              disabled={saving}
            />
            <div className="ChatTinyHint">
              建议 1280~65535。默认 32768。 设置后需要重启 Yggdrasil
              服务才能生效。
            </div>
          </div>
        </div>

        <div className="ChatTopItem">
          <div className="ChatTopLabel">Yamux Stream Window (KB)</div>
          <div className="ChatStack">
            <input
              className="ChatInput"
              value={yamuxStreamWindowKb}
              onChange={(e) => setYamuxStreamWindowKb(e.target.value)}
              inputMode="numeric"
              placeholder="16384"
              disabled={saving}
            />
            <div className="ChatTinyHint">
              建议 4096~65536，默认 16384。 设置后需要重启 Yggdrasil
              服务才能生效。
            </div>
          </div>
        </div>

        <div className="ChatTopItem">
          <div className="ChatTopLabel">TCP only</div>
          <div className="ChatStack">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={tcpOnly}
                onChange={(e) => {
                  setTcpOnly(e.target.checked);
                  if (e.target.checked) setQuicOnly(false);
                }}
                disabled={saving}
              />
              <span>仅使用 TCP 传输（关闭 QUIC）</span>
            </label>
            <div className="ChatTinyHint">
              默认开启。关闭后 yggdrasil 会尝试使用 QUIC 传输，可能提升性能，
              但也可能在某些网络环境下导致连接问题。 设置后需要重启 Yggdrasil
              服务才能生效。
            </div>
          </div>
        </div>

        <div className="ChatTopItem">
          <div className="ChatTopLabel">QUIC only</div>
          <div className="ChatStack">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={quicOnly}
                onChange={(e) => {
                  setQuicOnly(e.target.checked);
                  if (e.target.checked) setTcpOnly(false);
                }}
                disabled={saving}
              />
              <span>仅使用 QUIC 传输（关闭 TCP）</span>
            </label>
            <div className="ChatTinyHint">
              默认关闭。与 TCP only 互斥，开启后自动关闭 TCP only。重启 Yggdrasil
              服务才能生效。
            </div>
          </div>
        </div>

        <div className="ChatTopItem">
          <div className="ChatTopLabel">Prefer IPv6</div>
          <div className="ChatStack">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={preferIpv6}
                onChange={(e) => setPreferIpv6(e.target.checked)}
                disabled={saving}
              />
              <span>IPv6 地址优先</span>
            </label>
            <div className="ChatTinyHint">
              默认关闭。P2P 连接时 IPv6 地址排序优先于 IPv4。重启 Yggdrasil
              服务才能生效。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
