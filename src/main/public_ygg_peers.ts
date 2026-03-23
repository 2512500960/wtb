import fs from 'fs';
import path from 'path';
import { randomInt } from 'crypto';

export type PublicPeerNode = {
  address: string;
  protocol?: string;
  ipVersion?: 'ipv4' | 'ipv6' | 'unknown';
  region?: string;
  status?: string;
  reliability?: string;
};

export type PreferredPublicPeerNode = PublicPeerNode & {
  serviceId: string;
  scheme: string;
};

export const DEFAULT_PREFER_SCHEMES = [
  'tls',
  'quic',
  'wss',
  'ws',
  'tcp',
] as const;

const schemeRank = (
  scheme: string | undefined,
  prefer: readonly string[],
): number => {
  const normalized = (scheme || '').toLowerCase();
  const idx = prefer.indexOf(normalized);
  return idx >= 0 ? idx : prefer.length + 10;
};

export const safePublicPeerUrl = (address: string): URL | null => {
  try {
    return new URL(address);
  } catch {
    return null;
  }
};

export const getPublicPeerServiceId = (address: string): string => {
  const u = safePublicPeerUrl(address);
  if (!u) return address;
  const host = (u.hostname || '').toLowerCase();
  const key = (u.searchParams.get('key') || '').toLowerCase();
  return `${host}|${key}`;
};

const shuffleInPlace = <T>(arr: T[]): void => {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
};

export const loadBundledPublicPeers = (
  yggBaseDir: string,
): PublicPeerNode[] => {
  const filePath = path.join(yggBaseDir, 'public_peers.json');
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, { encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((x) => x && typeof x === 'object' && typeof x.address === 'string')
    .map((x) => x as PublicPeerNode);
};

export const listPreferredPublicPeerNodes = (
  peers: PublicPeerNode[],
  preferSchemes: readonly string[] = DEFAULT_PREFER_SCHEMES,
): PreferredPublicPeerNode[] => {
  const groups = new Map<string, PublicPeerNode[]>();
  for (const p of peers) {
    const address = (p.address || '').trim();
    if (!address) continue;
    const u = safePublicPeerUrl(address);
    if (!u || !u.hostname) continue;

    const id = getPublicPeerServiceId(address);
    const list = groups.get(id) || [];
    list.push(p);
    groups.set(id, list);
  }

  const preferred: PreferredPublicPeerNode[] = [];
  for (const [id, list] of groups.entries()) {
    list.sort((a, b) => {
      const aScheme = safePublicPeerUrl(a.address)?.protocol?.replace(':', '') || '';
      const bScheme = safePublicPeerUrl(b.address)?.protocol?.replace(':', '') || '';
      return (
        schemeRank(aScheme, preferSchemes) - schemeRank(bScheme, preferSchemes)
      );
    });

    const best = list[0];
    preferred.push({
      ...best,
      serviceId: id,
      scheme:
        safePublicPeerUrl(best.address)?.protocol?.replace(':', '').toLowerCase() || '',
    });
  }

  return preferred;
};

export const pickRandomPublicPeerAddresses = (
  peers: PublicPeerNode[],
  count: number,
  preferSchemes: readonly string[] = DEFAULT_PREFER_SCHEMES,
): string[] => {
  if (!Number.isFinite(count) || count <= 0) return [];
  const bestPerService = listPreferredPublicPeerNodes(peers, preferSchemes).map(
    (peer) => peer.address,
  );

  shuffleInPlace(bestPerService);
  return bestPerService.slice(0, Math.min(count, bestPerService.length));
};
