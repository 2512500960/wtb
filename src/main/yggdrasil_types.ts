export type YggdrasilCtlResult = {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

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
