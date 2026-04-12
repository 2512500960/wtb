import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../main/wtb_config', () => ({
  getWtbConfig: () => ({}),
}));

import { ensureDefaultWebAssets } from '../main/web_assets';

describe('ensureDefaultWebAssets', () => {
  let webRoot: string;

  beforeEach(() => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-web-assets-'));
  });

  afterEach(() => {
    fs.rmSync(webRoot, { recursive: true, force: true });
  });

  test('keeps legacy static shell available when managed manifest exists', async () => {
    fs.writeFileSync(
      path.join(webRoot, '.wtb-content-sources.json'),
      `${JSON.stringify(
        {
          version: 2,
          entries: {
            '/movie.mp4': {
              kind: 'file',
              path: '/movie.mp4',
              sourceMode: 'ipfs-backed',
              cid: 'cid-movie',
              size: 123,
              mtimeMs: 1,
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await ensureDefaultWebAssets(
      {
        isPackaged: false,
      } as Electron.App,
      webRoot,
    );

    expect(fs.existsSync(path.join(webRoot, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'vendor', 'plyr.css'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'vendor', 'plyr.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'files'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'video'))).toBe(true);
  });

  test('seeds legacy static shell into an empty custom web directory', async () => {
    await ensureDefaultWebAssets(
      {
        isPackaged: false,
      } as Electron.App,
      webRoot,
    );

    expect(fs.existsSync(path.join(webRoot, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'vendor'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'vendor', 'plyr.css'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'vendor', 'plyr.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'files'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'video'))).toBe(true);
  });
});
