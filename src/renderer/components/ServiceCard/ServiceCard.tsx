import * as React from 'react';
import ServiceCardYggdrasil from './ServiceCardYggdrasil';
import ServiceCardWeb from './ServiceCardWeb';
import ServiceCardGeneric from './ServiceCardGeneric';
import { ServiceStatus, ServiceName } from '../../types/services';

export default function ServiceCard(props: {
  svc: ServiceStatus;
  yggRunning: boolean;
  busyName: ServiceName | null;
  start: (n: ServiceName) => Promise<void>;
  stop: (n: ServiceName) => Promise<void>;
  openExternal: (u: string) => void;
}) {
  const { svc } = props;

  if (svc.name === 'yggdrasil') {
    return <ServiceCardYggdrasil {...props} />;
  }

  if (svc.name === 'web') {
    return <ServiceCardWeb {...props} />;
  }

  return <ServiceCardGeneric {...props} />;
}
