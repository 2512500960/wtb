import * as React from 'react';
import { Link } from 'react-router-dom';
import type {
  YggdrasilCtlCommand,
  YggdrasilCtlResult,
} from '../types/yggdrasilctl';

export default function StatusPage() {
  const commandDefs = React.useMemo(
    () =>
      [
        { cmd: 'getself', label: 'getself', desc: '本机信息' },
        { cmd: 'getpeers', label: 'getpeers', desc: '直连 peers' },
        { cmd: 'getsessions', label: 'getsessions', desc: '会话' },
        { cmd: 'getpaths', label: 'getpaths', desc: '已建立路径' },
        { cmd: 'gettree', label: 'gettree', desc: 'Tree 表' },
        { cmd: 'gettun', label: 'gettun', desc: 'TUN 信息' },
        { cmd: 'getp2ppeers', label: 'getp2ppeers', desc: 'libp2p peers' },
        {
          cmd: 'getmulticastinterfaces',
          label: 'getmulticastinterfaces',
          desc: '组播接口',
        },
        { cmd: 'list', label: 'list', desc: '命令列表' },
      ] as const,
    [],
  );

  type CommandCardState = {
    busy: boolean;
    result: YggdrasilCtlResult | null;
    error: string | null;
  };

  const buildInitial = React.useCallback(() => {
    return Object.fromEntries(
      commandDefs.map((d) => [
        d.cmd,
        { busy: false, result: null, error: null },
      ]),
    ) as Record<YggdrasilCtlCommand, CommandCardState>;
  }, [commandDefs]);

  const [items, setItems] = React.useState<
    Record<YggdrasilCtlCommand, CommandCardState>
  >(() => buildInitial());

  const runIdRef = React.useRef(0);

  const runAll = React.useCallback(async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    setItems((prev) => {
      const next: Record<YggdrasilCtlCommand, CommandCardState> = { ...prev };
      commandDefs.forEach((d) => {
        next[d.cmd] = { busy: true, result: null, error: null };
      });
      return next;
    });

    const promises = commandDefs.map((d) =>
      window.electron.ipcRenderer
        .invoke('yggdrasilctl:run', d.cmd)
        .then((res: unknown) => {
          if (runIdRef.current !== runId) return res;
          setItems((prev) => ({
            ...prev,
            [d.cmd]: {
              busy: false,
              result: res as YggdrasilCtlResult,
              error: null,
            },
          }));
          return res;
        })
        .catch((e: unknown) => {
          if (runIdRef.current !== runId) throw e;
          const message = e instanceof Error ? e.message : String(e);
          setItems((prev) => ({
            ...prev,
            [d.cmd]: { busy: false, result: null, error: message },
          }));
          throw e;
        }),
    );

    // observe all promises to avoid unhandled rejections; we don't need their results here
    await Promise.allSettled(promises);
  }, [commandDefs]);

  React.useEffect(() => {
    runAll();
  }, [runAll]);

  const busyCount = commandDefs.reduce(
    (acc, d) => acc + (items[d.cmd]?.busy ? 1 : 0),
    0,
  );

  return (
    <div className="PageRoot">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">Yggdrasil 状态</div>
      </div>

      <div className="PageBody">
        <div className="StatusControls">
          <div className="StatusSummary">
            共 {commandDefs.length} 条命令
            {busyCount ? `，加载中：${busyCount}` : ''}
          </div>
          <button
            type="button"
            className="ServiceGhostButton"
            onClick={runAll}
            disabled={busyCount > 0}
          >
            {busyCount > 0 ? '刷新中…' : '刷新全部'}
          </button>
        </div>

        <div className="StatusBlocks">
          {commandDefs.map((d) => {
            const item = items[d.cmd];
            const result = item?.result;
            const showStderr = (result?.stderr ?? '').trim().length > 0;
            const showStdout = (result?.stdout ?? '').trim().length > 0;
            return (
              <div key={d.cmd} className="StatusBlock">
                <div className="StatusBlockHeader">
                  <div className="StatusBlockTitle">
                    {d.label}{' '}
                    <span className="StatusBlockDesc">- {d.desc}</span>
                  </div>

                  {(() => {
                    if (item?.busy) {
                      return <span className="StatusOk">加载中…</span>;
                    }
                    if (item?.error) {
                      return <span className="StatusBad">ERROR</span>;
                    }
                    if (result) {
                      if (result.ok) {
                        return <span className="StatusOk">OK</span>;
                      }
                      return <span className="StatusBad">ERROR</span>;
                    }
                    return <span className="StatusOk">等待</span>;
                  })()}
                </div>

                {item?.error ? (
                  <div className="ServiceError">{item.error}</div>
                ) : null}

                {result ? (
                  <div className="StatusMeta">
                    <span>exit={result.exitCode ?? '-'} </span>
                    <span>耗时={result.durationMs}ms</span>
                  </div>
                ) : null}

                {showStderr ? (
                  <div className="StatusIO">
                    <div className="StatusBlockTitle">stderr</div>
                    <pre className="StatusPre">{result?.stderr}</pre>
                  </div>
                ) : null}

                {showStdout ? (
                  <div className="StatusIO">
                    <div className="StatusBlockTitle">stdout</div>
                    <pre className="StatusPre">{result?.stdout}</pre>
                  </div>
                ) : null}

                {!item?.busy &&
                !item?.error &&
                result &&
                !showStdout &&
                !showStderr ? (
                  <div className="StatusEmpty">无输出</div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
