import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KickCheckoutDriver,
  type KickSelectorContract,
} from '../server/providers/kick-checkout.ts';
import type { OwnedPage } from '../server/providers/browserbase-cdp.ts';
const intent = {
  accountId: 'pogdotfun',
  username: 'streamer',
  providerId: 'kick:42',
  giftUnits: 1,
  maxSpendUsdCents: 600,
  maxNativeMinorUnits: 600,
  cardLast4: '1234',
};
// Synthetic fixture contract. These selectors are not Kick DOM evidence.
const contract: KickSelectorContract = {
  version: 1,
  revision: 'fixture-v1',
  verifiedAt: new Date().toISOString(),
  evidenceDigest: 'a'.repeat(64),
  checkoutOrigin: 'https://kick.com',
  selectors: {
    account: '#account',
    channelUsername: '#channel',
    channelProviderId: '#provider',
    openGift: '#gift',
    quantityInput: '#quantity',
    openReview: '#review',
    reviewRoot: '#review-root',
    recipient: '#recipient',
    units: '#units',
    currency: '#currency',
    total: '#total',
    selectedCard: '#card',
    submit: '#submit',
    confirmationRoot: '#confirmation',
    receiptId: '#receipt',
    deliveryStatus: '#delivered',
  },
};
function fixture() {
  const state = {
    values: {
      '#account': 'pogdotfun',
      '#channel': 'streamer',
      '#provider': '42',
      '#recipient': 'streamer',
      '#units': '1',
      '#currency': 'USD',
      '#total': '5.00',
      '#card': 'American Express ending in 1234',
      '#receipt': 'receipt-42',
      '#delivered': 'Purchase successful',
      body: '',
    } as Record<string, string>,
    clicks: [] as string[],
    url: 'https://kick.com/streamer',
    confirmation: false,
    throwClick: false,
    owned: true,
  };
  const locator = (selector: string): any => ({
    count: async () => (selector === '#confirmation' ? Number(state.confirmation) : 1),
    isVisible: async () => (selector === '#confirmation' ? state.confirmation : true),
    isEnabled: async () => true,
    isChecked: async () => true,
    getAttribute: async () => null,
    innerText: async () => state.values[selector] ?? '',
    locator,
    inputValue: async () => state.values[selector],
    fill: async (value: string) => {
      state.values[selector] = value;
    },
    click: async () => {
      state.clicks.push(selector);
      if (selector === '#submit') {
        if (state.throwClick) throw Error('timeout');
        state.confirmation = true;
      }
    },
  });
  const frame: any = { url: () => state.url, locator };
  const page: any = {
    ...frame,
    frames: () => [frame],
    goto: async (url: string) => {
      state.url = url;
    },
  };
  const scope = {
    page,
    context: {},
    diagnosticIdentity: 'fixture-session',
    assertOwned() {
      if (!state.owned) throw Error('lease lost');
    },
  } as OwnedPage;
  return { state, scope, driver: new KickCheckoutDriver(contract) };
}
test('unconfigured Kick selector contract never navigates or purchases', async () => {
  const f = fixture();
  await assert.rejects(new KickCheckoutDriver().prepare(f.scope, intent), /contract_unverified/);
  assert.deepEqual(f.state.clicks, []);
});
test('Kick review verifies account, recipient, quantity, AmEx last four and exact USD total', async () => {
  const f = fixture();
  const quote = await f.driver.prepare(f.scope, intent);
  assert.equal(quote.recipientPlatform, 'kick');
  assert.equal(quote.nativeTotalMinorUnits, 500);
  assert.deepEqual(f.state.clicks, ['#gift', '#review']);
});
test('Kick holds every mismatched checkout fact and verification challenge', async () => {
  for (const [key, value] of Object.entries({
    '#account': 'someone',
    '#channel': 'other',
    '#provider': '99',
    '#recipient': 'other',
    '#units': '2',
    '#currency': 'CAD',
    '#total': '6.01',
    '#card': 'American Express ending in 9999',
    body: 'Two-factor authentication',
  })) {
    const f = fixture();
    f.state.values[key] = value;
    await assert.rejects(f.driver.readQuote(f.scope, intent));
    assert.deepEqual(f.state.clicks, []);
  }
});
test('Kick commits authority synchronously before exactly one purchase and binds receipt facts', async () => {
  const f = fixture();
  const quote = await f.driver.readQuote(f.scope, intent);
  let permitted = false;
  const delivered = await f.driver.submit(f.scope, intent, quote, () => {
    assert.deepEqual(f.state.clicks, []);
    permitted = true;
  });
  assert.ok(permitted);
  assert.match(delivered.evidenceDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(f.driver.submit(f.scope, intent, quote, () => {}));
  assert.deepEqual(f.state.clicks, ['#submit']);
});
test('Kick never repeats a timed-out submission; changed, stale, and async authority cannot click', async () => {
  const f = fixture();
  const quote = await f.driver.readQuote(f.scope, intent);
  f.state.throwClick = true;
  await assert.rejects(
    f.driver.submit(f.scope, intent, quote, () => {}),
    /outcome_unknown/,
  );
  await assert.rejects(f.driver.submit(f.scope, intent, quote, () => {}));
  assert.deepEqual(f.state.clicks, ['#submit']);
  for (const mode of ['changed', 'stale', 'async']) {
    const g = fixture();
    const q = await g.driver.readQuote(g.scope, intent);
    if (mode === 'changed') g.state.values['#total'] = '5.01';
    if (mode === 'stale') q.observedAt = '2000-01-01T00:00:00Z';
    await assert.rejects(
      g.driver.submit(g.scope, intent, q, mode === 'async' ? async () => {} : () => {}),
    );
    assert.deepEqual(g.state.clicks, []);
  }
});
test('Kick rejects untrusted frames, invalid contracts and lost ownership', async () => {
  const f = fixture();
  f.state.url = 'https://example.com/streamer';
  await assert.rejects(f.driver.readQuote(f.scope, intent));
  const g = fixture();
  g.state.owned = false;
  await assert.rejects(g.driver.prepare(g.scope, intent));
  await assert.rejects(
    new KickCheckoutDriver({ ...contract, evidenceDigest: '' }).prepare(f.scope, intent),
  );
});
test('concurrent Kick submissions consume purchase authority only once', async () => {
  const f = fixture();
  const quote = await f.driver.readQuote(f.scope, intent);
  let permits = 0;
  const outcomes = await Promise.allSettled([
    f.driver.submit(f.scope, intent, quote, () => {
      permits++;
    }),
    f.driver.submit(f.scope, intent, quote, () => {
      permits++;
    }),
  ]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(permits, 1);
  assert.deepEqual(f.state.clicks, ['#submit']);
});
test('Kick receipt must retain the exact approved total', async () => {
  const f = fixture();
  const quote = await f.driver.readQuote(f.scope, intent);
  f.state.confirmation = true;
  f.state.values['#total'] = '5.01';
  await assert.rejects(f.driver.readDelivery(f.scope, intent, quote));
});
