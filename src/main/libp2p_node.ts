type Libp2pNode = any;

type Libp2pModules = {
  createLibp2p: any;
  tcp: any;
  noise: any;
  yamux: any;
  identify: any;
  gossipsub: any;
  ping: any;
  kadDHT: any;
  bootstrap: any;
  multiaddr: any;
};

let libp2pModulesPromise: Promise<Libp2pModules> | null = null;

const loadLibp2pModules = async (): Promise<Libp2pModules> => {
  if (libp2pModulesPromise) return libp2pModulesPromise;
  libp2pModulesPromise = (async () => {
    const libp2p = await import('libp2p');
    const tcpMod = await import('@libp2p/tcp');
    const noiseMod = await import('@chainsafe/libp2p-noise');
    const yamuxMod = await import('@chainsafe/libp2p-yamux');
    const identifyMod = await import('@libp2p/identify');
    const gossipsubMod = await import('@chainsafe/libp2p-gossipsub');
    const pingMod = await import('@libp2p/ping');
    const kadDhtMod = await import('@libp2p/kad-dht');
    const bootstrapMod = await import('@libp2p/bootstrap');
    const multiaddrMod = await import('@multiformats/multiaddr');

    return {
      createLibp2p: (libp2p as any).createLibp2p,
      tcp: (tcpMod as any).tcp,
      noise: (noiseMod as any).noise,
      yamux: (yamuxMod as any).yamux,
      identify: (identifyMod as any).identify,
      gossipsub: (gossipsubMod as any).gossipsub,
      ping: (pingMod as any).ping,
      kadDHT: (kadDhtMod as any).kadDHT,
      bootstrap: (bootstrapMod as any).bootstrap,
      multiaddr: (multiaddrMod as any).multiaddr,
    };
  })();
  return libp2pModulesPromise;
};

export const u8FromString = (input: string): Uint8Array => {
  return Buffer.from(input ?? '', 'utf8');
};

export const u8ToString = (input: Uint8Array): string => {
  return Buffer.from(input ?? new Uint8Array()).toString('utf8');
};

export const WTB_HELLO_PROTOCOL = '/wtb/hello/1.0.0';
const WTB_HELLO_REQ = 'wtb-hello-v1';
const WTB_HELLO_RESP = 'wtb-ok-v1';
const WTB_HELLO_TIMEOUT_MS = 1200;
const WTB_HELLO_MAX_BYTES = 64;

export type WtbLibp2pCreateOptions = {
  /** Multiaddr string, e.g. `/ip6/<addr>/tcp/<port>` */
  listenAddr: string;
  /** Optional announce addr; defaults to listenAddr */
  announceAddr?: string;
  /** Bootstrap multiaddrs; empty disables bootstrap discovery */
  bootstrapMultiaddrs?: string[];
  /** Bootstrap discovery interval (ms). Clamped to >= 5000. */
  bootstrapIntervalMs?: number;
  /** Enable kad-dht service (clientMode). Default: true */
  enableDht?: boolean;
  /**
   * Strict mode: only keep connections to peers that speak the WTB hello protocol.
   * Non-WTB peers will be disconnected shortly after connect.
   */
  strictWtbPeers?: boolean;
};

const includesNewline = (u8: Uint8Array): boolean => {
  for (let i = 0; i < u8.length; i += 1) {
    if (u8[i] === 10 /* \n */) return true;
  }
  return false;
};

const readLineFromStreamBestEffort = async (
  stream: any,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> => {
  const p = (async () => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const src = stream?.source;
      if (!src || !(Symbol.asyncIterator in Object(src))) return '';
      // eslint-disable-next-line no-restricted-syntax
      for await (const chunk of src as AsyncIterable<Uint8Array>) {
        if (!(chunk instanceof Uint8Array)) continue;
        chunks.push(chunk);
        total += chunk.length;
        if (total >= maxBytes) break;
        if (includesNewline(chunk)) break;
      }
    } catch {
      // ignore
    }

    try {
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return buf.toString('utf8').trim();
    } catch {
      return '';
    }
  })();

  if (timeoutMs <= 0) return await p;
  return await Promise.race([
    p,
    new Promise<string>((resolve) => {
      setTimeout(() => resolve(''), Math.max(1, timeoutMs));
    }),
  ]);
};

const writeLineToStreamBestEffort = async (stream: any, line: string): Promise<void> => {
  try {
    const sink = stream?.sink;
    if (!(sink instanceof Function)) return;
    const data = u8FromString(`${line}\n`);
    await sink(
      (async function* () {
        yield data;
      })(),
    );
  } catch {
    // ignore
  }
};

