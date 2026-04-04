import path from 'path';
import fs from 'fs';
import log from 'electron-log';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import net from 'net';

// Defer loading cheerio; in Jest (jsdom) we'll use DOM APIs to avoid ESM issues
let cheerio: any = undefined;

const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_URL = 'https://publicpeers.neilalexander.dev/';
// Optional fallback URL can be provided via env var PUBLIC_PEERS_FALLBACK_URL
const DEFAULT_URLS = [DEFAULT_URL].concat(
  process.env.PUBLIC_PEERS_FALLBACK_URL ? [process.env.PUBLIC_PEERS_FALLBACK_URL] : [],
);

const httpGetText = async (url: string, timeoutMs = 20_000): Promise<string> => {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;

  return await new Promise((resolve, reject) => {
    const req = transport.request(
      {
        method: 'GET',
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: {
          Accept: 'text/html, application/json, text/plain;q=0.9, */*;q=0.1',
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (statusCode >= 200 && statusCode < 300) {
            resolve(Buffer.concat(chunks).toString('utf8'));
          } else {
            reject(new Error(`HTTP ${statusCode}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timeout'));
    });
    req.end();
  });
};

type FullEntry = { address: string; status: string; reliability: string; class: string };

const collapseWs = (s: string) => s.replace(/\s+/g, ' ').trim();

export const parsePublicPeersHtml = (html: string): Map<string, FullEntry[]> => {
  const out = new Map<string, FullEntry[]>();

  // If running under a DOM-enabled environment (Jest's jsdom), parse via DOM APIs
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const container = document.createElement('div');
    container.innerHTML = html;

    // Find each table row and extract fields; country is taken from the table's th#country
    const rows = Array.from(container.querySelectorAll('tr'));
    for (const tr of rows) {
      const tdAddress = tr.querySelector('td#address');
      if (!tdAddress) continue;
      const address = collapseWs((tdAddress.textContent || '').toString());
      if (!address) continue;

      // find country header within the same table (preferred)
      let country = '(unknown)';
      const table = (tr as Element).closest('table');
      if (table) {
        const th = table.querySelector('th#country');
        if (th) country = collapseWs((th.textContent || '').toString()) || '(unknown)';
      }

      const tdStatus = tr.querySelector('td#status');
      const tdRel = tr.querySelector('td#reliability');
      const status = collapseWs((tdStatus?.textContent || '').toString());
      const reliability = collapseWs((tdRel?.textContent || '').toString());
      const rowClass = ((tr.getAttribute && tr.getAttribute('class')) || '').toLowerCase();

      const looksUsable = (): boolean => {
        if (rowClass.includes('statusgood')) return true;
        if (rowClass.includes('statusbad')) return false;
        if (/\b(good|up|online|ok)\b/i.test(status)) return true;
        const m2 = /([0-9]+(?:\.[0-9]+)?)%/.exec(reliability);
        if (m2) {
          try { return Number.parseFloat(m2[1]) > 0.0; } catch { return false; }
        }
        return false;
      };

      if (!looksUsable()) continue;

      const entry: FullEntry = { address, status, reliability, class: rowClass };
      const list = out.get(country) || [];
      list.push(entry);
      out.set(country, list);
    }

    return out;
  }

  // Fallback: load cheerio in Node environments
  if (!cheerio) cheerio = require('cheerio');
  const $ = cheerio.load(html);

  $('tr').each((_: any, tr: any) => {
    const $tr = $(tr as any);
    const address = collapseWs($tr.find('td#address').text() || '');
    if (!address) return;
    const prevCountry = $tr.prevAll('th#country').first();
    const country = prevCountry.length ? collapseWs(prevCountry.text()) : '(unknown)';
    const status = collapseWs($tr.find('td#status').text() || '');
    const reliability = collapseWs($tr.find('td#reliability').text() || '');
    const rowClass = ($tr.attr('class') || '').toLowerCase();

    const looksUsable = (): boolean => {
      if (rowClass.includes('statusgood')) return true;
      if (rowClass.includes('statusbad')) return false;
      if (/\b(good|up|online|ok)\b/i.test(status)) return true;
      const m2 = /([0-9]+(?:\.[0-9]+)?)%/.exec(reliability);
      if (m2) {
        try { return Number.parseFloat(m2[1]) > 0.0; } catch { return false; }
      }
      return false;
    };

    if (!looksUsable()) return;

    const entry: FullEntry = { address, status, reliability, class: rowClass };
    const list = out.get(country) || [];
    list.push(entry);
    out.set(country, list);
  });

  return out;
};

const serviceId = (addr: string): [string, string] => {
  try {
    const u = new URL(addr);
    const host = (u.hostname || '').toLowerCase();
    const params = new URLSearchParams(u.search);
    const key = (params.get('key') || '').toLowerCase();
    return [host || addr, key || ''];
  } catch {
    return [addr, ''];
  }
};

const preferSchemes = ['tls', 'quic', 'wss', 'ws', 'tcp'];
const schemeRank = (scheme: string) => {
  const s = (scheme || '').toLowerCase();
  const idx = preferSchemes.indexOf(s);
  return idx >= 0 ? idx : preferSchemes.length + 10;
};

export const dedupeAndLimitFull = (full: Map<string, FullEntry[]>, maxPerCountry = 0): Map<string, FullEntry[]> => {
  const out = new Map<string, FullEntry[]>();
  for (const [country, entries] of full.entries()) {
    const firstSeen = new Map<string, number>();
    const best = new Map<string, FullEntry>();
    entries.forEach((e, idx) => {
      const sid = serviceId(e.address);
      const key = `${sid[0]}|${sid[1]}`;
      if (!firstSeen.has(key)) firstSeen.set(key, idx);
      const cur = best.get(key);
      if (!cur) {
        best.set(key, e);
        return;
      }
      const curScheme = (() => { try { return new URL(cur.address).protocol.replace(':',''); } catch { return ''; }})();
      const newScheme = (() => { try { return new URL(e.address).protocol.replace(':',''); } catch { return ''; }})();
      if (schemeRank(newScheme) < schemeRank(curScheme)) {
        best.set(key, e);
      }
    });

    const chosen = Array.from(best.entries());
    chosen.sort((a, b) => {
      const addrA = a[1].address;
      const addrB = b[1].address;
      const schemeA = (() => { try { return new URL(addrA).protocol.replace(':',''); } catch { return ''; }})();
      const schemeB = (() => { try { return new URL(addrB).protocol.replace(':',''); } catch { return ''; }})();
      return schemeRank(schemeA) - schemeRank(schemeB) || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0);
    });

    let selected = chosen.map(([, e]) => e);
    if (maxPerCountry && maxPerCountry > 0) selected = selected.slice(0, maxPerCountry);
    out.set(country, selected);
  }
  return out;
};

export const toPeerNodes = (full: Map<string, FullEntry[]>): any[] => {
  const nodes: any[] = [];
  for (const [region, entries] of full.entries()) {
    for (const entry of entries) {
      const address = (entry.address || '').trim();
      if (!address) continue;
      let proto = '';
      try { proto = new URL(address).protocol.replace(':',''); } catch { proto = ''; }
      let host: string | null = null;
      try { host = new URL(address).hostname; } catch { host = null; }
      const ipVer = host ? (net.isIP(host) === 6 ? 'ipv6' : net.isIP(host) === 4 ? 'ipv4' : 'unknown') : 'unknown';
      nodes.push({
        address,
        protocol: proto,
        ipVersion: ipVer,
        region,
        status: entry.status || '',
        reliability: entry.reliability || '',
      });
    }
  }
  return nodes;
};

const writeJson = async (obj: unknown, outPath: string): Promise<void> => {
  await fs.promises.writeFile(outPath, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8' });
};

// Exported runUpdate: try provided URLs in order, or DEFAULT_URLS
export async function runUpdate(urls?: string[]): Promise<void> {
  const tryUrls = Array.isArray(urls) && urls.length ? urls : DEFAULT_URLS;
  let lastErr: Error | null = null;

  for (const u of tryUrls) {
    try {
      log.info(`public_nodes_updater: fetching public peers HTML from ${u}`);
      const html = await httpGetText(u, 20_000);
      const full = parsePublicPeersHtml(html);
      const deduped = dedupeAndLimitFull(full, 0);
      const nodes = toPeerNodes(deduped);

      const repoRoot = path.resolve(__dirname, '..', '..');
      const outPath = path.resolve(repoRoot, 'public_peers.json');
      await writeJson(nodes, outPath);
      log.info(`public_nodes_updater: wrote ${nodes.length} peers to ${outPath}`);
      return;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      log.warn(`public_nodes_updater: fetch from ${u} failed: ${lastErr.message}`);
      // try next URL
    }
  }

  log.warn('public_nodes_updater: all attempts failed', lastErr ? lastErr.message : 'no attempts');
}

export const startPublicNodesUpdater = (intervalHours = DEFAULT_INTERVAL_HOURS): void => {
  void runUpdate();
  const ms = Math.max(1, Number(intervalHours)) * 60 * 60 * 1000;
  setInterval(() => void runUpdate(), ms);
  log.info(`public_nodes_updater: scheduled updates every ${intervalHours} hour(s)`);
};

export default startPublicNodesUpdater;
