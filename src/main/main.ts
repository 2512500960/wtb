/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  dialog,
  type MessageBoxOptions,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import type { Socket } from 'net';
import { URL } from 'url';
import * as crypto from 'crypto';
import * as Hjson from 'hjson';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';
import { WEBSITE_INDEX_ED25519_PUBLIC_KEY_PEM } from './website_index_pubkey';
import {
  loadBundledPublicPeers,
  pickRandomPublicPeerAddresses,
} from './public_ygg_peers';
import {
  Libp2pGroupChatService,
  type ChatConversation,
  type ChatMessage,
  type ChatStatus,
} from './libp2p_group_chat';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    try {
      const logFilePath = log.transports.file.getFile().path;
      log.info(`electron-log file: ${logFilePath}`);
    } catch (error) {
      log.warn('Unable to determine electron-log file path', error);
    }

    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;

const isWindows = process.platform === 'win32';

type ServiceName = 'yggdrasil' | 'web' | 'ipfs';

type ServiceStatus = {
  name: ServiceName;
  state: 'running' | 'stopped';
  details?: string;
};

let yggdrasilPid: number | null = null;

let webServer: http.Server | null = null;
let webListenAddress: string | null = null;
let webListenPort: number | null = null;
const webOpenSockets = new Set<Socket>();

const YGG_WEBSITE_INDEX_DATA_URL =
  'http://[202:8467:9fa8:c35a:ef47:861d:fdbd:4f1b]:8137/index.json';

type SignedWebsiteIndexEnvelope = {
  payload?: unknown;
  payloadJson?: unknown;
  data?: unknown;
  sigB64?: unknown;
  signatureB64?: unknown;
  signature?: unknown;
  alg?: unknown;
};

const httpGetText = async (
  url: string,
  timeoutMs: number,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> => {
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
          Accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求超时'));
    });
    req.end();
  });
};

const parseSignedWebsiteIndex = (raw: string): {
  payloadText: string;
  sigB64: string;
  alg: 'ed25519';
  data: unknown;
} => {
  let env: SignedWebsiteIndexEnvelope;
  try {
    env = JSON.parse(raw) as SignedWebsiteIndexEnvelope;
  } catch {
    throw new Error('索引数据不是合法 JSON');
  }

  const sig =
    (typeof env.sigB64 === 'string' && env.sigB64) ||
    (typeof env.signatureB64 === 'string' && env.signatureB64) ||
    (typeof env.signature === 'string' && env.signature) ||
    '';
  if (!sig) throw new Error('索引数据缺少签名字段（sigB64/signatureB64/signature）');

  const algRaw = typeof env.alg === 'string' ? env.alg.toLowerCase() : '';
  const alg: 'ed25519' =
    algRaw.includes('ed25519') || algRaw.includes('ed-25519')
      ? 'ed25519'
      : 'ed25519';

  const rawPayload =
    (typeof env.payloadJson === 'string' && env.payloadJson) ||
    (typeof env.payload === 'string' && env.payload) ||
    '';
  if (!rawPayload) {
    throw new Error('索引数据缺少 payload（必须是 JSON 字符串或其 base64 编码）');
  }

  let payloadText: string | null = null;

  // 兼容两种格式：
  // 1. 旧格式：payloadJson 直接是 JSON 字符串
  // 2. 新格式：payloadJson 是 JSON 字符串的 base64 编码
  try {
    JSON.parse(rawPayload);
    payloadText = rawPayload;
  } catch {
    try {
      const decoded = Buffer.from(rawPayload, 'base64').toString('utf8');
      JSON.parse(decoded);
      payloadText = decoded;
    } catch {
      payloadText = null;
    }
  }

  if (!payloadText) {
    throw new Error('payload 不是合法 JSON 字符串或其 base64 编码');
  }

  let data: unknown;
  try {
    data = JSON.parse(payloadText) as unknown;
  } catch {
    throw new Error('payload 不是合法 JSON 字符串');
  }

  return { payloadText, sigB64: sig, alg, data };
};

const verifyWebsiteIndexSignatureOrThrow = (
  payloadText: string,
  sigB64: string,
  alg: 'ed25519',
): void => {
  if (alg !== 'ed25519') {
    throw new Error(`不支持的签名算法：${alg}`);
  }

  if (!WEBSITE_INDEX_ED25519_PUBLIC_KEY_PEM) {
    throw new Error(
      '未配置索引验签公钥（请在 src/main/website_index_pubkey.ts 中硬编码 Ed25519 公钥 PEM）',
    );
  }

  const sig = Buffer.from(sigB64, 'base64');
  const payload = Buffer.from(payloadText, 'utf8');

  const pub = crypto.createPublicKey(WEBSITE_INDEX_ED25519_PUBLIC_KEY_PEM);
  const ok = crypto.verify(null, payload, pub, sig);
  if (!ok) throw new Error('索引数据 Ed25519 签名校验失败');
};

const groupChat = new Libp2pGroupChatService((msg: ChatMessage) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:message', msg);
    }
  } catch {
    // ignore
  }
});

const requireChatRunning = (): void => {
  if (!groupChat.isRunning()) {
    throw new Error('聊天未启动（请先启动群聊服务）');
  }
};

const psSingleQuote = (value: string): string => {
  return `'${value.replace(/'/g, "''")}'`;
};

const ensureWindowsOrThrow = (): void => {
  if (!isWindows) {
    throw new Error('This app currently only supports Windows.');
  }
};

const getAppBaseDir = (): string => {
  // Store runtime state in the app's own directory (portable-friendly).
  // In packaged builds this is the folder containing the .exe.
  if (app.isPackaged) {
    return path.dirname(app.getPath('exe'));
  }

  // In dev, main bundle lives under .erb/dll, so ../../ points to repo root.
  return path.join(__dirname, '../../');
};

