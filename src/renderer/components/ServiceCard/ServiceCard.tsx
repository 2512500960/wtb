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
  openDir: (n: ServiceName) => Promise<void>;
  openExternal: (u: string) => void;
}) {
  const { svc, yggRunning, busyName, start, stop, openDir, openExternal } =
    props;

  if (svc.name === 'yggdrasil') {
    return (
      <ServiceCardYggdrasil
        svc={svc}
        busyName={busyName}
        start={start}
        stop={stop}
      />
    );
  }

  if (svc.name === 'web') {
    return (
      <ServiceCardWeb
        svc={svc}
        yggRunning={yggRunning}
        busyName={busyName}
        start={start}
        stop={stop}
        openDir={openDir}
        openExternal={openExternal}
      />
    );
  }

  return (
    <ServiceCardGeneric
      svc={svc}
      yggRunning={yggRunning}
      busyName={busyName}
      start={start}
      stop={stop}
    />
  );
}
