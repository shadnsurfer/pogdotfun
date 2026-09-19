/** Read-only chain observations. These estimates never enter spending or allocation accounting. */
export interface FeeAccrual {
  unclaimedUsdCents: number | null;
  unclaimedLamports: string | null;
  observedAt: string | null;
  status: 'fresh' | 'stale' | 'loading' | 'unavailable';
}
interface Observation {
  tokenId: string;
  mint: string;
  amountLamports: string;
  grossUsdCents: number;
  quote: { observedAt: string };
}
interface Entry {
  value?: Omit<FeeAccrual, 'status'>;
  retryAt: number;
  pending: boolean;
}
const FRESH_MS = 60_000;
const STALE_MS = 300_000;

export class UnclaimedFeeCache {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: { id: string; address: string; entry: Entry }[] = [];
  private readonly active = new Set<Promise<void>>();
  private closed = false;
  constructor(
    private readonly read: (tokenId: string) => Promise<Observation>,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot<T extends { id: string; address: string }>(
    tokens: T[],
  ): (T & { feeAccrual: FeeAccrual })[] {
    const clock = this.now();
    const wanted = new Set(tokens.map((token) => `${token.id}:${token.address}`));
    for (const key of this.entries.keys()) if (!wanted.has(key)) this.entries.delete(key);
    const result = tokens.map((token) => {
      const key = `${token.id}:${token.address}`;
      let entry = this.entries.get(key);
      if (!entry) {
        entry = { retryAt: 0, pending: false };
        this.entries.set(key, entry);
      }
      if (!this.closed && !entry.pending && clock >= entry.retryAt) {
        entry.pending = true;
        this.queue.push({ id: token.id, address: token.address, entry });
      }
      const age = entry.value?.observedAt ? clock - Date.parse(entry.value.observedAt) : Infinity;
      const value = age <= STALE_MS ? entry.value : undefined;
      const feeAccrual: FeeAccrual = value
        ? { ...value, status: age <= FRESH_MS ? 'fresh' : 'stale' }
        : {
            unclaimedUsdCents: null,
            unclaimedLamports: null,
            observedAt: null,
            status: entry.pending ? 'loading' : 'unavailable',
          };
      return { ...token, feeAccrual };
    });
    this.pump();
    return result;
  }

  private pump() {
    while (!this.closed && this.active.size < 2 && this.queue.length) {
      const item = this.queue.shift()!;
      const work = Promise.resolve()
        .then(async () => {
          try {
            const result = await this.read(item.id);
            const observed = Date.parse(result.quote.observedAt);
            if (
              result.tokenId !== item.id ||
              result.mint !== item.address ||
              !Number.isSafeInteger(result.grossUsdCents) ||
              result.grossUsdCents < 0 ||
              !/^\d{1,30}$/.test(result.amountLamports) ||
              !Number.isFinite(observed) ||
              observed > this.now() + 5000 ||
              this.now() - observed > 120_000
            )
              throw new Error('Invalid fee observation');
            item.entry.value = {
              unclaimedUsdCents: result.grossUsdCents,
              unclaimedLamports: result.amountLamports,
              observedAt: new Date(observed).toISOString(),
            };
          } catch {
            /* Retain a bounded stale observation; never turn a failed read into zero fees. */
          } finally {
            item.entry.pending = false;
            item.entry.retryAt = this.now() + FRESH_MS;
          }
        })
        .finally(() => {
          this.active.delete(work);
          this.pump();
        });
      this.active.add(work);
    }
  }

  async idle() {
    while (this.active.size) await Promise.all(this.active);
  }
  async close() {
    this.closed = true;
    this.queue.length = 0;
    await this.idle();
  }
}
