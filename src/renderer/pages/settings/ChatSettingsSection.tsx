import * as React from 'react';

import type { ChatStatus } from '../../types/chat';

export default function ChatSettingsSection() {
  const [status, setStatus] = React.useState<ChatStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [dialAddr, setDialAddr] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');

  const running = !!status?.running;

  const refreshStatus = React.useCallback(async () => {
    const res = (await window.electron.ipcRenderer.invoke(
      'chat:status',
    )) as ChatStatus;
    setStatus(res);
    setDisplayName(res.displayName ?? '');
  }, []);

  React.useEffect(() => {
    refreshStatus().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [refreshStatus]);

  const dial = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'chat:dial',
        dialAddr,
      )) as ChatStatus;
      setStatus(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveDisplayName = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'chat:identity:setDisplayName',
        displayName,
      )) as ChatStatus;
      setStatus(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const myPeerId = status?.peerId ?? '';
  const mySignPub = status?.identity?.signPublicKeyDerB64 ?? '';
  const myEncPub = status?.identity?.encPublicKeyDerB64 ?? '';

  return (
    <div className="ChatTopPanel">
      <div className="ChatTopLeft">
        <div className="ChatTopTitleRow">
          <div className="ChatTopTitle">聊天（libp2p）设置</div>
          <div className="ChatTopActions">
            <button
              type="button"
              className="ServiceGhostButton"
              onClick={async () => {
                setError(null);
                try {
                  await refreshStatus();
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
            <div className="ChatTopLabel">运行状态</div>
            <div className="ChatTopValue">{running ? '已启动' : '未启动'}</div>
          </div>

          <div className="ChatTopItem">
            <div className="ChatTopLabel">PeerId</div>
            <div className="ChatTopValue ChatMono">{myPeerId || '—'}</div>
          </div>

          <div className="ChatTopItem ChatTopItemWide">
            <div className="ChatTopLabel">监听地址</div>
            <pre className="ChatListenPre">
              {(status?.listenAddrs ?? []).join('\n') || '—'}
            </pre>
          </div>

          <div className="ChatTopItem ChatTopItemWide">
            <div className="ChatTopLabel">已连接的 peers</div>
            <pre className="ChatListenPre">
              {(status?.peers ?? []).join('\n') || '—'}
            </pre>
          </div>

          <div className="ChatTopItem ChatTopItemWide">
            <div className="ChatTopLabel">连接详情（peer → multiaddrs）</div>
            <pre className="ChatListenPre">
              {(status?.peerConnections ?? [])
                .map((pc) => {
                  const addrs =
                    pc.addrs && pc.addrs.length
                      ? pc.addrs.map((a) => `  ${a}`).join('\n')
                      : '  （无连接地址）';
                  return `${pc.peerId}\n${addrs}`;
                })
                .join('\n\n') || '—'}
            </pre>
          </div>

          <div className="ChatTopItem ChatTopItemWide">
            <div className="ChatTopLabel">昵称</div>
            <div className="ChatRow">
              <input
                className="ChatInput"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="我的昵称"
                disabled={busy}
              />
              <button
                type="button"
                className="ServicePrimaryButton"
                onClick={saveDisplayName}
                disabled={busy || !displayName.trim()}
              >
                保存
              </button>
            </div>
          </div>

          <div className="ChatTopItem ChatTopItemWide">
            <div className="ChatTopLabel">连接 peer（可选）</div>
            <div className="ChatRow">
              <input
                className="ChatInput"
                value={dialAddr}
                onChange={(e) => setDialAddr(e.target.value)}
                placeholder="/ip6/<ygg-ip>/tcp/<port>/p2p/<peerId>"
                disabled={!running || busy}
              />
              <button
                type="button"
                className="ServicePrimaryButton"
                onClick={dial}
                disabled={!running || busy || !dialAddr.trim()}
              >
                连接
              </button>
            </div>
          </div>

          <div className="ChatTopItem ChatTopItemWide">
            <div className="ChatTopLabel">我的公钥</div>
            <pre className="ChatKeyPre">{`sign=${mySignPub}\nenc=${myEncPub}`}</pre>
            <div className="ChatTinyHint">
              私聊需要交换对端的加密/签名公钥（base64 DER）。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