const canWriteDir = (dirPath: string): boolean => {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const isUnderDir = (childPath: string, parentPath: string): boolean => {
  const child = path.resolve(childPath).toLowerCase();
  const parent = path.resolve(parentPath).toLowerCase();
  return child === parent || child.startsWith(parent + path.sep);
};

const getAppDataDir = (): string => {
  // Optional override to help debugging / special packaging layouts.
  const override = process.env.WTB_DATA_DIR;
  if (override && override.trim()) return override;

  // Packaged builds can be either "installed" (Program Files) or "portable"
  // (unzipped to a user-writable folder). We want:
  // - portable: keep runtime state next to the executable (self-contained)
  // - installed: store runtime state in roaming AppData (no admin rights needed)
  if (app.isPackaged) {
    const exeDir = getAppBaseDir();
    const portableBase =
      (process.env.PORTABLE_EXECUTABLE_DIR || '').trim() || exeDir;
    const portableDataDir = path.join(portableBase, 'wtb-data');

    // electron-builder portable target sets PORTABLE_EXECUTABLE_DIR.
    if ((process.env.PORTABLE_EXECUTABLE_DIR || '').trim()) {
      return portableDataDir;
    }

    // If a wtb-data folder already exists next to the .exe, treat it as portable.
    try {
      if (fs.existsSync(portableDataDir)) {
        return portableDataDir;
      }
    } catch {
      // ignore
    }

    // Heuristic: if not running under Program Files and exe dir is writable,
    // prefer portable behavior.
    const programFiles = (process.env.ProgramFiles || '').trim();
    const programFilesX86 = (process.env['ProgramFiles(x86)'] || '').trim();
    const looksInstalled =
      (programFiles && isUnderDir(exeDir, programFiles)) ||
      (programFilesX86 && isUnderDir(exeDir, programFilesX86));

    if (!looksInstalled && canWriteDir(exeDir)) {
      return portableDataDir;
    }

    // Installed fallback: roaming AppData
    try {
      const roaming = app.getPath('appData'); // typically %APPDATA% on Windows
      if (roaming && roaming.trim()) {
        return path.join(roaming, 'wtb');
      }
    } catch {
      // fallback to portableDataDir below
    }

    // Last resort: exe directory
    return portableDataDir;
  }

  // Dev/unpackaged
  return path.join(getAppBaseDir(), 'wtb-data');
};

const getYggdrasilBaseDir = (): string => {
  // Repo currently only contains yggdrasil.exe under windows10/amd64
  if (process.arch !== 'x64') {
    throw new Error(
      `Unsupported architecture: ${process.arch}. Only Windows x64 is supported.`,
    );
  }

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'yggdrasil', 'windows10', 'amd64');
  }

  // In dev, main bundle lives under .erb/dll, so ../../ points to repo root
  // console.log(
  //   'Yggdrasil base dir:',
  //   path.join(__dirname, '../../yggdrasil/windows10/amd64'),
  // );
  return path.join(__dirname, '../../yggdrasil/windows10/amd64');
};

const getYggdrasilExePath = (): string => {
  return path.join(getYggdrasilBaseDir(), 'yggdrasil.exe');
};

const getYggdrasilCtlExePath = (): string => {
  return path.join(getYggdrasilBaseDir(), 'yggdrasilctl.exe');
};

const getYggdrasilDataDir = (): string => {
  return path.join(getAppDataDir(), 'yggdrasil');
};

const getYggdrasilConfPath = (): string => {
  return path.join(getYggdrasilDataDir(), 'yggdrasil.conf');
};

const getYggdrasilPidPath = (): string => {
  return path.join(getYggdrasilDataDir(), 'yggdrasil.pid');
};

const getYggdrasilStdoutPath = (): string => {
  return path.join(getYggdrasilDataDir(), 'yggdrasil.stdout.log');
};

const getYggdrasilStderrPath = (): string => {
  return path.join(getYggdrasilDataDir(), 'yggdrasil.stderr.log');
};

type PeArch = 'x86' | 'x64' | 'arm64' | 'unknown';

const getPeArch = (filePath: string): PeArch | null => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    if (buf.length < 0x40) return 'unknown';
    // DOS header
    if (buf[0] !== 0x4d || buf[1] !== 0x5a) return 'unknown'; // 'MZ'
    const peOffset = buf.readUInt32LE(0x3c);
    if (
      !Number.isFinite(peOffset) ||
      peOffset <= 0 ||
      peOffset + 6 >= buf.length
    )
      return 'unknown';
    // PE signature
    if (
      buf[peOffset] !== 0x50 ||
      buf[peOffset + 1] !== 0x45 ||
      buf[peOffset + 2] !== 0x00 ||
      buf[peOffset + 3] !== 0x00
    ) {
      return 'unknown';
    }
    const machine = buf.readUInt16LE(peOffset + 4);
    switch (machine) {
      case 0x014c:
        return 'x86';
      case 0x8664:
        return 'x64';
      case 0xaa64:
        return 'arm64';
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
};

