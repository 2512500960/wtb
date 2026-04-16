import * as http from 'http';
import { EventEmitter } from 'events';

jest.mock('http', () => {
  const actual = jest.requireActual('http') as typeof import('http');
  return {
    ...actual,
    request: jest.fn(),
  };
});

jest.mock('../main/wtb_config', () => ({
  getWtbConfig: () => ({}),
}));

import { WebServiceManager } from '../main/web_service_manager';

type MockResponse = EventEmitter & {
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  statusCode: number;
  end: jest.Mock<unknown, [unknown?]>;
  setHeader: jest.Mock<void, [string, unknown]>;
  destroy: jest.Mock<unknown, []>;
};

type MockUpstreamResponse = EventEmitter & {
  headers: http.IncomingHttpHeaders;
  statusCode?: number;
  pipe: jest.Mock<unknown, [unknown]>;
  resume: jest.Mock<void, []>;
  destroy: jest.Mock<unknown, []>;
};

type MockClientRequest = EventEmitter & {
  end: jest.Mock<void, []>;
  destroy: jest.Mock<unknown, [Error?]>;
};

const createResponseMock = (): MockResponse => {
  const response = new EventEmitter() as MockResponse;

  response.statusCode = 200;
  response.headersSent = false;
  response.writableEnded = false;
  response.destroyed = false;
  response.setHeader = jest.fn();
  response.end = jest.fn((body?: unknown) => {
    if (response.writableEnded || response.destroyed) {
      throw new Error('write after end');
    }

    response.headersSent = true;
    response.writableEnded = true;
    response.emit('finish');
    response.emit('close');
    return body;
  });
  response.destroy = jest.fn(() => {
    if (!response.destroyed) {
      response.destroyed = true;
      response.writableEnded = true;
      response.emit('close');
    }
    return response;
  });

  return response;
};

describe('WebServiceManager', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('does not end the response twice when a late upstream error arrives', async () => {
    const res = createResponseMock();
    const upstreamRes = new EventEmitter() as MockUpstreamResponse;
    upstreamRes.headers = {};
    upstreamRes.statusCode = 200;
    upstreamRes.pipe = jest.fn((destination: unknown) => destination);
    upstreamRes.resume = jest.fn();
    upstreamRes.destroy = jest.fn(() => upstreamRes);

    const requestMock = http.request as unknown as jest.Mock;
    requestMock.mockImplementation(((_options: unknown, callback?: (response: http.IncomingMessage) => void) => {
        const upstream = new EventEmitter() as MockClientRequest;

        upstream.destroy = jest.fn(() => upstream);
        upstream.end = jest.fn(() => {
          callback?.(upstreamRes as unknown as http.IncomingMessage);
          res.headersSent = true;
          res.end('video data');
          upstreamRes.emit('end');
          upstream.emit('error', new Error('late upstream error'));
        });

        return upstream as unknown as http.ClientRequest;
      }) as unknown as typeof http.request);

    const manager = new WebServiceManager({
      app: {
        isPackaged: false,
      } as Electron.App,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
      },
      getWtbDataDir: () => 'C:/tmp/wtb-data',
      getYggdrasilStatus: () => ({ name: 'yggdrasil', state: 'running' }),
      getYggdrasilAddress: async () => '2001:db8::1',
      ipfsManager: {
        getServiceStatus: () => ({ name: 'ipfs', state: 'running' }),
        getGatewayBaseUrl: () => 'http://127.0.0.1:8080',
      } as unknown as never,
    });

    await expect(
      (manager as unknown as {
        respondWithIpfsBackedFile: (
          req: http.IncomingMessage,
          response: http.ServerResponse,
          method: string,
          cid: string,
          contentType?: string,
        ) => Promise<void>;
      }).respondWithIpfsBackedFile(
        {
          headers: {},
          socket: { remoteAddress: '::1' },
        } as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        'GET',
        'bafy-video',
        'video/mp4',
      ),
    ).resolves.toBeUndefined();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.destroy).not.toHaveBeenCalled();
  });
});
