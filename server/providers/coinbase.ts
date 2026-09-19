import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';

const ORIGIN = 'https://api.coinbase.com';
const MAX_RESPONSE_BYTES = 1_048_576;
export interface CoinbaseCredentials {
  keyName: string;
  privateKey: string;
}
export interface CoinbaseOptions {
  getCredentials: () => Promise<CoinbaseCredentials>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}
export interface CoinbaseDepositAddress {
  accountId: string;
  asset: string;
  network: string;
  address: string;
}
export interface CoinbaseSellRequest {
  clientOrderId: string;
  productId: string;
  baseSize: string;
}
export interface CoinbaseDepositExpectation {
  accountId: string;
  network: string;
  transactionHash: string;
  asset: string;
  amount: string;
}
export interface CoinbaseVerifiedDeposit extends CoinbaseDepositExpectation {
  transactionId: string;
  verifiedAt: number;
}
export interface CoinbaseReconciledSale extends CoinbaseSellRequest {
  orderId: string;
  grossQuoteAmount: string;
  feesQuoteAmount: string;
  netQuoteAmount: string;
  spendableUsdCents: string;
}
export class CoinbaseError extends Error {
  constructor(readonly code: string) {
    super(`Coinbase: ${code}`);
    this.name = 'CoinbaseError';
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CoinbaseError('invalid_response');
  return value as Record<string, unknown>;
}
function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new CoinbaseError('invalid_identifier');
  return value;
}
function decimal(value: unknown): { units: bigint; scale: number } {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,39})(\.\d{1,30})?$/.test(value))
    throw new CoinbaseError('invalid_decimal');
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
}
function equalDecimal(left: unknown, right: unknown): boolean {
  const a = decimal(left),
    b = decimal(right);
  return a.units * 10n ** BigInt(b.scale) === b.units * 10n ** BigInt(a.scale);
}
function positive(value: unknown): void {
  if (decimal(value).units <= 0n) throw new CoinbaseError('invalid_amount');
}
function formatDecimal(units: bigint, scale: number): string {
  if (!scale) return units.toString();
  const digits = units.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
}
function validateSell(input: CoinbaseSellRequest): void {
  identifier(input.clientOrderId);
  if (!/^[A-Z0-9]{2,16}-USD$/.test(input.productId)) throw new CoinbaseError('unsupported_product');
  positive(input.baseSize);
}
function validateDeposit(input: CoinbaseDepositExpectation): void {
  identifier(input.accountId);
  identifier(input.network);
  identifier(input.asset);
  if (
    typeof input.transactionHash !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(input.transactionHash)
  )
    throw new CoinbaseError('invalid_hash');
  positive(input.amount);
}
export function coinbaseClientOrderId(durableEventId: string): string {
  if (!durableEventId || durableEventId.length > 1024) throw new CoinbaseError('invalid_event_id');
  return `pog-${createHash('sha256').update(durableEventId).digest('hex')}`;
}

