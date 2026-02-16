export type ChatStatus = {
  running: boolean;
  peerId?: string;
  listenAddrs: string[];
  peers: string[];
  peerConnections?: { peerId: string; addrs: string[] }[];
  topics: string[];
  displayName?: string;
  identity?: {
    signPublicKeyDerB64: string;
    encPublicKeyDerB64: string;
  };
};

export type ChatConversation = {
  convId: string;
  type: 'group' | 'dm';
  title: string;
  topic: string;
  createdAt: number;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  unreadCount?: number;
  peerId?: string;
};

export type ChatMessage = {
  convId: string;
  type: 'group' | 'dm';
  topic: string;
  fromPeerId: string;
  fromDisplayName?: string;
  direction: 'in' | 'out';
  text: string;
  ts: number;
  receivedAt: number;
};