export const attachWtbHelloHandler = (node: Libp2pNode): void => {
  try {
    const handleFn = (node as any)?.handle;
    if (!(handleFn instanceof Function)) return;

    (node as any).handle(WTB_HELLO_PROTOCOL, async ({ stream }: any) => {
      const req = await readLineFromStreamBestEffort(
        stream,
        WTB_HELLO_TIMEOUT_MS,
        WTB_HELLO_MAX_BYTES,
      );
      if (req !== WTB_HELLO_REQ) {
        try {
          await stream?.close?.();
        } catch {
          // ignore
        }
        return;
      }

      await writeLineToStreamBestEffort(stream, WTB_HELLO_RESP);
      try {
        await stream?.close?.();
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
};

const verifyWtbPeerBestEffort = async (
  node: Libp2pNode,
  peerId: any,
  opts?: { fallbackAddrs?: string[]; multiaddr?: any },
): Promise<boolean> => {
  const peerIdStr = peerId?.toString?.() ?? '';
  if (!peerIdStr) return false;

  const attempt = async (): Promise<boolean> => {
    let stream: any;
    try {
      const dialProto = (node as any)?.dialProtocol;
      if (!(dialProto instanceof Function)) return false;
      stream = await dialProto.call(node, peerId, WTB_HELLO_PROTOCOL);
    } catch {
      return false;
    }

    await writeLineToStreamBestEffort(stream, WTB_HELLO_REQ);
    const resp = await readLineFromStreamBestEffort(
      stream,
      WTB_HELLO_TIMEOUT_MS,
      WTB_HELLO_MAX_BYTES,
    );
    try {
      await stream?.close?.();
    } catch {
      // ignore
    }
    return resp === WTB_HELLO_RESP;
  };

  const ok1 = await attempt();
  if (ok1) return true;

  // Fallback: if we lack addresses for the peerId, try dial by a discovered multiaddr once,
  // then retry the hello protocol.
  const addrs = (opts?.fallbackAddrs ?? []).filter((a) => (a ?? '').trim().length > 0);
  if (addrs.length > 0 && opts?.multiaddr) {
    try {
      await (node as any)?.dial?.(opts.multiaddr(addrs[0]));
    } catch {
      // ignore
    }
    const ok2 = await attempt();
    if (ok2) return true;
  }

  return false;
};

const attachAutoDialOnPeerDiscoveryWithMultiaddr = (
  node: Libp2pNode,
  multiaddr: any,
  opts?: { strictWtbPeers?: boolean },
): void => {
  const strictWtbPeers = opts?.strictWtbPeers ?? false;
  const verifiedCache = new Map<string, { ok: boolean; at: number }>();
  const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;
  const inflightVerify = new Map<string, Promise<boolean>>();

  const getCached = (peerIdStr: string): boolean | null => {
    const v = verifiedCache.get(peerIdStr);
    if (!v) return null;
    if (Date.now() - v.at > VERIFY_CACHE_TTL_MS) {
      verifiedCache.delete(peerIdStr);
      return null;
    }
    return v.ok;
  };

  const setCached = (peerIdStr: string, ok: boolean): void => {
    verifiedCache.set(peerIdStr, { ok, at: Date.now() });
  };

  const verifyOnce = async (peerId: any, fallbackAddrs: string[]): Promise<boolean> => {
    const peerIdStr = peerId?.toString?.() ?? '';
    if (!peerIdStr) return false;

    const cached = getCached(peerIdStr);
    if (cached != null) return cached;

    if (inflightVerify.has(peerIdStr)) return await inflightVerify.get(peerIdStr)!;

    const p = verifyWtbPeerBestEffort(node, peerId, {
      fallbackAddrs,
      multiaddr,
    })
      .then((ok) => {
        setCached(peerIdStr, ok);
        return ok;
      })
      .finally(() => {
        inflightVerify.delete(peerIdStr);
      });

    inflightVerify.set(peerIdStr, p);
    return await p;
  };

  const hangUpBestEffort = async (peerId: any): Promise<void> => {
    try {
      const hup = (node as any)?.hangUp;
      if (hup instanceof Function) {
        await hup.call(node, peerId);
        return;
      }
    } catch {
      // ignore
    }

    try {
      const conns = (node as any)?.getConnections?.(peerId) ?? [];
      for (const c of conns) {
        try {
          await c?.close?.();
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  };

  if (strictWtbPeers) {
    node.addEventListener('peer:connect', (evt: any) => {
      const pid = evt?.detail;
      const pidStr = pid?.toString?.() ?? '';
      if (!pidStr) return;
      if (pidStr === node.peerId?.toString?.()) return;

      // Verify on connect; disconnect quickly if not a WTB peer.
      void verifyOnce(pid, [])
        .then(async (ok) => {
          if (ok) return;
          await hangUpBestEffort(pid);
        })
        .catch(async () => {
          await hangUpBestEffort(pid);
        });
    });
  }

  // Best-effort: auto-dial peers as they are discovered.
  // This is intentionally conservative; dial failures are expected.
  node.addEventListener('peer:discovery', (evt: any) => {
    try {
      const detail = evt?.detail;
      const peerIdStr = detail?.id?.toString?.() ?? String(detail?.id ?? '');
      const addrs = Array.isArray(detail?.multiaddrs)
        ? detail.multiaddrs.map((ma: any) => ma.toString())
        : [];

       if (strictWtbPeers && peerIdStr) {
         const cached = getCached(peerIdStr);
         // If we already know it's NOT a WTB peer, don't waste dials.
         if (cached === false) return;
       }

      // Try dial by peer id (if peerStore has addrs) else dial the first multiaddr.
      Promise.resolve()
        .then(async () => {
          if (strictWtbPeers && detail?.id) {
            const ok = await verifyOnce(detail.id, addrs);
            if (!ok) {
              await hangUpBestEffort(detail.id);
            }
            return;
          }

          if (peerIdStr) {
            try {
              await (node as any).dial?.(detail.id);
              return;
            } catch {
              // fall back
            }
          }
          if (addrs.length > 0) {
            await (node as any).dial?.(multiaddr(addrs[0]));
          }
        })
        .catch(() => {
          // ignore
        });
    } catch {
      // ignore
    }
  });
};

export const attachAutoDialOnPeerDiscovery = (node: Libp2pNode): void => {
  void loadLibp2pModules()
    .then(({ multiaddr }) => {
      attachAutoDialOnPeerDiscoveryWithMultiaddr(node, multiaddr);
    })
    .catch(() => {
      // ignore
    });
};

export const createWtbLibp2pNode = async (
  opts: WtbLibp2pCreateOptions,
): Promise<Libp2pNode> => {
  const listenAddr = (opts.listenAddr ?? '').trim();
  if (!listenAddr) {
    throw new Error('createWtbLibp2pNode: listenAddr is required');
  }

  const announceAddr = (opts.announceAddr ?? listenAddr).trim();

  const bootstrapMultiaddrs = (opts.bootstrapMultiaddrs ?? [])
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => !!v);

  const bootstrapIntervalMsRaw = opts.bootstrapIntervalMs ?? 60_000;
  const bootstrapIntervalMs =
    Number.isFinite(bootstrapIntervalMsRaw) && bootstrapIntervalMsRaw >= 5_000
      ? bootstrapIntervalMsRaw
      : 60_000;

  const enableDht = opts.enableDht ?? true;

  const strictWtbPeers = opts.strictWtbPeers ?? false;

  const {
    createLibp2p,
    tcp,
    noise,
    yamux,
    identify,
    gossipsub,
    ping,
    kadDHT,
    bootstrap,
    multiaddr,
  } = await loadLibp2pModules();

  const node = await createLibp2p({
    addresses: {
      listen: [listenAddr],
      announce: [announceAddr],
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: bootstrapMultiaddrs.length
      ? [
          bootstrap({
            list: bootstrapMultiaddrs,
            interval: bootstrapIntervalMs,
          }),
        ]
      : [],
    services: {
      ping: ping(),
      identify: identify(),
      pubsub: gossipsub({
        emitSelf: false,
        globalSignaturePolicy: 'StrictSign',
        // In tiny networks, we can be connected to a peer that *is* subscribed
        // but subscription state hasn't propagated yet. Without this, publish()
        // throws PublishError.NoPeersSubscribedToTopic and nothing is sent.
        // With floodPublish enabled, we still attempt delivery to connected peers.
        allowPublishToZeroTopicPeers: true,
        floodPublish: true,
        fallbackToFloodsub: true,
      }),
      ...(bootstrapMultiaddrs.length
        ? {
            bootstrap: bootstrap({
              list: bootstrapMultiaddrs,
              interval: bootstrapIntervalMs,
            }),
          }
        : {}),
      ...(enableDht
        ? {
            dht: kadDHT({
              // Default to client mode so regular clients don't become routing infrastructure.
              clientMode: true,
            }),
          }
        : {}),
    },
  });

  // Ensure all WTB nodes can be verified via an app-specific protocol.
  attachWtbHelloHandler(node);

  attachAutoDialOnPeerDiscoveryWithMultiaddr(node, multiaddr, { strictWtbPeers });

  return node;
};
