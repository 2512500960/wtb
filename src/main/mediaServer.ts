import fs from 'fs';
import path from 'path';

export function ensureMediaDirs(webRoot: string) {
  fs.mkdirSync(webRoot, { recursive: true });
  fs.mkdirSync(path.join(webRoot, 'video'), { recursive: true });
  fs.mkdirSync(path.join(webRoot, 'files'), { recursive: true });
}

export default {
  ensureMediaDirs,
};
