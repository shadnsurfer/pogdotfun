import type { ChainRpc } from './execution.ts';
/** Read/write RPC transport; signing stays in the encrypted signer boundary. */
export function createHttpChainRpc(url: string, fetcher: typeof fetch = fetch): ChainRpc {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))
  )
    throw new Error('RPC requires HTTPS');
  let sequence = 0;
  return {
    async request(method, params = []) {
      const id = ++sequence;
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(15000),
      }).catch(() => {
        throw new Error('Chain RPC transport unavailable');
      });
      if (!response.ok) throw new Error(`Chain RPC HTTP ${response.status}`);
      const value = (await response.json()) as {
        id: number;
        jsonrpc: string;
        result?: unknown;
        error?: { code: number };
      };
      if (value.id !== id || value.jsonrpc !== '2.0')
        throw new Error('Chain RPC response identity mismatch');
      if (value.error) throw new Error(`Chain RPC error ${value.error.code}`);
      if (!Object.hasOwn(value, 'result')) throw new Error('Chain RPC result missing');
      return value.result;
    },
  };
}