const readTextFileTail = (
  filePath: string,
  maxChars: number = 2000,
): string | null => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, { encoding: 'utf8' });
    if (text.length <= maxChars) return text.trim();
    return text.slice(-maxChars).trim();
  } catch {
    return null;
  }
};

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const stripUtf8Bom = (text: string): string => {
  // Windows PowerShell `Out-File -Encoding utf8` writes UTF-8 with BOM.
  // Yggdrasil may fail to parse HJSON if a BOM is present.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

const updateYggdrasilConfPeers = (
  confPath: string,
  peersToAdd: string[],
): void => {
  if (!peersToAdd.length) return;
  const raw = stripUtf8Bom(fs.readFileSync(confPath, { encoding: 'utf8' }));
  const doc: any = (Hjson as any).rt?.parse
    ? (Hjson as any).rt.parse(raw)
    : Hjson.parse(raw);

  if (!Array.isArray(doc.Peers)) {
    doc.Peers = [];
  }

  const existing = new Set<string>(
    doc.Peers.filter((x: any) => typeof x === 'string'),
  );
  for (const addr of peersToAdd) {
    if (typeof addr !== 'string') continue;
    const trimmed = addr.trim();
    if (!trimmed) continue;
    if (existing.has(trimmed)) continue;
    doc.Peers.push(trimmed);
    existing.add(trimmed);
  }

  const out: string = (Hjson as any).rt?.stringify
    ? (Hjson as any).rt.stringify(doc, {
        quotes: 'all',
        separator: true,
        space: 2,
      })
    : Hjson.stringify(doc, { quotes: 'all', separator: true, space: 2 });

  fs.writeFileSync(confPath, stripUtf8Bom(out) + '\n', { encoding: 'utf8' });
};

const generateYggdrasilConfIfMissing = (
  yggExe: string,
  confPath: string,
): void => {
  if (fs.existsSync(confPath)) return;

  const result = spawnSync(yggExe, ['-genconf'], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    throw new Error(
      `yggdrasil -genconf 失败（exit=${result.status}）${stderr ? `: ${stderr}` : ''}`,
    );
  }

  const confText = (result.stdout || '').toString();
  if (!confText.trim()) {
    throw new Error('yggdrasil -genconf 输出为空，无法生成配置文件');
  }
  fs.writeFileSync(confPath, stripUtf8Bom(confText), { encoding: 'utf8' });

  // After generating a fresh config, inject a small random set of public peers.
  // This improves bootstrapping without requiring a manual edit.
  try {
    const baseDir = path.dirname(yggExe);
    const publicPeers = loadBundledPublicPeers(baseDir);
    const selected = pickRandomPublicPeerAddresses(publicPeers, 5);
    updateYggdrasilConfPeers(confPath, selected);
  } catch (error) {
    log.warn('Failed to inject public peers into yggdrasil.conf', error);
  }
};

const updateYggdrasilConfP2PDataDir = (
  confPath: string,
  desiredDataDir: string,
): void => {
  const raw = stripUtf8Bom(fs.readFileSync(confPath, { encoding: 'utf8' }));
  // Use Hjson round-trip mode to preserve comments/formatting as much as possible.
  const doc: any = (Hjson as any).rt?.parse
    ? (Hjson as any).rt.parse(raw)
    : Hjson.parse(raw);

  if (!doc.P2P || typeof doc.P2P !== 'object') {
    doc.P2P = {};
  }
  doc.P2P.data_dir = desiredDataDir;

  const out: string = (Hjson as any).rt?.stringify
    ? (Hjson as any).rt.stringify(doc, {
        quotes: 'all',
        separator: true,
        space: 2,
      })
    : Hjson.stringify(doc, { quotes: 'all', separator: true, space: 2 });

  fs.writeFileSync(confPath, stripUtf8Bom(out) + '\n', { encoding: 'utf8' });
};

const buildYggdrasilStartupHint = (baseDir: string): string | null => {
  const yggExe = path.join(baseDir, 'yggdrasil.exe');
  const wintunDll = path.join(baseDir, 'wintun.dll');
  const exeArch = getPeArch(yggExe);
  const dllArch = getPeArch(wintunDll);

  // The exact Windows loader error in your log corresponds to ERROR_BAD_EXE_FORMAT (193).
  // Most commonly: DLL arch mismatch (e.g. 32-bit or arm64 wintun.dll with 64-bit yggdrasil.exe).
  if (
    exeArch &&
    dllArch &&
    exeArch !== 'unknown' &&
    dllArch !== 'unknown' &&
    exeArch !== dllArch
  ) {
    return `检测到架构不匹配：yggdrasil.exe=${exeArch}, wintun.dll=${dllArch}。这会导致“%1 is not a valid Win32 application”。请替换为与 yggdrasil.exe 相同架构的 wintun.dll（当前仅支持 Windows x64）。`;
  }

  return null;
};

const runPowerShell = (
  command: string,
  options?: { ignoreStdio?: boolean },
): { stdout: string; stderr: string } => {
  ensureWindowsOrThrow();
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: options?.ignoreStdio ? 'ignore' : undefined,
    },
  );

  if (result.error) {
    throw result.error;
  }

  return {
    stdout: (result.stdout || '').toString(),
    stderr: (result.stderr || '').toString(),
  };
};

const runPowerShellAsync = (
  command: string,
  options?: { ignoreStdio?: boolean; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> => {
  ensureWindowsOrThrow();

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        windowsHide: true,
        stdio: options?.ignoreStdio ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      },
    );

    const timeoutMs = options?.timeoutMs;
    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill();
          } catch {
            // ignore
          }
          reject(new Error(`PowerShell timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    let stdout = '';
    let stderr = '';

    if (!options?.ignoreStdio) {
      child.stdout?.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, exitCode: code });
    });
  });
};

const runElevatedPowerShellAndWaitAsync = async (
  script: string,
): Promise<void> => {
  ensureWindowsOrThrow();
  // Don't use -Wait on the outer Start-Process to avoid hanging on redirected output streams.
  // Instead, the script writes state to disk (pid file) which we can poll.
  const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',${psSingleQuote(
    script,
  )})`;
  // Note: output isn't important here; the elevated script writes state (pid/logs/config) to disk.
  // We launch the elevated process and return immediately - the caller should poll for the pid file.
  await runPowerShellAsync(command, { ignoreStdio: true, timeoutMs: 30_000 });
  // Give the elevated PowerShell time to start and execute the script
  await new Promise((resolve) => setTimeout(resolve, 2000));
};

const runElevatedStartProcessAndGetPid = (
  filePath: string,
  args: string[],
  redirects?: { stdout?: string; stderr?: string },
): number => {
  ensureWindowsOrThrow();

  const psArgsArray = args.map((a) => psSingleQuote(a)).join(',');
  const stdoutRedirect = redirects?.stdout
    ? ` -RedirectStandardOutput ${psSingleQuote(redirects.stdout)}`
    : '';
  const stderrRedirect = redirects?.stderr
    ? ` -RedirectStandardError ${psSingleQuote(redirects.stderr)}`
    : '';

  const command = [
    `$p = Start-Process -FilePath ${psSingleQuote(filePath)} -Verb RunAs -ArgumentList @(${psArgsArray})${stdoutRedirect}${stderrRedirect} -PassThru;`,
    '$p.Id',
  ].join(' ');

  const { stdout, stderr } = runPowerShell(command);
  const pidText = stdout.trim().split(/\s+/).pop() ?? '';
  const pid = Number(pidText);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(
      `Failed to get elevated process pid. stdout: ${stdout} stderr: ${stderr}`,
    );
  }
  return pid;
};

