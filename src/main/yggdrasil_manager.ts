import path from 'path';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import {
  dialog,
  type App,
  type BrowserWindow,
  type MessageBoxOptions,
} from 'electron';
import * as Hjson from 'hjson';

import type { ServiceStatus } from './service_types';
import type {
  YggdrasilCtlCommand,
  YggdrasilCtlResult,
} from './yggdrasil_types';
import { debug } from 'console';

type LoggerLike = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

type YggdrasilManagerOptions = {
  app: App;
  getWtbDataDir: () => string;
  getOwnerWindow: () => BrowserWindow | null;
  logger: LoggerLike;
  bootstrapNodes: string[];
};

type PeArch = 'x86' | 'x64' | 'arm64' | 'unknown';

const isWindows = process.platform === 'win32';

const yggdrasilCtlAllowedCommands: ReadonlySet<string> = new Set<string>([
  'addpeer',
  'getself',
  'getpeers',
  'getsessions',
  'getpaths',
  'gettree',
  'gettun',
  'getp2ppeers',
  'getmulticastinterfaces',
  'list',
  'removepeer',
  'getselfjson',
  'getpeersjson',
  'getp2ppeersjson',
]);

const yggdrasilCtlJsonCommandMap = new Map<string, string>([
  ['getselfjson', 'getself'],
  ['getpeersjson', 'getpeers'],
  ['getp2ppeersjson', 'getp2ppeers'],
]);

const yggdrasilWtbDefaults = Object.freeze({
  ifMtu: 2048,
  routeProbe: true,
});

const psSingleQuote = (value: string): string => {
  return `'${value.replace(/'/g, "''")}'`;
};

const stripUtf8Bom = (text: string): string => {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

const normalizeYggdrasilConfStringList = (values: unknown): string[] => {
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const stringListsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
};

const getPeArch = (filePath: string): PeArch | null => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    if (buf.length < 0x40) return 'unknown';
    if (buf[0] !== 0x4d || buf[1] !== 0x5a) return 'unknown';

    const peOffset = buf.readUInt32LE(0x3c);
    if (
      !Number.isFinite(peOffset) ||
      peOffset <= 0 ||
      peOffset + 6 >= buf.length
    ) {
      return 'unknown';
    }

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

const parseYggdrasilIPv6FromGetself = (stdout: string): string | null => {
  const text = (stdout || '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const { address } = parsed as any;
      if (typeof address === 'string' && address.includes(':')) {
        return address.trim();
      }

      const selfAddress = (parsed as any).self?.address;
      if (typeof selfAddress === 'string' && selfAddress.includes(':')) {
        return selfAddress.trim();
      }

      const { subnet } = parsed as any;
      if (typeof subnet === 'string') {
        const maybe = subnet.split('/')[0].trim();
        if (maybe.includes(':')) return maybe;
      }
    }
  } catch {
    // ignore; fall through to regex
  }

  const match = text.match(/\b([0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){2,})\b/);
  return match?.[1] ?? null;
};

export class YggdrasilManager {
  private pid: number | null = null;

  constructor(private readonly options: YggdrasilManagerOptions) {}

  getBaseDir(): string {
    this.ensureWindowsOrThrow();

    if (process.arch !== 'x64') {
      throw new Error(
        `Unsupported architecture: ${process.arch}. Only Windows x64 is supported.`,
      );
    }

    if (this.options.app.isPackaged) {
      return path.join(
        process.resourcesPath,
        'yggdrasil',
        'windows10',
        'amd64',
      );
    }

    return path.join(__dirname, '../../yggdrasil/windows10/amd64');
  }

  async runCtlCommand(
    command: string,
    extraArgs: string[] = [],
    options?: { timeoutMs?: number; json?: boolean },
  ): Promise<YggdrasilCtlResult> {
    this.ensureWindowsOrThrow();

    if (!yggdrasilCtlAllowedCommands.has(command)) {
      throw new Error(`Unsupported yggdrasilctl command: ${command}`);
    }

    const exePath = this.getCtlExePath();
    if (!fs.existsSync(exePath)) {
      throw new Error(`yggdrasilctl.exe not found at: ${exePath}`);
    }

    const timeoutMs = options?.timeoutMs ?? 5000;
    const jsonBaseCommand = yggdrasilCtlJsonCommandMap.get(command);
    const useJson = options?.json === true || !!jsonBaseCommand;
    const baseCommand = jsonBaseCommand || command;
    const args = useJson
      ? ['-json', baseCommand, ...extraArgs]
      : [baseCommand, ...extraArgs];

    const start = Date.now();
    return await new Promise<YggdrasilCtlResult>((resolve, reject) => {
      const child = spawn(exePath, args, {
        windowsHide: true,
        cwd: this.getBaseDir(),
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

        resolve({
          ok: exitCode === 0,
          command,
          exitCode,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
          durationMs,
        });
      });
    });
  }

