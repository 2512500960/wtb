export type ServiceName = 'yggdrasil' | 'web' | 'ipfs';

export type ServiceStatus = {
  name: ServiceName;
  state: 'running' | 'stopped';
  details?: string;
};

export type FirewallPortDescriptor = {
  name: string;
  port: number;
  protocol: 'TCP';
};

export type FirewallPortStatus = FirewallPortDescriptor & {
  allowed: boolean;
  rules: string[];
  checked: boolean;
  error?: string;
};