const isProcessAlive = (pid: number): boolean => {
  if (!isWindows) return false;
  const command = `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'true' } else { 'false' }`;
  try {
    const { stdout } = runPowerShell(command);
    return stdout.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
};

const readYggdrasilPidFromFile = (): number | null => {
  try {
    const pidPath = getYggdrasilPidPath();
    console.log('Checking for yggdrasil PID file at:', pidPath);
    if (!fs.existsSync(pidPath)) return null;
    const pidText = fs.readFileSync(pidPath, { encoding: 'utf8' }).trim();
    const pid = Number(pidText);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
};

const startYggdrasil = async (): Promise<ServiceStatus> => {
  ensureWindowsOrThrow();

  if (yggdrasilPid && isProcessAlive(yggdrasilPid)) {
    return {
      name: 'yggdrasil',
      state: 'running',
      details: `pid=${yggdrasilPid}`,
    };
  }

  const pidFromFile = readYggdrasilPidFromFile();
  if (pidFromFile && isProcessAlive(pidFromFile)) {
    yggdrasilPid = pidFromFile;
    return {
      name: 'yggdrasil',
      state: 'running',
      details: `pid=${pidFromFile}`,
    };
  }

  const yggExe = getYggdrasilExePath();
  const baseDir = getYggdrasilBaseDir();
  const confPath = getYggdrasilConfPath();

  if (!fs.existsSync(yggExe)) {
    throw new Error(`yggdrasil.exe not found at: ${yggExe}`);
  }

  const archHint = buildYggdrasilStartupHint(baseDir);
  if (archHint) {
    throw new Error(archHint);
  }

  // Explain why we need elevation (minimum privilege: only this service).
  const msgBoxOptions: MessageBoxOptions = {
    type: 'info',
    buttons: ['取消', '继续'],
    defaultId: 1,
    cancelId: 0,
    title: '需要管理员权限',
    message: '启动 Yggdrasil 需要管理员权限。',
    detail:
      '需要管理员权限来创建 TUN 网卡，并启动 Yggdrasil 服务。\n\n点击“继续”后将弹出 Windows UAC 提示。',
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, msgBoxOptions)
    : await dialog.showMessageBox(msgBoxOptions);
  if (response !== 1) {
    return {
      name: 'yggdrasil',
      state: 'stopped',
      details: '已取消管理员权限请求',
    };
  }

  // Generate config + start yggdrasil from an elevated PowerShell, writing state into the app directory.
  const dataDir = getYggdrasilDataDir();
  const p2pDataDir = path.join(dataDir, 'datasource');
  const pidPath = getYggdrasilPidPath();
  const stdoutPath = getYggdrasilStdoutPath();
  const stderrPath = getYggdrasilStderrPath();

  // Ensure local state directory + config exist (no elevation needed).
  ensureDir(dataDir);
  ensureDir(p2pDataDir);
  generateYggdrasilConfIfMissing(yggExe, confPath);
  // Use forward slashes to keep HJSON path portable and avoid escape issues.
  updateYggdrasilConfP2PDataDir(confPath, p2pDataDir.replace(/\\/g, '/'));

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `New-Item -ItemType Directory -Force -Path ${psSingleQuote(dataDir)} | Out-Null`,
    `$p = Start-Process -FilePath ${psSingleQuote(yggExe)} -ArgumentList @('-useconffile',${psSingleQuote(
      confPath,
    )}) -WorkingDirectory ${psSingleQuote(baseDir)} -RedirectStandardOutput ${psSingleQuote(
      stdoutPath,
    )} -RedirectStandardError ${psSingleQuote(
      stderrPath,
    )} -PassThru -WindowStyle Hidden`,
    `$p.Id | Out-File -FilePath ${psSingleQuote(pidPath)} -Encoding ascii`,
  ].join('; ');

  await runElevatedPowerShellAndWaitAsync(script);
  log.info(getAppDataDir());
  log.info('yggdrasil start requested (elevated on-demand).');

  // Poll for the PID file to be created (may take time due to TUN adapter setup)
  let pid: number | null = null;
  const maxRetries = 30; // Wait up to 30 seconds
  for (let i = 0; i < maxRetries; i++) {
    pid = readYggdrasilPidFromFile();
    if (pid && isProcessAlive(pid)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!pid || !isProcessAlive(pid)) {
    const stderrTail = readTextFileTail(getYggdrasilStderrPath());
    const commonHint = stderrTail?.includes('wintun.dll')
      ? '看起来是 wintun.dll 加载失败（常见原因：DLL 架构不匹配）。'
      : undefined;
    throw new Error(
      [
        'yggdrasil 启动失败：未能获取有效 PID（可能被 UAC 取消或启动异常）',
        commonHint,
        stderrTail ? `yggdrasil.stderr.log（末尾）:\n${stderrTail}` : undefined,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  yggdrasilPid = pid;
  log.info(`yggdrasil started (elevated on-demand). pid=${pid}`);
  return { name: 'yggdrasil', state: 'running', details: `pid=${pid}` };
};

const stopYggdrasil = async (): Promise<ServiceStatus> => {
  ensureWindowsOrThrow();

  // Don't prompt on app quit; only stop when explicitly requested.
  const pid = yggdrasilPid ?? readYggdrasilPidFromFile();
  if (!pid) {
    return { name: 'yggdrasil', state: 'stopped' };
  }

  const msgBoxOptions: MessageBoxOptions = {
    type: 'warning',
    buttons: ['取消', '继续'],
    defaultId: 1,
    cancelId: 0,
    title: '需要管理员权限',
    message: '停止 Yggdrasil 需要管理员权限。',
    detail:
      '需要管理员权限来停止已启动的 Yggdrasil 进程。\n\n点击“继续”后将弹出 Windows UAC 提示。',
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, msgBoxOptions)
    : await dialog.showMessageBox(msgBoxOptions);
  if (response !== 1) {
    return { name: 'yggdrasil', state: 'running', details: `pid=${pid}` };
  }

  const pidPath = getYggdrasilPidPath();
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `if (Test-Path -LiteralPath ${psSingleQuote(pidPath)}) { $pidText = Get-Content -LiteralPath ${psSingleQuote(
      pidPath,
    )} -ErrorAction SilentlyContinue; $pidValue = [int]$pidText; Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ${psSingleQuote(
      pidPath,
    )} -Force -ErrorAction SilentlyContinue }`,
  ].join('; ');

  await runElevatedPowerShellAndWaitAsync(script);

  // Wait a moment for the process to stop and PID file to be deleted
  await new Promise((resolve) => setTimeout(resolve, 1000));

  yggdrasilPid = null;
  log.info(`yggdrasil stop requested. pid=${pid}`);
  return { name: 'yggdrasil', state: 'stopped' };
};

// Attempt to stop yggdrasil without prompting the user (used on app quit).
// This will try a non-elevated Stop-Process and remove the pid file; if
// the process remains (likely because it was started elevated), we leave
// it running to avoid triggering a UAC prompt during quit.
const stopYggdrasilSilent = async (): Promise<void> => {
  try {
    const pid = yggdrasilPid ?? readYggdrasilPidFromFile();
    if (!pid) return;

    const pidPath = getYggdrasilPidPath();

    try {
      const command = `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue }`;
      runPowerShell(command);
    } catch (err) {
      // ignore; best-effort
    }
    // Wait briefly for the process to exit
    for (let i = 0; i < 6; i++) {
      if (!isProcessAlive(pid)) break;
      // 250ms * 6 = 1.5s total wait
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!isProcessAlive(pid)) {
      // Only remove the pid file if the process has actually exited. If the
      // process is still running (likely elevated), leave the pid file in place
      // so subsequent app launches can detect the running service.
      try {
        if (fs.existsSync(pidPath)) {
          fs.unlinkSync(pidPath);
        }
      } catch {
        // ignore best-effort cleanup errors
      }

      yggdrasilPid = null;
      log.info(`yggdrasil stopped silently. pid=${pid}`);
    } else {
      log.info(`yggdrasil still running after silent stop attempt. pid=${pid}`);
    }
  } catch (err) {
    log.warn('Failed to silently stop yggdrasil on quit', err);
  }
};

const getYggdrasilStatus = (): ServiceStatus => {
  if (!isWindows)
    return {
      name: 'yggdrasil',
      state: 'stopped',
      details: 'unsupported platform',
    };
  if (!yggdrasilPid) {
    const pidFromFile = readYggdrasilPidFromFile();
    if (pidFromFile && isProcessAlive(pidFromFile)) {
      yggdrasilPid = pidFromFile;
      return {
        name: 'yggdrasil',
        state: 'running',
        details: `pid=${pidFromFile}`,
      };
    }
    return { name: 'yggdrasil', state: 'stopped' };
  }
  if (isProcessAlive(yggdrasilPid)) {
    return {
      name: 'yggdrasil',
      state: 'running',
      details: `pid=${yggdrasilPid}`,
    };
  }
  yggdrasilPid = null;
  return { name: 'yggdrasil', state: 'stopped' };
};

const getAllServiceStatuses = (): ServiceStatus[] => {
  const ygg = getYggdrasilStatus();
  const lockedDetails =
    ygg.state === 'running' ? undefined : '需要先启动 Yggdrasil 服务';
  return [
    ygg,
    {
      name: 'ipfs',
      state: 'stopped',
      details: lockedDetails ?? 'not implemented yet',
    },
    (() => {
      const web = getWebStatus();
      if (web.state === 'running') return web;
      return {
        name: 'web',
        state: 'stopped',
        details: lockedDetails ?? undefined,
      };
    })(),
  ];
};

type YggdrasilCtlCommand =
  | 'getself'
  | 'getpeers'
  | 'getsessions'
  | 'getpaths'
  | 'gettree'
  | 'gettun'
  | 'getp2ppeers'
  | 'getmulticastinterfaces'
  | 'list';

type YggdrasilCtlResult = {
  ok: boolean;
  command: YggdrasilCtlCommand;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

const yggdrasilCtlAllowedCommands: ReadonlySet<string> = new Set<string>([
  'getself',
  'getpeers',
  'getsessions',
  'getpaths',
  'gettree',
  'gettun',
  'getp2ppeers',
  'getmulticastinterfaces',
  'list',
]);

const runYggdrasilCtl = async (
  command: YggdrasilCtlCommand,
  timeoutMs: number = 5000,
): Promise<YggdrasilCtlResult> => {
  ensureWindowsOrThrow();

  if (!yggdrasilCtlAllowedCommands.has(command)) {
    throw new Error(`Unsupported yggdrasilctl command: ${command}`);
  }

  const exePath = getYggdrasilCtlExePath();
  if (!fs.existsSync(exePath)) {
    throw new Error(`yggdrasilctl.exe not found at: ${exePath}`);
  }

  const start = Date.now();
  // yggdrasilctl supports JSON output via `-json`, and options MUST come before the command.
  const args = ['-json', command];

  return await new Promise<YggdrasilCtlResult>((resolve, reject) => {
    const child = spawn(exePath, args, {
      windowsHide: true,
      cwd: getYggdrasilBaseDir(),
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout?.on('data', (buf) => {
      stdout += buf.toString('utf8');
    });
    child.stderr?.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const exitCode = typeof code === 'number' ? code : null;
      const ok = exitCode === 0;

      resolve({
        ok,
        command,
        exitCode,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        durationMs,
      });
    });
  });
};

const getWebPort = (): number => {
  const raw = (process.env.WTB_WEB_PORT || '').trim();
  if (!raw) return 8137;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid WTB_WEB_PORT: ${raw}`);
  }
  return parsed;
};

const parseYggdrasilIPv6FromGetself = (stdout: string): string | null => {
  const text = (stdout || '').trim();
  // console.log('parseYggdrasilIPv6FromGetself raw output:', text);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      // Prefer explicit `address` field if present
      const address = (parsed as any).address;
      if (typeof address === 'string' && address.includes(':')) {
        return address.trim();
      }

      // Some outputs place the address under `self.address`
      const selfAddress = (parsed as any).self?.address;
      if (typeof selfAddress === 'string' && selfAddress.includes(':')) {
        return selfAddress.trim();
      }

      // Fall back to subnet (take the part before a slash if present)
      const subnet = (parsed as any).subnet;
      if (typeof subnet === 'string') {
        const maybe = subnet.split('/')[0].trim();
        if (maybe.includes(':')) return maybe;
      }
    }
  } catch {
    // ignore; fall through to regex
  }

  // Generic IPv6-like pattern: at least three colon-separated hex groups
  const match = text.match(/\b([0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){2,})\b/);
  return match?.[1] ?? null;
};

export async function getYggdrasilIPv6AddressOrThrow(): Promise<string> {
  // 通过 yggdrasilctl getself 获取 IPv6 地址，并在启动初期进行多次重试，
  // 确保“启动完成”的判断基于地址可用而不仅仅是进程存在。
  const maxAttempts = 10;
  const delayMs = 1000;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await runYggdrasilCtl('getself', 3000);
      if (!result.ok) {
        const msg = (result.stderr || result.stdout || '').trim();
        lastError = new Error(
          `Failed to query Yggdrasil self address${msg ? `: ${msg}` : ''}`,
        );
      } else {
        const addr = parseYggdrasilIPv6FromGetself(result.stdout);
        if (addr) {
          return addr;
        }
        lastError = new Error(
          'Unable to parse Yggdrasil IPv6 address from yggdrasilctl getself output.',
        );
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    // 如果还没到最后一次尝试，则等待一段时间后重试
    if (attempt < maxAttempts - 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Failed to obtain Yggdrasil IPv6 address.');
};

function getWebStatus(): ServiceStatus {
  if (webServer && webServer.listening && webListenAddress && webListenPort) {
    return {
      name: 'web',
      state: 'running',
      details: `http://[${webListenAddress}]:${webListenPort}`,
    };
  }
  return { name: 'web', state: 'stopped' };
}

const getWebRootDir = (): string => {
  return path.join(getAppDataDir(), 'web');
};

const escapeHtml = (input: string): string => {
  return (input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let idx = -1;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 1 : 2)} ${units[idx]}`;
};

const guessContentType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.txt':
    case '.log':
    case '.md':
    case '.ini':
    case '.conf':
    case '.yaml':
    case '.yml':
      return 'text/plain; charset=utf-8';
    case '.xml':
      return 'application/xml; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
      return 'audio/ogg';
    case '.pdf':
      return 'application/pdf';
    case '.zip':
      return 'application/zip';
    case '.7z':
      return 'application/x-7z-compressed';
    case '.gz':
      return 'application/gzip';
    case '.tar':
      return 'application/x-tar';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
};

const parseAndNormalizeUrlPath = (rawUrl: string | undefined): string => {
  const url = new URL(rawUrl || '/', 'http://localhost');
  // Decode percent-encoded path; reject invalid encoding.
  let decodedPath = url.pathname;
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    throw new Error('Bad Request');
  }

  // Normalize using posix semantics (URLs always use '/').
  const normalized = path.posix.normalize(decodedPath);
  // Ensure leading slash.
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  // Block traversal.
  if (withSlash === '/..' || withSlash.startsWith('/../')) {
    throw new Error('Forbidden');
  }
  return withSlash;
};

const urlPathToFsPath = (rootDir: string, urlPath: string): string => {
  const rel = urlPath.replace(/^\/+/, '');
  // Convert URL path segments to platform path safely.
  const segments = rel.split('/').filter(Boolean);
  return path.join(rootDir, ...segments);
};

const ensureDirExists = (dirPath: string): void => {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    // If it exists already, ignore; otherwise surface.
    if (!fs.existsSync(dirPath)) throw e;
  }
};

const renderDirectoryIndexHtml = (opts: {
  urlPath: string;
  entries: Array<{
    name: string;
    isDir: boolean;
    size: number;
    mtimeMs: number;
  }>;
}): string => {
  const { urlPath, entries } = opts;
  const title = `Index of ${urlPath}`;
  const safeTitle = escapeHtml(title);

  const parts = urlPath.split('/').filter(Boolean);
  const crumbs: string[] = ['<a href="/">/</a>'];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    const href = `${acc}/`;
    crumbs.push(`<a href="${href}">${escapeHtml(part)}/</a>`);
  }

  const rows: string[] = [];
  if (urlPath !== '/') {
    const up =
      urlPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '';
    const parentHref = `${up}/` || '/';
    rows.push(
      `<tr><td><a href="${parentHref}">..</a></td><td class="meta">-</td><td class="meta">-</td></tr>`,
    );
  }

  for (const e of entries) {
    const suffix = e.isDir ? '/' : '';
    const href = `${urlPath}${encodeURIComponent(e.name)}${suffix}`;
    const displayName = escapeHtml(e.name + suffix);
    const mtime = e.mtimeMs ? new Date(e.mtimeMs).toLocaleString() : '-';
    const size = e.isDir ? '-' : formatBytes(e.size);
    rows.push(
      `<tr><td><a href="${href}">${displayName}</a></td><td class="meta">${escapeHtml(
        String(mtime),
      )}</td><td class="meta">${escapeHtml(String(size))}</td></tr>`,
    );
  }

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 16px; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      .crumbs { margin: 0 0 12px; color: #444; }
      table { border-collapse: collapse; width: 100%; }
      th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
      th { font-weight: 600; color: #333; }
      a { color: #0b57d0; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .meta { white-space: nowrap; color: #555; font-variant-numeric: tabular-nums; }
      .footer { margin-top: 16px; color: #777; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>${safeTitle}</h1>
    <div class="crumbs">${crumbs.join(' ')}</div>
    <table>
      <thead>
        <tr><th>名称</th><th class="meta">修改时间</th><th class="meta">大小</th></tr>
      </thead>
      <tbody>
        ${rows.join('\n')}
      </tbody>
    </table>
    <div class="footer">WTB Web 索引（目录：wtb-data/web）</div>
  </body>
</html>`;
};

const startWebService = async (): Promise<ServiceStatus> => {
  ensureWindowsOrThrow();
  const existing = getWebStatus();
  if (existing.state === 'running') return existing;

  const ygg = getYggdrasilStatus();
  if (ygg.state !== 'running') {
    throw new Error('需要先启动 Yggdrasil 服务才能启动 Web 服务。');
  }

  const host = await getYggdrasilIPv6AddressOrThrow();
  const port = getWebPort();

  const webRoot = getWebRootDir();
  ensureDirExists(webRoot);

  const server = http.createServer((req, res) => {
    try {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Method Not Allowed');
        return;
      }

      const urlPath = parseAndNormalizeUrlPath(req.url);

      if (urlPath === '/health') {
        const body = JSON.stringify({
          ok: true,
          service: 'web',
          time: new Date().toISOString(),
          root: webRoot,
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(method === 'HEAD' ? undefined : body);
        return;
      }

      // Ensure directory paths end with a slash to keep relative links consistent.
      const fsPath = urlPathToFsPath(webRoot, urlPath);
      if (!isUnderDir(fsPath, webRoot)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Forbidden');
        return;
      }

      let st: fs.Stats;
      try {
        st = fs.statSync(fsPath);
      } catch {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not Found');
        return;
      }

      if (st.isDirectory()) {
        if (!urlPath.endsWith('/')) {
          res.statusCode = 301;
          res.setHeader('Location', `${urlPath}/`);
          res.end();
          return;
        }

        const dirents = fs.readdirSync(fsPath, { withFileTypes: true });
        const entries = dirents
          .map((d) => {
            const childPath = path.join(fsPath, d.name);
            let childSt: fs.Stats | null = null;
            try {
              childSt = fs.statSync(childPath);
            } catch {
              childSt = null;
            }
            return {
              name: d.name,
              isDir: d.isDirectory(),
              size: childSt?.isFile() ? childSt.size : 0,
              mtimeMs: childSt?.mtimeMs ?? 0,
            };
          })
          .sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name, 'zh-CN', {
              numeric: true,
              sensitivity: 'base',
            });
          });

        const html = renderDirectoryIndexHtml({ urlPath, entries });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(method === 'HEAD' ? undefined : html);
        return;
      }

      if (st.isFile()) {
        res.statusCode = 200;
        res.setHeader('Content-Type', guessContentType(fsPath));
        res.setHeader('Content-Length', String(st.size));
        res.setHeader('Last-Modified', st.mtime.toUTCString());
        if (method === 'HEAD') {
          res.end();
          return;
        }
        const stream = fs.createReadStream(fsPath);
        stream.on('error', () => {
          try {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Internal Server Error');
          } catch {
            // ignore
          }
        });
        stream.pipe(res);
        return;
      }

      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found');
    } catch {
      try {
        res.statusCode = 500;
        res.end('Internal Server Error');
      } catch {
        // ignore
      }
    }
  });

  // Track open sockets so we can force-stop even if clients keep connections alive.
  server.on('connection', (socket: Socket) => {
    webOpenSockets.add(socket);
    socket.on('close', () => webOpenSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, () => resolve());
  });

  webServer = server;
  webListenAddress = host;
  webListenPort = port;
  log.info(`web service listening on http://[${host}]:${port}`);
  return getWebStatus();
};