  async runCtl(
    command: YggdrasilCtlCommand,
    timeoutMs: number = 5000,
  ): Promise<YggdrasilCtlResult> {
    return await this.runCtlCommand(command, [], { timeoutMs });
  }

  clearConfigPeersBestEffort(reason: string): void {
    try {
      const confPath = this.getConfPath();
      if (!fs.existsSync(confPath)) return;

      this.setConfPeers(confPath, []);
      this.options.logger.info(`Cleared yggdrasil.conf peers (${reason}).`);
    } catch (error) {
      this.options.logger.warn(
        `Failed to clear yggdrasil.conf peers (${reason})`,
        error,
      );
    }
  }

  async start(): Promise<ServiceStatus> {
    this.ensureWindowsOrThrow();

    if (this.pid && this.isProcessAlive(this.pid)) {
      return {
        name: 'yggdrasil',
        state: 'running',
        details: `pid=${this.pid}`,
      };
    }

    const pidFromFile = this.readPidFromFile();
    if (pidFromFile && this.isProcessAlive(pidFromFile)) {
      this.pid = pidFromFile;
      return {
        name: 'yggdrasil',
        state: 'running',
        details: `pid=${pidFromFile}`,
      };
    }

    const yggExe = this.getExePath();
    const baseDir = this.getBaseDir();
    const confPath = this.getConfPath();

    if (!fs.existsSync(yggExe)) {
      throw new Error(`yggdrasil.exe not found at: ${yggExe}`);
    }

    const archHint = this.buildStartupHint(baseDir);
    if (archHint) {
      throw new Error(archHint);
    }

    const { response } = await this.showElevationPrompt('start', {
      type: 'info',
      buttons: ['取消', '继续'],
      defaultId: 1,
      cancelId: 0,
      title: '需要管理员权限',
      message: '启动 Yggdrasil 需要管理员权限。',
      detail:
        '需要管理员权限来创建 TUN 网卡，并启动 Yggdrasil 服务。\n\n点击“继续”后将弹出 Windows UAC 提示。',
    });
    if (response !== 1) {
      return {
        name: 'yggdrasil',
        state: 'stopped',
        details: '已取消管理员权限请求',
      };
    }

    const dataDir = this.getDataDir();
    const p2pDataDir = path.join(dataDir, 'datasource');
    const pidPath = this.getPidPath();
    const stdoutPath = this.getStdoutPath();
    const stderrPath = this.getStderrPath();

    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(p2pDataDir, { recursive: true });
    await this.prepareConfForStart(yggExe, confPath, p2pDataDir.replace(/\\/g, '/'));
    this.clearConfigPeersBestEffort('before yggdrasil start');

    const script = [
      "$ErrorActionPreference = 'Stop'",
      `New-Item -ItemType Directory -Force -Path ${psSingleQuote(dataDir)} | Out-Null`,
      `if (-not $env:GOMEMLIMIT) { $env:GOMEMLIMIT = '256MiB' }`,
      `$p = Start-Process -FilePath ${psSingleQuote(yggExe)} -ArgumentList @('-useconffile',${psSingleQuote(
        confPath,
      )}) -WorkingDirectory ${psSingleQuote(baseDir)} -RedirectStandardOutput ${psSingleQuote(
        stdoutPath,
      )} -RedirectStandardError ${psSingleQuote(
        stderrPath,
      )} -PassThru -WindowStyle Hidden`,
      `$p.Id | Out-File -FilePath ${psSingleQuote(pidPath)} -Encoding ascii`,
    ].join('; ');

    await this.runElevatedPowerShellAndWaitAsync(script);
    this.options.logger.info('yggdrasil start requested (elevated on-demand).');

    let pid: number | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      pid = this.readPidFromFile();
      if (pid && this.isProcessAlive(pid)) {
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!pid || !this.isProcessAlive(pid)) {
      const stderrTail = this.readTextFileTail(this.getStderrPath());
      const commonHint = stderrTail?.includes('wintun.dll')
        ? '看起来是 wintun.dll 加载失败（常见原因：DLL 架构不匹配）。'
        : undefined;
      throw new Error(
        [
          'yggdrasil 启动失败：未能获取有效 PID（可能被 UAC 取消或启动异常）',
          commonHint,
          stderrTail
            ? `yggdrasil.stderr.log（末尾）:\n${stderrTail}`
            : undefined,
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }

    this.pid = pid;
    this.options.logger.info(`yggdrasil started (elevated on-demand). pid=${pid}`);
    return { name: 'yggdrasil', state: 'running', details: `pid=${pid}` };
  }

  async stop(): Promise<ServiceStatus> {
    this.ensureWindowsOrThrow();

    const pid = this.pid ?? this.readPidFromFile();
    if (!pid) {
      return { name: 'yggdrasil', state: 'stopped' };
    }

    const { response } = await this.showElevationPrompt('stop', {
      type: 'warning',
      buttons: ['取消', '继续'],
      defaultId: 1,
      cancelId: 0,
      title: '需要管理员权限',
      message: '停止 Yggdrasil 需要管理员权限。',
      detail:
        '需要管理员权限来停止已启动的 Yggdrasil 进程。\n\n点击“继续”后将弹出 Windows UAC 提示。',
    });
    if (response !== 1) {
      return { name: 'yggdrasil', state: 'running', details: `pid=${pid}` };
    }

    const pidPath = this.getPidPath();
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `if (Test-Path -LiteralPath ${psSingleQuote(pidPath)}) { $pidText = Get-Content -LiteralPath ${psSingleQuote(
        pidPath,
      )} -ErrorAction SilentlyContinue; $pidValue = [int]$pidText; Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ${psSingleQuote(
        pidPath,
      )} -Force -ErrorAction SilentlyContinue }`,
    ].join('; ');

    await this.runElevatedPowerShellAndWaitAsync(script);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    this.pid = null;
    this.options.logger.info(`yggdrasil stop requested. pid=${pid}`);
    return { name: 'yggdrasil', state: 'stopped' };
  }

  async stopSilently(): Promise<void> {
    try {
      const pid = this.pid ?? this.readPidFromFile();
      if (!pid) return;

      const pidPath = this.getPidPath();

      try {
        const command = `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue }`;
        this.runPowerShell(command);
      } catch {
        // ignore
      }

      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!this.isProcessAlive(pid)) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      if (!this.isProcessAlive(pid)) {
        try {
          if (fs.existsSync(pidPath)) {
            fs.unlinkSync(pidPath);
          }
        } catch {
          // ignore
        }

        this.pid = null;
        this.options.logger.info(`yggdrasil stopped silently. pid=${pid}`);
      } else {
        this.options.logger.info(
          `yggdrasil still running after silent stop attempt. pid=${pid}`,
        );
      }
    } catch (error) {
      this.options.logger.warn('Failed to silently stop yggdrasil on quit', error);
    }
  }

