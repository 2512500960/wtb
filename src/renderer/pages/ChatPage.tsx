import * as React from 'react';
import { Link } from 'react-router-dom';
import EmojiPicker, { EmojiClickData } from 'emoji-picker-react';

import type { ChatConversation, ChatMessage, ChatStatus } from '../types/chat';

function ModalShell({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="ChatModalOverlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ChatModal" role="dialog" aria-modal="true">
        <div className="ChatModalHeader">
          <div className="ChatModalTitle">{title}</div>
          <button
            type="button"
            className="ServiceGhostButton"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
        <div className="ChatModalBody">{children}</div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const [status, setStatus] = React.useState<ChatStatus | null>(null);
  const [conversations, setConversations] = React.useState<ChatConversation[]>(
    [],
  );
  const [activeConvId, setActiveConvId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [composer, setComposer] = React.useState('');
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);

  const [showEmoji, setShowEmoji] = React.useState(false);

  const [showNewGroup, setShowNewGroup] = React.useState(false);
  const [newGroupTitle, setNewGroupTitle] = React.useState('');

  const [showNewDm, setShowNewDm] = React.useState(false);
  const [dmPeerId, setDmPeerId] = React.useState('');
  const [dmTitle, setDmTitle] = React.useState('');
  const [dmPeerEncPub, setDmPeerEncPub] = React.useState('');
  const [dmPeerSignPub, setDmPeerSignPub] = React.useState('');

  const running = !!status?.running;

  const refreshStatus = React.useCallback(async () => {
    const res = (await window.electron.ipcRenderer.invoke(
      'chat:status',
    )) as ChatStatus;
    setStatus(res);
  }, []);

  const refreshConversations = React.useCallback(async () => {
    const res = (await window.electron.ipcRenderer.invoke(
      'chat:conversations:list',
    )) as ChatConversation[];
    setConversations(res);

    if (!activeConvId && res.length) {
      setActiveConvId(res[0].convId);
    }
  }, [activeConvId]);

  const loadActiveMessages = React.useCallback(
    async (convId: string) => {
      const res = (await window.electron.ipcRenderer.invoke(
        'chat:conversation:load',
        convId,
        300,
      )) as ChatMessage[];
      setMessages(res);
      await window.electron.ipcRenderer.invoke(
        'chat:conversation:markRead',
        convId,
      );
      refreshConversations();
    },
    [refreshConversations],
  );

  React.useEffect(() => {
    (async () => {
      await refreshStatus();
      await refreshConversations();

      // If Yggdrasil is running, ensure chat starts automatically.
      try {
        const services = (await window.electron.ipcRenderer.invoke(
          'services:getAll',
        )) as { name: string; state: 'running' | 'stopped' }[] | undefined;
        const ygg = services?.find((s) => s.name === 'yggdrasil');
        if (ygg?.state === 'running') {
          const chatSt = (await window.electron.ipcRenderer.invoke(
            'chat:status',
          )) as ChatStatus;
          if (!chatSt.running) {
            try {
              const res = (await window.electron.ipcRenderer.invoke(
                'chat:start',
              )) as ChatStatus;
              setStatus(res);
              await refreshConversations();
            } catch (e) {
              // Non-fatal: surface error for visibility but continue
              setError(e instanceof Error ? e.message : String(e));
            }
          }
        }
      } catch {
        // ignore service-check failures
      }
    })();
  }, [refreshStatus, refreshConversations]);

  React.useEffect(() => {
    if (!activeConvId) return;
    loadActiveMessages(activeConvId);
  }, [activeConvId, loadActiveMessages]);

  React.useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on(
      'chat:message',
      (msg) => {
        const m = msg as ChatMessage;
        refreshConversations();
        if (m.convId === activeConvId) {
          setMessages((prev) => [...prev, m].slice(-800));
        }
      },
    );
    return () => {
      unsubscribe();
    };
  }, [activeConvId, refreshConversations]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'chat:start',
      )) as ChatStatus;
      setStatus(res);
      await refreshConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'chat:stop',
      )) as ChatStatus;
      setStatus(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createGroup = async () => {
    setBusy(true);
    setError(null);
    try {
      const conv = (await window.electron.ipcRenderer.invoke(
        'chat:conversation:createGroup',
        newGroupTitle,
      )) as ChatConversation;
      setNewGroupTitle('');
      setShowNewGroup(false);
      await refreshConversations();
      setActiveConvId(conv.convId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startDm = async () => {
    setBusy(true);
    setError(null);
    try {
      const conv = (await window.electron.ipcRenderer.invoke(
        'chat:conversation:startDm',
        {
          peerId: dmPeerId,
          title: dmTitle,
          peerEncPublicKeyDerB64: dmPeerEncPub.trim(),
          peerSignPublicKeyDerB64: dmPeerSignPub.trim(),
        },
      )) as ChatConversation;
      setActiveConvId(conv.convId);
      setComposer('');
      setShowNewDm(false);
      await refreshConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!activeConvId) return;
    const text = composer.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await window.electron.ipcRenderer.invoke(
        'chat:message:send',
        activeConvId,
        text,
      );
      setComposer('');
      setShowEmoji(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const insertEmoji = React.useCallback((emoji: string) => {
    setComposer((prev) => {
      const el = composerRef.current;
      if (!el) return `${prev}${emoji}`;

      const start = el.selectionStart ?? prev.length;
      const end = el.selectionEnd ?? prev.length;
      const next = `${prev.slice(0, start)}${emoji}${prev.slice(end)}`;

      requestAnimationFrame(() => {
        try {
          el.focus();
          const pos = start + emoji.length;
          el.setSelectionRange(pos, pos);
        } catch {
          // ignore
        }
      });

      return next;
    });
  }, []);

  const activeConv =
    conversations.find((c) => c.convId === activeConvId) ?? null;
  // status/identity UI moved to SettingsPage

  let timelineContent: React.ReactNode = null;
  if (!activeConv) {
    timelineContent = <div className="ChatEmpty">请选择左侧会话</div>;
  } else if (!messages.length) {
    timelineContent = <div className="ChatEmpty">暂无消息</div>;
  } else {
    timelineContent = messages.map((m) => {
      const t = new Date(m.ts || m.receivedAt).toLocaleTimeString();
      const isOut = m.direction === 'out';
      const who = isOut
        ? status?.displayName || '我'
        : m.fromDisplayName || m.fromPeerId.slice(0, 10);
      const rowClass = isOut ? 'ChatMsgRow ChatMsgOut' : 'ChatMsgRow ChatMsgIn';
      const key = `${m.receivedAt}-${m.ts}-${m.fromPeerId}-${m.direction}`;
      return (
        <div key={key} className={rowClass}>
          <div className="ChatMsgMeta">
            <span className="ChatMsgWho">{who}</span>
            <span className="ChatDot">·</span>
            <span className="ChatMsgTime">{t}</span>
          </div>
          <div className="ChatMsgBubble">{m.text}</div>
        </div>
      );
    });
  }

  return (
    <div className="PageRoot ChatPageRoot">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">聊天（libp2p）</div>
      </div>

      <div className="ChatPageBody">
        {error ? <div className="ServiceError">{error}</div> : null}

        <div className="ChatSecondPanel">
          <div className="ChatSecondTitle">新建会话</div>
          <div className="ChatSecondActions">
            <button
              type="button"
              className="ServicePrimaryButton"
              onClick={() => setShowNewDm(true)}
              disabled={!running || busy}
            >
              新建私聊
            </button>
            <button
              type="button"
              className="ServicePrimaryButton"
              onClick={() => setShowNewGroup(true)}
              disabled={!running || busy}
            >
              新建群聊
            </button>
          </div>
        </div>

        <div className="ChatShell">
          <div className="ChatSidebar">
            <div className="ChatSidebarHeader">
              <div className="ChatSidebarTitle">会话列表</div>
            </div>

            <div className="ChatConversationList">
              {conversations.length ? (
                conversations.map((c) => {
                  const selected = c.convId === activeConvId;
                  const unread = c.unreadCount ?? 0;
                  const meta =
                    c.lastMessagePreview ||
                    (c.type === 'group' ? '群组' : '私聊');
                  return (
                    <button
                      key={c.convId}
                      type="button"
                      className={
                        selected
                          ? 'ChatConvItem ChatConvItemSelected'
                          : 'ChatConvItem'
                      }
                      onClick={() => setActiveConvId(c.convId)}
                    >
                      <div className="ChatConvTop">
                        <div className="ChatConvTitle">{c.title}</div>
                        {unread ? (
                          <div className="ChatConvBadge">{unread}</div>
                        ) : null}
                      </div>
                      <div className="ChatConvMeta">{meta}</div>
                    </button>
                  );
                })
              ) : (
                <div className="ChatEmpty">暂无会话（先创建群组或私聊）</div>
              )}
            </div>
          </div>

          <div className="ChatMain">
            <div className="ChatMainHeader">
              <div className="ChatMainTitle">
                {activeConv ? activeConv.title : '未选择会话'}
              </div>
              {activeConv ? (
                <div className="ChatMainSub">
                  <span className="ChatMono">{activeConv.type}</span>
                  <span className="ChatDot">·</span>
                  <span className="ChatMono">{activeConv.topic}</span>
                </div>
              ) : null}
            </div>

            <div className="ChatTimeline">{timelineContent}</div>

            <div className="ChatComposer">
              <div className="ChatComposerLeft">
                <textarea
                  ref={composerRef}
                  className="ChatComposerInput ChatComposerTextArea"
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  placeholder={activeConv ? '输入消息…' : '先选择会话…'}
                  disabled={!running || busy || !activeConv}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />

                <button
                  type="button"
                  className="ServiceGhostButton"
                  onClick={() => setShowEmoji((v) => !v)}
                  disabled={!running || busy || !activeConv}
                >
                  😀
                </button>

                {showEmoji ? (
                  <div className="ChatEmojiPopover">
                    <EmojiPicker
                      onEmojiClick={(emojiData: EmojiClickData) => {
                        insertEmoji(emojiData.emoji);
                      }}
                      searchDisabled={false}
                      lazyLoadEmojis
                    />
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                className="ServicePrimaryButton"
                onClick={send}
                disabled={!running || busy || !activeConv || !composer.trim()}
              >
                发送
              </button>
            </div>
          </div>
        </div>
      </div>

      <ModalShell
        title="新建群聊"
        open={showNewGroup}
        onClose={() => {
          if (!busy) setShowNewGroup(false);
        }}
      >
        <div className="ChatStack">
          <input
            className="ChatInput"
            value={newGroupTitle}
            onChange={(e) => setNewGroupTitle(e.target.value)}
            placeholder="群组名称"
            disabled={!running || busy}
          />
          <button
            type="button"
            className="ServicePrimaryButton"
            onClick={createGroup}
            disabled={!running || busy || !newGroupTitle.trim()}
          >
            创建
          </button>
        </div>
      </ModalShell>

      <ModalShell
        title="新建私聊"
        open={showNewDm}
        onClose={() => {
          if (!busy) setShowNewDm(false);
        }}
      >
        <div className="ChatStack">
          <input
            className="ChatInput"
            value={dmPeerId}
            onChange={(e) => setDmPeerId(e.target.value)}
            placeholder="对端 peerId"
            disabled={!running || busy}
          />
          <input
            className="ChatInput"
            value={dmTitle}
            onChange={(e) => setDmTitle(e.target.value)}
            placeholder="备注（可选）"
            disabled={!running || busy}
          />
          <input
            className="ChatInput"
            value={dmPeerSignPub}
            onChange={(e) => setDmPeerSignPub(e.target.value)}
            placeholder="对端 signPublicKeyDerB64"
            disabled={!running || busy}
          />
          <input
            className="ChatInput"
            value={dmPeerEncPub}
            onChange={(e) => setDmPeerEncPub(e.target.value)}
            placeholder="对端 encPublicKeyDerB64"
            disabled={!running || busy}
          />
          <button
            type="button"
            className="ServicePrimaryButton"
            onClick={startDm}
            disabled={
              !running ||
              busy ||
              !dmPeerId.trim() ||
              !dmPeerSignPub.trim() ||
              !dmPeerEncPub.trim()
            }
          >
            开始私聊
          </button>
        </div>
      </ModalShell>
    </div>
  );
}
