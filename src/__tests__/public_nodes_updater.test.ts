import fs from 'fs';
import path from 'path';
import { runUpdate } from '../main/public_nodes_updater';

describe('public_nodes_updater integration', () => {
  test('fetches real public peers and writes public_peers.json', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const outPath = path.resolve(repoRoot, 'public_peers.json');

    // Try two URLs in order: primary and optional fallback from env
    const urls = [process.env.PUBLIC_PEERS_URL || 'https://publicpeers.neilalexander.dev/'];
    if (process.env.PUBLIC_PEERS_FALLBACK_URL) urls.push(process.env.PUBLIC_PEERS_FALLBACK_URL);

    // Run update (will fetch and write file)
    await runUpdate(urls);

    // Verify file exists and contains an array of nodes
    expect(fs.existsSync(outPath)).toBe(true);
    const raw = await fs.promises.readFile(outPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  }, 30000);
});