  getStatus(): ServiceStatus {
    if (!isWindows) {
      return {
        name: 'yggdrasil',
        state: 'stopped',
        details: 'unsupported platform',
      };
    }

    if (!this.pid) {
      const pidFromFile = this.readPidFromFile();
      if (pidFromFile && this.isProcessAlive(pidFromFile)) {
        this.pid = pidFromFile;
        return {
          name: 'yggdrasil',
          state: 'running',
          details: `pid=${pidFromFile}`,
        };
      }
      return { name: 'yggdrasil', state: 'stopped' };
    }

    if (this.isProcessAlive(this.pid)) {
      return {
        name: 'yggdrasil',
        state: 'running',
        details: `pid=${this.pid}`,
      };
    }

    this.pid = null;
    return { name: 'yggdrasil', state: 'stopped' };
  }
  // run yggdrasilctl getself with retries to obtain the IPv6 address, since it may take some time for the TUN interface to be ready after startup
  // add --json flag to get structured output if supported
  // fallback to regex parsing should be deprecated now
  async getIPv6AddressOrThrow(): Promise<string> {
    const maxAttempts = 10;
    const delayMs = 1000;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const result = await this.runCtlCommand('getself', [], { timeoutMs: 3000, json: true });
        if (!result.ok) {
          const msg = (result.stderr || result.stdout || '').trim();
          lastError = new Error(
            `Failed to query Yggdrasil self address${msg ? `: ${msg}` : ''}`,
          );
        } else {
          const text = (result.stdout || '').trim();
          if (!text) {
            lastError = new Error('yggdrasilctl returned empty JSON output');
          } else {
            let parsed: any = null;
            try {
              parsed = JSON.parse(text);
            } catch (e) {
              lastError = new Error('yggdrasilctl returned invalid JSON');
            }

            if (parsed && typeof parsed === 'object') {
              const candidates: string[] = [];
              if (typeof parsed.address === 'string') candidates.push(parsed.address.trim());
              if (typeof parsed.self?.address === 'string') candidates.push(parsed.self.address.trim());
              if (typeof parsed.subnet === 'string') candidates.push(parsed.subnet.split('/')[0].trim());

              const addr = candidates.find((a) => typeof a === 'string' && a.includes(':')) ?? null;
              if (addr) {
                // debug(`Obtained Yggdrasil IPv6 address on attempt ${attempt + 1}: ${addr}`);
                return addr;
              }

              lastError = new Error(
                'Unable to obtain IPv6 address from yggdrasilctl JSON output.',
              );
            }
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attempt < maxAttempts - 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Failed to obtain Yggdrasil IPv6 address.');
  }

  private ensureWindowsOrThrow(): void {
    if (!isWindows) {
      throw new Error('This app currently only supports Windows.');
    }
  }

  private getExePath(): string {
    return path.join(this.getBaseDir(), 'yggdrasil.exe');
  }

  private getCtlExePath(): string {
    return path.join(this.getBaseDir(), 'yggdrasilctl.exe');
  }

  private getDataDir(): string {
    return path.join(this.options.getWtbDataDir(), 'yggdrasil');
  }

  private getConfPath(): string {
    const confPath = path.join(this.getDataDir(), 'yggdrasil.conf');
    this.options.logger.debug('Yggdrasil config path:', confPath);
    return confPath;
  }

  private getPidPath(): string {
    return path.join(this.getDataDir(), 'yggdrasil.pid');
  }

  private getStdoutPath(): string {
    return path.join(this.getDataDir(), 'yggdrasil.stdout.log');
  }

  private getStderrPath(): string {
    return path.join(this.getDataDir(), 'yggdrasil.stderr.log');
  }

  private readTextFileTail(
    filePath: string,
    maxChars: number = 2000,
  ): string | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const text = fs.readFileSync(filePath, { encoding: 'utf8' });
      if (text.length <= maxChars) return text.trim();
      return text.slice(-maxChars).trim();
    } catch {
      return null;
    }
  }