const stopWebService = async (): Promise<ServiceStatus> => {
  const server = webServer;
  if (!server) return { name: 'web', state: 'stopped' };

  // Force-close existing keep-alive connections (e.g. browsers) to let server.close() finish.
  for (const socket of Array.from(webOpenSockets)) {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }
  webOpenSockets.clear();

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    try {
      server.close(() => finish());
    } catch {
      finish();
      return;
    }

    // Safety timeout: should be quick after destroying sockets, but don't hang forever.
    setTimeout(() => finish(), 1500);
  });

  webServer = null;
  webListenAddress = null;
  webListenPort = null;
  log.info('web service stopped');
  return { name: 'web', state: 'stopped' };
};

ipcMain.handle('services:getAll', async () => {
  return getAllServiceStatuses();
});

ipcMain.handle('services:start', async (_event, serviceName: ServiceName) => {
  try {
    if (serviceName === 'yggdrasil') {
      return await startYggdrasil();
    }

    if (serviceName === 'web') {
      return await startWebService();
    }

    const ygg = getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(`Yggdrasil 未运行，无法启动 ${serviceName} 服务。`);
    }

    throw new Error(`${serviceName} service start is not implemented yet.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Failed to start service ${serviceName}:`, error);
    return {
      name: serviceName,
      state: 'stopped',
      details: message,
    } satisfies ServiceStatus;
  }
});