/** No automatic mutation retries. Persist request and stable clientOrderId before calling. */
export class CoinbaseProvider {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(private readonly options: CoinbaseOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000)
      throw new CoinbaseError('invalid_timeout');
  }
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = async () => {
        const credentials = await this.options.getCredentials();
        if (!/^organizations\/[A-Za-z0-9_-]+\/apiKeys\/[A-Za-z0-9_-]+$/.test(credentials.keyName))
          throw new CoinbaseError('invalid_credentials');
        const key = createPrivateKey(credentials.privateKey);
        if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
          throw new CoinbaseError('invalid_credentials');
        const seconds = Math.floor(this.now() / 1000);
        const header = Buffer.from(
          JSON.stringify({
            alg: 'ES256',
            typ: 'JWT',
            kid: credentials.keyName,
            nonce: randomBytes(16).toString('hex'),
          }),
        ).toString('base64url');
        const payload = Buffer.from(
          JSON.stringify({
            sub: credentials.keyName,
            iss: 'cdp',
            nbf: seconds,
            exp: seconds + 120,
            uri: `${method} api.coinbase.com${path.split('?')[0]}`,
          }),
        ).toString('base64url');
        const signed = `${header}.${payload}`;
        const signature = sign('sha256', Buffer.from(signed), {
          key,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url');
        if (controller.signal.aborted) throw new CoinbaseError('timeout');
        const response = await this.fetcher(`${ORIGIN}${path}`, {
          method,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${signed}.${signature}`,
            'Content-Type': 'application/json',
            'CB-VERSION': '2025-02-07',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new CoinbaseError(`http_${response.status}`);
        if (!response.body) throw new CoinbaseError('invalid_response');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new CoinbaseError('response_too_large');
          }
          chunks.push(part.value);
        }
        return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      };
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new CoinbaseError('timeout'));
          }, this.timeoutMs);
        }),
      ]);
    } catch (error) {
      // Upstream text, credential errors and URLs are intentionally never surfaced.
      if (error instanceof CoinbaseError) throw error;
      throw new CoinbaseError('request_failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** Verify the preconfigured destination against authenticated account and address resources. */
  async verifyDepositAddress(
    expected: CoinbaseDepositAddress,
    maxPages = 5,
  ): Promise<CoinbaseDepositAddress & { addressId: string; verifiedAt: number }> {
    identifier(expected.accountId);
    identifier(expected.asset);
    identifier(expected.network);
    if (
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 10 ||
      typeof expected.address !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,256}$/.test(expected.address)
    )
      throw new CoinbaseError('invalid_address_request');
    const accountPath = `/v2/accounts/${expected.accountId}`;
    const account = object((await this.request('GET', accountPath)).data);
    if (
      account.id !== expected.accountId ||
      account.resource !== 'account' ||
      account.resource_path !== accountPath ||
      account.type !== 'wallet' ||
      object(account.currency).code !== expected.asset
    )
      throw new CoinbaseError('deposit_account_mismatch');
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const path = `${accountPath}/addresses`;
      const response = await this.request(
        'GET',
        `${path}?limit=100${cursor ? `&starting_after=${cursor}` : ''}`,
      );
      if (!Array.isArray(response.data) || response.data.length > 100)
        throw new CoinbaseError('invalid_address_page');
      let lastId: string | undefined;
      for (const value of response.data) {
        const address = object(value);
        const id = identifier(address.id as string);
        if (seen.has(id)) throw new CoinbaseError('pagination_replay');
        seen.add(id);
        lastId = id;
        if (address.resource !== 'address' || address.resource_path !== `${path}/${id}`)
          throw new CoinbaseError('deposit_address_account_mismatch');
        if (address.address === expected.address && address.network === expected.network)
          return { ...expected, addressId: id, verifiedAt: this.now() };
      }
      const nextUri = object(response.pagination).next_uri;
      if (nextUri === null || nextUri === '')
        throw new CoinbaseError('deposit_address_not_verified');
      if (typeof nextUri !== 'string' || !lastId) throw new CoinbaseError('invalid_address_page');
      cursor = lastId;
    }
    throw new CoinbaseError('address_scan_limit');
  }
  /** Read-only recovery after an uncertain create response. Absence never authorizes a replacement ID. */
  async findMarketSell(
    clientOrderId: string,
    maxPages = 5,
  ): Promise<{ orderId: string; clientOrderId: string } | null> {
    identifier(clientOrderId);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10)
      throw new CoinbaseError('invalid_scan_limit');
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      const response = await this.request(
        'GET',
        `/api/v3/brokerage/orders/historical/batch?limit=100&product_type=SPOT&order_side=SELL${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (response.proof_token_required === true)
        throw new CoinbaseError('additional_authentication_required');
      if (
        !Array.isArray(response.orders) ||
        response.orders.length > 100 ||
        typeof response.has_next !== 'boolean'
      )
        throw new CoinbaseError('invalid_order_page');
      const matches = response.orders
        .map(object)
        .filter((order) => order.client_order_id === clientOrderId);
      if (matches.length > 1) throw new CoinbaseError('ambiguous_order_identity');
      if (matches.length === 1) {
        const order = matches[0];
        if (
          order.side !== 'SELL' ||
          order.product_type !== 'SPOT' ||
          typeof order.product_id !== 'string' ||
          !/^[A-Z0-9]{2,16}-USD$/.test(order.product_id)
        )
          throw new CoinbaseError('order_mismatch');
        object(object(order.order_configuration).market_market_ioc);
        return { orderId: identifier(order.order_id as string), clientOrderId };
      }
      if (!response.has_next) return null;
      if (typeof response.cursor !== 'string' || !response.cursor || response.cursor.length > 2048)
        throw new CoinbaseError('invalid_order_cursor');
      if (seen.has(response.cursor)) throw new CoinbaseError('pagination_replay');
      seen.add(response.cursor);
      cursor = response.cursor;
    }
    throw new CoinbaseError('order_scan_limit');
  }
  async createMarketSell(
    input: CoinbaseSellRequest,
  ): Promise<{ orderId: string; clientOrderId: string }> {
    validateSell(input);
    const response = await this.request('POST', '/api/v3/brokerage/orders', {
      client_order_id: input.clientOrderId,
      product_id: input.productId,
      side: 'SELL',
      order_configuration: { market_market_ioc: { base_size: input.baseSize } },
    });
    if (response.success !== true) throw new CoinbaseError('order_not_accepted');
    const order = object(response.success_response);
    if (
      order.client_order_id !== input.clientOrderId ||
      order.product_id !== input.productId ||
      order.side !== 'SELL'
    )
      throw new CoinbaseError('order_mismatch');
    const orderId = identifier(order.order_id as string);
    return { orderId, clientOrderId: input.clientOrderId };
  }
  async reconcileMarketSell(
    orderId: string,
    input: CoinbaseSellRequest,
  ): Promise<CoinbaseReconciledSale> {
    identifier(orderId);
    validateSell(input);
    const order = object(
      (await this.request('GET', `/api/v3/brokerage/orders/historical/${orderId}`)).order,
    );
    if (
      order.order_id !== orderId ||
      order.client_order_id !== input.clientOrderId ||
      order.product_id !== input.productId ||
      order.side !== 'SELL' ||
      order.product_type !== 'SPOT'
    )
      throw new CoinbaseError('order_mismatch');
    if (order.status !== 'FILLED' || order.settled !== true)
      throw new CoinbaseError('order_not_settled');
    const config = object(object(order.order_configuration).market_market_ioc);
    if (
      !equalDecimal(config.base_size, input.baseSize) ||
      !equalDecimal(order.filled_size, input.baseSize)
    )
      throw new CoinbaseError('order_size_mismatch');
    const gross = decimal(order.filled_value),
      fees = decimal(order.total_fees);
    const scale = Math.max(gross.scale, fees.scale);
    const units =
      gross.units * 10n ** BigInt(scale - gross.scale) -
      fees.units * 10n ** BigInt(scale - fees.scale);
    if (units <= 0n) throw new CoinbaseError('invalid_net_proceeds');
    const netQuoteAmount = formatDecimal(units, scale);
    if (
      order.total_value_after_fees !== undefined &&
      !equalDecimal(order.total_value_after_fees, netQuoteAmount)
    )
      throw new CoinbaseError('net_proceeds_mismatch');
    return {
      ...input,
      orderId,
      grossQuoteAmount: order.filled_value as string,
      feesQuoteAmount: order.total_fees as string,
      netQuoteAmount,
      spendableUsdCents: ((units * 100n) / 10n ** BigInt(scale)).toString(),
    };
  }
  async reconcileDeposit(
    transactionId: string,
    expected: CoinbaseDepositExpectation,
  ): Promise<CoinbaseVerifiedDeposit> {
    identifier(transactionId);
    validateDeposit(expected);
    const path = `/v2/accounts/${expected.accountId}/transactions/${transactionId}`;
    const tx = object((await this.request('GET', path)).data);
    const amount = object(tx.amount);
    if (
      tx.id !== transactionId ||
      tx.resource !== 'transaction' ||
      tx.resource_path !== path ||
      tx.type !== 'receive' ||
      tx.status !== 'completed' ||
      amount.currency !== expected.asset ||
      !equalDecimal(amount.amount, expected.amount)
    )
      throw new CoinbaseError('deposit_mismatch');
    // App API does not guarantee hash/network on receive; absence must never authorize conversion.
    const network = object(tx.network);
    if (
      network.status !== 'confirmed' ||
      network.hash !== expected.transactionHash ||
      network.network_name !== expected.network
    )
      throw new CoinbaseError('deposit_network_evidence_missing_or_mismatched');
    return { ...expected, transactionId, verifiedAt: this.now() };
  }
  /** One bounded page. The caller owns its durable cursor and maximum scan budget. */
  async listTransactionIds(
    accountId: string,
    startingAfter?: string,
  ): Promise<{ transactionIds: string[]; nextStartingAfter: string | null }> {
    identifier(accountId);
    if (startingAfter !== undefined) identifier(startingAfter);
    const path = `/v2/accounts/${accountId}/transactions`;
    const response = await this.request(
      'GET',
      `${path}?limit=100${startingAfter ? `&starting_after=${startingAfter}` : ''}`,
    );
    if (!Array.isArray(response.data) || response.data.length > 100)
      throw new CoinbaseError('invalid_transaction_page');
    const transactionIds = response.data.map((value) => {
      const tx = object(value);
      const id = identifier(tx.id as string);
      if (tx.resource !== 'transaction' || tx.resource_path !== `${path}/${id}`)
        throw new CoinbaseError('transaction_account_mismatch');
      return id;
    });
    if (
      new Set(transactionIds).size !== transactionIds.length ||
      transactionIds.includes(startingAfter ?? '')
    )
      throw new CoinbaseError('transaction_page_replay');
    const pagination = object(response.pagination);
    if (pagination.next_uri !== null && typeof pagination.next_uri !== 'string')
      throw new CoinbaseError('invalid_transaction_page');
    // Never fetch a provider-supplied URL. Derive next cursor solely from validated IDs.
    return {
      transactionIds,
      nextStartingAfter: pagination.next_uri ? (transactionIds.at(-1) ?? null) : null,
    };
  }
}
