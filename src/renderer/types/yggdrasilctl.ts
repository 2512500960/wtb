export type YggdrasilCtlCommand =
  | 'getself'
  | 'getpeers'
  | 'getsessions'
  | 'getpaths'
  | 'gettree'
  | 'gettun'
  | 'getp2ppeers'
  | 'getmulticastinterfaces'
  | 'list'
  | 'getselfjson'
  | 'getpeersjson'
  | 'getp2ppeersjson';

export type YggdrasilCtlResult = {
  ok: boolean;
  command: YggdrasilCtlCommand;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};