  private setConfPeers(confPath: string, peers: string[]): void {
    const list = normalizeYggdrasilConfStringList(peers);

    const doc = this.readConfDocument(confPath);

    doc.Peers = list;

    this.writeConfDocument(confPath, doc);
  }

  private async prepareConfForStart(
    yggExe: string,
    confPath: string,
    desiredP2PDataDir: string,
  ): Promise<void> {
    const hadExistingConf = fs.existsSync(confPath);
    const latestConfTemplate = this.generateConfDocument(yggExe);
    const doc = hadExistingConf
      ? this.readConfDocument(confPath)
      : latestConfTemplate;

    let changed = !hadExistingConf;

    if (hadExistingConf) {
      changed = this.mergeMissingConfigDefaults(doc, latestConfTemplate) || changed;
    }

    if (!isPlainObject(doc.P2P)) {
      doc.P2P = {};
      changed = true;
    }

    if (!hadExistingConf) {
      const nextBootstrapPeers = normalizeYggdrasilConfStringList([
        ...normalizeYggdrasilConfStringList(doc.P2P.bootstrap_peers),
        ...this.options.bootstrapNodes,
      ]);

      if (!stringListsEqual(normalizeYggdrasilConfStringList(doc.Peers), [])) {
        doc.Peers = [];
        changed = true;
      }

      if (
        !stringListsEqual(
          normalizeYggdrasilConfStringList(doc.P2P.bootstrap_peers),
          nextBootstrapPeers,
        )
      ) {
        doc.P2P.bootstrap_peers = nextBootstrapPeers;
        changed = true;
      }
    }

    if (doc.P2P.data_dir !== desiredP2PDataDir) {
      doc.P2P.data_dir = desiredP2PDataDir;
      changed = true;
    }

    if (doc.route_probe !== yggdrasilWtbDefaults.routeProbe) {
      doc.route_probe = yggdrasilWtbDefaults.routeProbe;
      changed = true;
    }

    if (doc.IfMTU !== yggdrasilWtbDefaults.ifMtu) {
      doc.IfMTU = yggdrasilWtbDefaults.ifMtu;
      changed = true;
    }

    if (!changed) return;

    this.writeConfDocument(confPath, doc);
    this.options.logger.info(
      hadExistingConf
        ? 'Prepared existing yggdrasil.conf with latest defaults and WTB overrides.'
        : 'Generated yggdrasil.conf with latest defaults and WTB overrides.',
    );
  }

