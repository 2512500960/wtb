/*
  Minimal libp2p bootstrap node for WTB.

  Usage (dev):
    npm run p2p:bootstrap

  What it does:
  - Starts a libp2p node with tcp + noise + yamux
  - Enables identify + kad-dht (server mode)
  - Optionally enables gossipsub (not strictly required for bootstrapping)
  - Prints out multiaddrs you can paste into wtb-data/wtb.conf -> p2p.bootstrapMultiaddrs

  Notes:
  - You should run this on a host reachable by your clients (e.g. a VPS with Yggdrasil).
  - For Yggdrasil, bind/listen on the host's Yggdrasil IPv6 address.
*/

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { ping } from '@libp2p/ping';
import { bootstrap } from '@libp2p/bootstrap';
import { attachWtbHelloHandler } from '../src/main/libp2p_node';
const envStr = (name: string, def: string = ''): string => {
  const v = (process.env[name] || '').trim();
  return v || def;
};

const envInt = (name: string, def: number): number => {
  const raw = (process.env[name] || '').trim();
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
};

async function main(): Promise<void> {
  const host = envStr('WTB_BOOTSTRAP_HOST', '::');
  const port = envInt('WTB_BOOTSTRAP_PORT', 10848);
  const enablePubsub = envStr('WTB_BOOTSTRAP_PUBSUB', '1') !== '0';

  const listen = host.includes(':')
    ? [`/ip6/${host}/tcp/${port}`]
    : [`/ip4/${host}/tcp/${port}`];

  const node = await createLibp2p({
    addresses: {
      listen,
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      ping: ping(),
      bootstrap: bootstrap({
        list: [
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
          '/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8',
          '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
        ],
      }),
      identify: identify(),
      dht: kadDHT({
        // Server mode: this node participates in routing.
        clientMode: false,
      }),
      ...(enablePubsub
        ? {
            pubsub: gossipsub({
              emitSelf: false,
              globalSignaturePolicy: 'StrictSign',
            }),
          }
        : {}),
    },
  });

  // Allow WTB clients in strict mode to verify this peer.
  attachWtbHelloHandler(node as any);

  await node.start();

  // Print useful info.
  // For clients, you typically want multiaddrs like: /ip6/<ygg-ip>/tcp/<port>/p2p/<peerId>
  const peerId = node.peerId.toString();
  const addrs = node.getMultiaddrs().map((ma) => ma.toString());

  // eslint-disable-next-line no-console
  console.log('WTB libp2p bootstrap node started');
  // eslint-disable-next-line no-console
  console.log('peerId:', peerId);
  // eslint-disable-next-line no-console
  console.log('listen addrs:', addrs);
  // eslint-disable-next-line no-console
  console.log('--- paste into wtb.conf ---');
  for (const a of addrs) {
    // eslint-disable-next-line no-console
    console.log(`${a}/p2p/${peerId}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
