export type ServiceName = 'yggdrasil' | 'ipfs' | 'web';

export type ServiceStatus = {
  name: ServiceName;
  state: 'running' | 'stopped';
  details?: string;
};

export const serviceLabel: Record<ServiceName, string> = {
  yggdrasil: 'Yggdrasil 服务',
  ipfs: 'IPFS 服务',
  web: 'Web 服务',
};
