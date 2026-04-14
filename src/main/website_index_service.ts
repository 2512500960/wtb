import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

type SignedWebsiteIndexEnvelope = {
  payload?: unknown;
  payloadJson?: unknown;
  data?: unknown;
  sigB64?: unknown;
  signatureB64?: unknown;
  signature?: unknown;
  alg?: unknown;
};

export type WebsiteIndexLoadResult = {
  ok: true;
  verified: boolean;
  sourceUrl: string;
  data: unknown;
};

type IndexItem = Record<string, unknown>;

const pickString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const readIndexArray = (data: unknown): IndexItem[] => {
  if (Array.isArray(data)) {
    return data.filter((item) => item && typeof item === 'object') as IndexItem[];
  }

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const rows = obj.rows ?? obj.items ?? obj.data ?? obj.list;
    if (Array.isArray(rows)) {
      return rows.filter((item) => item && typeof item === 'object') as IndexItem[];
    }
  }

  return [];
};

export const extractWebsiteIndexUrls = (data: unknown): string[] => {
  const rows = readIndexArray(data);
  const urls = rows
    .map((item) => {
      return (
        pickString(item.url)
        || pickString(item.href)
        || pickString(item.URL)
        || pickString(item['地址'])
        || pickString(item['链接'])
      );
    })
    .filter(Boolean);

  return Array.from(new Set(urls));
};

const httpGetText = async (
  url: string,
  timeoutMs: number,
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> => {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;

  return await new Promise((resolve, reject) => {
    const req = transport.request(
      {
        method: 'GET',
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: {
          Accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求超时'));
    });
    req.end();
  });
};

const parseSignedWebsiteIndex = (
  raw: string,
): {
  payloadText: string;
  sigB64: string;
  alg: 'ed25519';
  data: unknown;
} => {
  let env: SignedWebsiteIndexEnvelope;
  try {
    env = JSON.parse(raw) as SignedWebsiteIndexEnvelope;
  } catch {
    throw new Error('索引数据不是合法 JSON');
  }

  const sig =
    (typeof env.sigB64 === 'string' && env.sigB64) ||
    (typeof env.signatureB64 === 'string' && env.signatureB64) ||
    (typeof env.signature === 'string' && env.signature) ||
    '';
  if (!sig) {
    throw new Error('索引数据缺少签名字段（sigB64/signatureB64/signature）');
  }

  const algRaw = typeof env.alg === 'string' ? env.alg.toLowerCase() : '';
  const alg: 'ed25519' =
    algRaw.includes('ed25519') || algRaw.includes('ed-25519')
      ? 'ed25519'
      : 'ed25519';

  const rawPayload =
    (typeof env.payloadJson === 'string' && env.payloadJson) ||
    (typeof env.payload === 'string' && env.payload) ||
    '';
  if (!rawPayload) {
    throw new Error(
      '索引数据缺少 payload（必须是 JSON 字符串或其 base64 编码）',
    );
  }

  let payloadText: string | null = null;
  try {
    JSON.parse(rawPayload);
    payloadText = rawPayload;
  } catch {
    try {
      const decoded = Buffer.from(rawPayload, 'base64').toString('utf8');
      JSON.parse(decoded);
      payloadText = decoded;
    } catch {
      payloadText = null;
    }
  }

  if (!payloadText) {
    throw new Error('payload 不是合法 JSON 字符串或其 base64 编码');
  }

  let data: unknown;
  try {
    data = JSON.parse(payloadText) as unknown;
  } catch {
    throw new Error('payload 不是合法 JSON 字符串');
  }

  return { payloadText, sigB64: sig, alg, data };
};

const verifyWebsiteIndexSignatureOrThrow = (
  payloadText: string,
  sigB64: string,
  alg: 'ed25519',
  publicKeyPem: string,
): void => {
  if (alg !== 'ed25519') {
    throw new Error(`不支持的签名算法：${alg}`);
  }

  if (!publicKeyPem) {
    throw new Error(
      '未配置索引验签公钥（请在 src/main/website_index_pubkey.ts 中硬编码 Ed25519 公钥 PEM）',
    );
  }

  const sig = Buffer.from(sigB64, 'base64');
  const payload = Buffer.from(payloadText, 'utf8');
  const pub = crypto.createPublicKey(publicKeyPem);
  const ok = crypto.verify(null, payload, pub, sig);
  if (!ok) throw new Error('索引数据 Ed25519 签名校验失败');
};

export class WebsiteIndexService {
  constructor(
    private readonly options: {
      sourceUrl: string;
      publicKeyPem: string;
    },
  ) {}

  async loadIndex(): Promise<WebsiteIndexLoadResult> {
    let parsed: URL;
    try {
      parsed = new URL(this.options.sourceUrl);
    } catch {
      throw new Error('索引 URL 配置无效');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('索引 URL 仅支持 http/https');
    }

    const res = await httpGetText(parsed.toString(), 15000);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`索引请求失败：HTTP ${res.statusCode}`);
    }

    try {
      const { payloadText, sigB64, alg, data } = parseSignedWebsiteIndex(
        res.body,
      );
      verifyWebsiteIndexSignatureOrThrow(
        payloadText,
        sigB64,
        alg,
        this.options.publicKeyPem,
      );
      return {
        ok: true,
        verified: true,
        sourceUrl: parsed.toString(),
        data,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const looksLikeEnvelopeMissingSigOrPayload =
        message.includes('缺少签名字段') ||
        message.includes('缺少 payload') ||
        message.includes('payload 不是合法 JSON') ||
        message.includes('索引数据不是合法 JSON');

      if (!looksLikeEnvelopeMissingSigOrPayload) {
        throw error;
      }

      let data: unknown;
      try {
        data = JSON.parse(res.body) as unknown;
      } catch {
        throw error;
      }

      return {
        ok: true,
        verified: false,
        sourceUrl: parsed.toString(),
        data,
      };
    }
  }
}