  private generateConfDocument(yggExe: string): any {
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

    return this.parseConfDocument(confText);
  }

  private parseConfDocument(raw: string): any {
    const normalized = stripUtf8Bom(raw);
    return (Hjson as any).rt?.parse
      ? (Hjson as any).rt.parse(normalized)
      : Hjson.parse(normalized);
  }

  private readConfDocument(confPath: string): any {
    return this.parseConfDocument(fs.readFileSync(confPath, { encoding: 'utf8' }));
  }

  private writeConfDocument(confPath: string, doc: any): void {
    const out: string = (Hjson as any).rt?.stringify
      ? (Hjson as any).rt.stringify(doc, {
          quotes: 'all',
          separator: true,
          space: 2,
        })
      : Hjson.stringify(doc, { quotes: 'all', separator: true, space: 2 });

    fs.writeFileSync(confPath, `${stripUtf8Bom(out)}\n`, { encoding: 'utf8' });
  }

  private mergeMissingConfigDefaults(
    target: Record<string, unknown>,
    defaults: Record<string, unknown>,
  ): boolean {
    let changed = false;

    for (const [key, defaultValue] of Object.entries(defaults)) {
      const currentValue = target[key];

      if (typeof currentValue === 'undefined') {
        target[key] = defaultValue;
        changed = true;
        continue;
      }

      if (isPlainObject(currentValue) && isPlainObject(defaultValue)) {
        changed =
          this.mergeMissingConfigDefaults(currentValue, defaultValue) || changed;
      }
    }

    return changed;
  }

  private buildStartupHint(baseDir: string): string | null {
    const yggExe = path.join(baseDir, 'yggdrasil.exe');
    const wintunDll = path.join(baseDir, 'wintun.dll');
    const exeArch = getPeArch(yggExe);
    const dllArch = getPeArch(wintunDll);

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
  }

  private runPowerShell(
    command: string,
    options?: { ignoreStdio?: boolean },
  ): { stdout: string; stderr: string } {
    this.ensureWindowsOrThrow();
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
  }

  private async runPowerShellAsync(
    command: string,
    options?: { ignoreStdio?: boolean; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    this.ensureWindowsOrThrow();

    return await new Promise((resolve, reject) => {
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
        child.stdout?.on('data', (data) => {
          stdout += data.toString();
        });
        child.stderr?.on('data', (data) => {
          stderr += data.toString();
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
  }

  private async runElevatedPowerShellAndWaitAsync(script: string): Promise<void> {
    this.ensureWindowsOrThrow();
    const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',${psSingleQuote(
      script,
    )})`;
    await this.runPowerShellAsync(command, {
      ignoreStdio: true,
      timeoutMs: 30_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  private isProcessAlive(pid: number): boolean {
    if (!isWindows) return false;
    const command = `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'true' } else { 'false' }`;
    try {
      const { stdout } = this.runPowerShell(command);
      return stdout.trim().toLowerCase() === 'true';
    } catch {
      return false;
    }
  }

  private readPidFromFile(): number | null {
    try {
      const pidPath = this.getPidPath();
      if (!fs.existsSync(pidPath)) return null;
      const pidText = fs.readFileSync(pidPath, { encoding: 'utf8' }).trim();
      const pid = Number(pidText);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      return pid;
    } catch {
      return null;
    }
  }

  private async showElevationPrompt(
    _kind: 'start' | 'stop',
    messageBoxOptions: MessageBoxOptions,
  ): Promise<Electron.MessageBoxReturnValue> {
    const ownerWindow = this.options.getOwnerWindow();
    if (ownerWindow && !ownerWindow.isDestroyed()) {
      return await dialog.showMessageBox(ownerWindow, messageBoxOptions);
    }

    return await dialog.showMessageBox(messageBoxOptions);
  }
}
