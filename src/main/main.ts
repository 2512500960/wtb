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
import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { spawnSync } from 'child_process';
import fs from 'fs';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
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

const runElevatedPowerShellAndWait = (script: string): void => {
  ensureWindowsOrThrow();
  const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',${psSingleQuote(
    script,
  )}) -Wait`;
  // Note: output isn't important here; the elevated script writes state (pid/logs/config) to disk.
  runPowerShell(command, { ignoreStdio: true });
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

const startYggdrasil = (): ServiceStatus => {
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

  // Explain why we need elevation (minimum privilege: only this service).
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    buttons: ['取消', '继续'],
    defaultId: 1,
    cancelId: 0,
    title: '需要管理员权限',
    message: '启动 Yggdrasil 需要管理员权限。',
    detail: '需要管理员权限来创建 TUN 网卡，并启动 Yggdrasil 服务。\n\n点击“继续”后将弹出 Windows UAC 提示。',
  });
  if (choice !== 1) {
    return { name: 'yggdrasil', state: 'stopped', details: '已取消管理员权限请求' };
  }

  // Generate config + start yggdrasil from an elevated PowerShell, writing state into the app directory.
  const dataDir = getYggdrasilDataDir();
  const pidPath = getYggdrasilPidPath();
  const stdoutPath = getYggdrasilStdoutPath();
  const stderrPath = getYggdrasilStderrPath();
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `New-Item -ItemType Directory -Force -Path ${psSingleQuote(dataDir)} | Out-Null`,
    `if (!(Test-Path -LiteralPath ${psSingleQuote(confPath)})) { & ${psSingleQuote(
      yggExe,
    )} -genconf | Out-File -FilePath ${psSingleQuote(confPath)} -Encoding utf8 }`,
    `$p = Start-Process -FilePath ${psSingleQuote(yggExe)} -ArgumentList @('-useconffile',${psSingleQuote(
      confPath,
    )}) -WorkingDirectory ${psSingleQuote(baseDir)} -RedirectStandardOutput ${psSingleQuote(
      stdoutPath,
    )} -RedirectStandardError ${psSingleQuote(
      stderrPath,
    )} -PassThru -WindowStyle Hidden`,
    `$p.Id | Out-File -FilePath ${psSingleQuote(pidPath)} -Encoding ascii`,
  ].join('; ');

  runElevatedPowerShellAndWait(script);

  const pid = readYggdrasilPidFromFile();
  if (!pid || !isProcessAlive(pid)) {
    throw new Error('yggdrasil 启动失败：未能获取有效 PID（可能被 UAC 取消或启动异常）');
  }

  yggdrasilPid = pid;
  log.info(`yggdrasil started (elevated on-demand). pid=${pid}`);
  return { name: 'yggdrasil', state: 'running', details: `pid=${pid}` };
};

const stopYggdrasil = (): ServiceStatus => {
  ensureWindowsOrThrow();

  // Don't prompt on app quit; only stop when explicitly requested.
  const pid = yggdrasilPid ?? readYggdrasilPidFromFile();
  if (!pid) {
    return { name: 'yggdrasil', state: 'stopped' };
  }

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['取消', '继续'],
    defaultId: 1,
    cancelId: 0,
    title: '需要管理员权限',
    message: '停止 Yggdrasil 需要管理员权限。',
    detail: '需要管理员权限来停止已启动的 Yggdrasil 进程。\n\n点击“继续”后将弹出 Windows UAC 提示。',
  });
  if (choice !== 1) {
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

  runElevatedPowerShellAndWait(script);
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

ipcMain.handle('services:getAll', async () => {
  return getAllServiceStatuses();
});

ipcMain.handle('services:start', async (_event, serviceName: ServiceName) => {
  try {
    if (serviceName === 'yggdrasil') {
      return startYggdrasil();
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
      return stopYggdrasil();
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
