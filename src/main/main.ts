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
import { app, BrowserWindow, shell, ipcMain, dialog, type MessageBoxOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import * as Hjson from 'hjson';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';
import { loadBundledPublicPeers, pickRandomPublicPeerAddresses } from './public_ygg_peers';

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

type ServiceName = 'yggdrasil' | 'ipfs' | 'web';

type ServiceStatus = {
  name: ServiceName;
  state: 'running' | 'stopped';
  details?: string;
};

let yggdrasilPid: number | null = null;

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

const getAppDataDir = (): string => {
  // Optional override to help debugging / special packaging layouts.
  const override = process.env.WTB_DATA_DIR;
  if (override && override.trim()) return override;
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
    if (!Number.isFinite(peOffset) || peOffset <= 0 || peOffset + 6 >= buf.length) return 'unknown';
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

const readTextFileTail = (filePath: string, maxChars: number = 2000): string | null => {
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

const updateYggdrasilConfPeers = (confPath: string, peersToAdd: string[]): void => {
  if (!peersToAdd.length) return;
  const raw = stripUtf8Bom(fs.readFileSync(confPath, { encoding: 'utf8' }));
  const doc: any = (Hjson as any).rt?.parse ? (Hjson as any).rt.parse(raw) : Hjson.parse(raw);

  if (!Array.isArray(doc.Peers)) {
    doc.Peers = [];
  }

  const existing = new Set<string>(doc.Peers.filter((x: any) => typeof x === 'string'));
  for (const addr of peersToAdd) {
    if (typeof addr !== 'string') continue;
    const trimmed = addr.trim();
    if (!trimmed) continue;
    if (existing.has(trimmed)) continue;
    doc.Peers.push(trimmed);
    existing.add(trimmed);
  }

  const out: string = (Hjson as any).rt?.stringify
    ? (Hjson as any).rt.stringify(doc, { quotes: 'all', separator: true, space: 2 })
    : Hjson.stringify(doc, { quotes: 'all', separator: true, space: 2 });

  fs.writeFileSync(confPath, stripUtf8Bom(out) + '\n', { encoding: 'utf8' });
};

const generateYggdrasilConfIfMissing = (yggExe: string, confPath: string): void => {
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
    throw new Error(`yggdrasil -genconf 失败（exit=${result.status}）${stderr ? `: ${stderr}` : ''}`);
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

const updateYggdrasilConfP2PDataDir = (confPath: string, desiredDataDir: string): void => {
  const raw = stripUtf8Bom(fs.readFileSync(confPath, { encoding: 'utf8' }));
  // Use Hjson round-trip mode to preserve comments/formatting as much as possible.
  const doc: any = (Hjson as any).rt?.parse ? (Hjson as any).rt.parse(raw) : Hjson.parse(raw);

  if (!doc.P2P || typeof doc.P2P !== 'object') {
    doc.P2P = {};
  }
  doc.P2P.data_dir = desiredDataDir;

  const out: string = (Hjson as any).rt?.stringify
    ? (Hjson as any).rt.stringify(doc, { quotes: 'all', separator: true, space: 2 })
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
  if (exeArch && dllArch && exeArch !== 'unknown' && dllArch !== 'unknown' && exeArch !== dllArch) {
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

const runElevatedPowerShellAndWaitAsync = async (script: string): Promise<void> => {
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
    throw new Error(`Failed to get elevated process pid. stdout: ${stdout} stderr: ${stderr}`);
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
    return { name: 'yggdrasil', state: 'running', details: `pid=${yggdrasilPid}` };
  }

  const pidFromFile = readYggdrasilPidFromFile();
  if (pidFromFile && isProcessAlive(pidFromFile)) {
    yggdrasilPid = pidFromFile;
    return { name: 'yggdrasil', state: 'running', details: `pid=${pidFromFile}` };
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
    detail: '需要管理员权限来创建 TUN 网卡，并启动 Yggdrasil 服务。\n\n点击“继续”后将弹出 Windows UAC 提示。',
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, msgBoxOptions)
    : await dialog.showMessageBox(msgBoxOptions);
  if (response !== 1) {
    return { name: 'yggdrasil', state: 'stopped', details: '已取消管理员权限请求' };
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
    detail: '需要管理员权限来停止已启动的 Yggdrasil 进程。\n\n点击“继续”后将弹出 Windows UAC 提示。',
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

const getYggdrasilStatus = (): ServiceStatus => {
  if (!isWindows) return { name: 'yggdrasil', state: 'stopped', details: 'unsupported platform' };
  if (!yggdrasilPid) {
    const pidFromFile = readYggdrasilPidFromFile();
    if (pidFromFile && isProcessAlive(pidFromFile)) {
      yggdrasilPid = pidFromFile;
      return { name: 'yggdrasil', state: 'running', details: `pid=${pidFromFile}` };
    }
    return { name: 'yggdrasil', state: 'stopped' };
  }
  if (isProcessAlive(yggdrasilPid)) {
    return { name: 'yggdrasil', state: 'running', details: `pid=${yggdrasilPid}` };
  }
  yggdrasilPid = null;
  return { name: 'yggdrasil', state: 'stopped' };
};

const getAllServiceStatuses = (): ServiceStatus[] => {
  const ygg = getYggdrasilStatus();
  const lockedDetails = ygg.state === 'running' ? undefined : '需要先启动 Yggdrasil 服务';
  return [
    ygg,
    { name: 'ipfs', state: 'stopped', details: lockedDetails ?? 'not implemented yet' },
    { name: 'web', state: 'stopped', details: lockedDetails ?? 'not implemented yet' },
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
  const args = [command];

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

ipcMain.handle('services:getAll', async () => {
  return getAllServiceStatuses();
});

ipcMain.handle('services:start', async (_event, serviceName: ServiceName) => {
  try {
    if (serviceName === 'yggdrasil') {
      return await startYggdrasil();
    }

    const ygg = getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(`Yggdrasil 未运行，无法启动 ${serviceName} 服务。`);
    }

    throw new Error(`${serviceName} service start is not implemented yet.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Failed to start service ${serviceName}:`, error);
    return { name: serviceName, state: 'stopped', details: message } satisfies ServiceStatus;
  }
});

ipcMain.handle('services:stop', async (_event, serviceName: ServiceName) => {
  try {
    if (serviceName === 'yggdrasil') {
      return await stopYggdrasil();
    }

    const ygg = getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(`Yggdrasil 未运行，无法停止 ${serviceName} 服务。`);
    }
    throw new Error(`${serviceName} service stop is not implemented yet.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Failed to stop service ${serviceName}:`, error);
    return { name: serviceName, state: 'stopped', details: message } satisfies ServiceStatus;
  }
});

ipcMain.handle('yggdrasilctl:run', async (_event, command: YggdrasilCtlCommand) => {
  try {
    // Most commands require Yggdrasil to be running; surfacing a friendly error helps UX.
    const ygg = getYggdrasilStatus();
    if (command !== 'list' && ygg.state !== 'running') {
      throw new Error('Yggdrasil 未运行，无法获取状态。请先在首页启动 Yggdrasil。');
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