ipcMain.handle('services:stop', async (_event, serviceName: ServiceName) => {
  try {
    if (serviceName === 'yggdrasil') {
      return await stopYggdrasil();
    }

    if (serviceName === 'web') {
      return await stopWebService();
    }

    const ygg = getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(`Yggdrasil 未运行，无法停止 ${serviceName} 服务。`);
    }
    throw new Error(`${serviceName} service stop is not implemented yet.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Failed to stop service ${serviceName}:`, error);
    return {
      name: serviceName,
      state: 'stopped',
      details: message,
    } satisfies ServiceStatus;
  }
});

ipcMain.handle('services:openDir', async (_event, serviceName: ServiceName) => {
  try {
    if (serviceName === 'web') {
      const dirPath = getWebRootDir();
      ensureDirExists(dirPath);
      await shell.openPath(dirPath);
      return { ok: true, path: dirPath };
    }

    return { ok: false, error: `openDir not supported for ${serviceName}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`services:openDir failed: ${serviceName}`, error);
    return { ok: false, error: message };
  }
});

ipcMain.handle('chat:status', async () => {
  return groupChat.status() satisfies ChatStatus;
});

ipcMain.handle('chat:identity:get', async () => {
  return groupChat.status() satisfies ChatStatus;
});

ipcMain.handle(
  'chat:identity:setDisplayName',
  async (_event, displayName: string) => {
    groupChat.setDisplayName(displayName);
    return groupChat.status() satisfies ChatStatus;
  },
);

ipcMain.handle('chat:start', async () => {
  const ygg = getYggdrasilStatus();
  if (ygg.state !== 'running') {
    throw new Error(
      'Yggdrasil 未运行，无法启动群聊。请先在首页启动 Yggdrasil。',
    );
  }

  return await groupChat.start();
});

ipcMain.handle('chat:stop', async () => {
  return await groupChat.stop();
});

ipcMain.handle('chat:dial', async (_event, ma: string) => {
  const ygg = getYggdrasilStatus();
  if (ygg.state !== 'running') {
    throw new Error(
      'Yggdrasil 未运行，无法连接 peer。请先在首页启动 Yggdrasil。',
    );
  }

  return await groupChat.dial(ma);
});

ipcMain.handle('chat:subscribe', async (_event, topic: string) => {
  const ygg = getYggdrasilStatus();
  if (ygg.state !== 'running') {
    throw new Error(
      'Yggdrasil 未运行，无法订阅 topic。请先在首页启动 Yggdrasil。',
    );
  }

  return await groupChat.subscribe(topic);
});

ipcMain.handle(
  'chat:publish',
  async (_event, payload: { topic: string; message: string }) => {
    const ygg = getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(
        'Yggdrasil 未运行，无法发送消息。请先在首页启动 Yggdrasil。',
      );
    }

    await groupChat.publish(payload?.topic, payload?.message);
    return { ok: true };
  },
);

ipcMain.handle('chat:conversations:list', async () => {
  return groupChat.listConversations() satisfies ChatConversation[];
});

ipcMain.handle(
  'chat:conversation:load',
  async (_event, convId: string, limit?: number) => {
    return groupChat.loadMessages(
      convId,
      typeof limit === 'number' ? limit : 200,
    ) satisfies ChatMessage[];
  },
);

ipcMain.handle('chat:conversation:markRead', async (_event, convId: string) => {
  groupChat.markRead(convId);
  return { ok: true };
});

ipcMain.handle(
  'chat:conversation:createGroup',
  async (_event, title: string) => {
    const ygg = getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(
        'Yggdrasil 未运行，无法创建群组。请先在首页启动 Yggdrasil 并启动群聊。',
      );
    }

    requireChatRunning();
    return groupChat.createGroup(title) satisfies ChatConversation;
  },
);

ipcMain.handle(
  'chat:conversation:joinGroup',
  async (_event, input: { groupId: string; title: string }) => {
    const ygg = getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(
        'Yggdrasil 未运行，无法加入群组。请先在首页启动 Yggdrasil 并启动群聊。',
      );
    }

    requireChatRunning();
    return groupChat.joinGroup(input) satisfies ChatConversation;
  },
);

ipcMain.handle(
  'chat:conversation:startDm',
  async (
    _event,
    input: {
      peerId: string;
      title?: string;
      peerEncPublicKeyDerB64: string;
      peerSignPublicKeyDerB64: string;
    },
  ) => {
    const ygg = getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(
        'Yggdrasil 未运行，无法创建私聊。请先在首页启动 Yggdrasil 并启动群聊。',
      );
    }

    requireChatRunning();
    return groupChat.startDm(input) satisfies ChatConversation;
  },
);

ipcMain.handle(
  'chat:message:send',
  async (_event, convId: string, text: string) => {
    const ygg = getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(
        'Yggdrasil 未运行，无法发送消息。请先在首页启动 Yggdrasil。',
      );
    }

    requireChatRunning();
    await groupChat.sendMessage(convId, text);
    return { ok: true };
  },
);

ipcMain.handle(
  'yggdrasilctl:run',
  async (_event, command: YggdrasilCtlCommand) => {
    try {
      // Most commands require Yggdrasil to be running; surfacing a friendly error helps UX.
      const ygg = getYggdrasilStatus();
      if (command !== 'list' && ygg.state !== 'running') {
        throw new Error(
          'Yggdrasil 未运行，无法获取状态。请先在首页启动 Yggdrasil。',
        );
      }

      return await runYggdrasilCtl(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`yggdrasilctl failed: command=${command}`, error);
      return {
        ok: false,
        command,
        exitCode: null,
        stdout: '',
        stderr: message,
        durationMs: 0,
      } satisfies YggdrasilCtlResult;
    }
  },
);

ipcMain.handle('ygg:getIPv6', async () => {
  const ygg = getYggdrasilStatus();
  if (ygg.state !== 'running') {
    throw new Error('Yggdrasil 未运行，无法获取 IPv6 地址。');
  }

  const addr = await getYggdrasilIPv6AddressOrThrow();
  return addr;
});

ipcMain.handle('ygg:index:load', async () => {
  const ygg = getYggdrasilStatus();
  if (ygg.state !== 'running') {
    throw new Error('Yggdrasil 未运行，无法加载网站索引。请先在首页启动 Yggdrasil。');
  }

  let parsed: URL;
  try {
    parsed = new URL(YGG_WEBSITE_INDEX_DATA_URL);
  } catch {
    throw new Error('索引 URL 配置无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('索引 URL 仅支持 http/https');
  }

  const res = await httpGetText(parsed.toString(), 15000);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`索引请求失败：HTTP ${res.statusCode}`);
  }

  const { payloadText, sigB64, alg, data } = parseSignedWebsiteIndex(res.body);
  verifyWebsiteIndexSignatureOrThrow(payloadText, sigB64, alg);

  return {
    ok: true,
    verified: true,
    sourceUrl: parsed.toString(),
    data,
  };
});

// Open a URL via the system default browser (preferred for slow/unreliable links)
ipcMain.handle('open-external', async (_event, url: string) => {
  try {
    if (!url || typeof url !== 'string') return;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }

    // Only allow http(s) to avoid accidentally opening unsafe schemes.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return;
    }

    await shell.openExternal(parsed.toString());
  } catch (err) {
    log.warn('open-external failed', err);
  }
});

// Open a URL inside a new Electron BrowserWindow (in-app webview)
ipcMain.handle('open-in-app', async (_event, url: string) => {
  try {
    if (!url || typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) {
      return;
    }

    const child = new BrowserWindow({
      width: 1000,
      height: 700,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    child.webContents.on('context-menu', (_event, params) => {
      try {
        const hasSelection = (params.selectionText || '').trim().length > 0;
        const isEditable = !!params.isEditable;

        const template = isEditable
          ? [
              { role: 'cut' as const, enabled: hasSelection },
              { role: 'copy' as const, enabled: hasSelection },
              { role: 'paste' as const },
              { type: 'separator' as const },
              { role: 'selectAll' as const },
            ]
          : [
              { role: 'copy' as const, enabled: hasSelection },
              { role: 'selectAll' as const },
            ];

        Menu.buildFromTemplate(template).popup({ window: child });
      } catch {
        // ignore
      }
    });

    child.once('ready-to-show', () => child.show());

    child.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: 'deny' };
    });

    await child.loadURL(url);
  } catch (err) {
    log.warn('open-in-app failed', err);
  }
});

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug').default();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  // Enable right-click context menu (e.g. Copy for selected text).
  mainWindow.webContents.on('context-menu', (_event, params) => {
    try {
      const hasSelection = (params.selectionText || '').trim().length > 0;
      const isEditable = !!params.isEditable;

      const template = isEditable
        ? [
            { role: 'cut' as const, enabled: hasSelection },
            { role: 'copy' as const, enabled: hasSelection },
            { role: 'paste' as const },
            { type: 'separator' as const },
            { role: 'selectAll' as const },
          ]
        : [
            { role: 'copy' as const, enabled: hasSelection },
            { role: 'selectAll' as const },
          ];

      Menu.buildFromTemplate(template).popup({ window: mainWindow! });
    } catch {
      // ignore
    }
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

/**
 * Add event listeners...
 */

app.on('before-quit', () => {
  try {
    if (webServer) {
      for (const socket of Array.from(webOpenSockets)) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      webOpenSockets.clear();
      webServer.close();
    }
  } catch {
    // ignore
  }

  // Stop libp2p group chat best-effort on quit
  groupChat.stop().catch(() => {
    // ignore
  });

  // Try to stop yggdrasil silently on quit (best-effort; avoids UAC prompt).
  // Do not await here to avoid delaying app shutdown, but initiate the attempt.
  stopYggdrasilSilent().catch(() => {
    // best-effort; ignore errors during quit
  });
});

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(() => {
    createWindow();
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
