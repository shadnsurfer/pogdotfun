import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  parseTwitchCheckout,
  parseTwitchDelivery,
  TwitchCheckoutDriver,
  TwitchCheckoutError,
} from '../server/providers/twitch-checkout.ts';
import type { OwnedPage } from '../server/providers/browserbase-cdp.ts';

const intent = {
  accountId: 'pogdotfun',
  username: 'cloverreggie',
  providerId: 'twitch:1422545006',
  giftUnits: 1,
  maxSpendUsdCents: 900,
  maxNativeMinorUnits: 4000,
  cardLast4: '5183',
};
const checkout =
  "Gift 1 Tier 1 Subscription to CloverReggie's community\nSelected payment method: Visa ending in 5183\nSubtotal\nHK$31.99\nTax\nHK$4.21\nTotal\nHK$36.20\nComplete Purchase";
test('native taxed checkout is preserved and bounded before a gift', () => {
  const q = parseTwitchCheckout(checkout, intent, '2026-09-16T12:00:00.000Z');
  assert.equal(q.nativeCurrency, 'HKD');
  assert.equal(q.nativeTotalMinorUnits, 3620);
  assert.equal(q.recipientUsername, 'cloverreggie');
  assert.equal(q.giftUnits, 1);
  assert.equal('totalUsdCents' in q, false);
});
test('wrong recipient, card, quantity, currency, changed total and verification stop checkout', () => {
  for (const text of [
    checkout.replace('CloverReggie', 'secretkatchii'),
    checkout.replace('5183', '1234'),
    checkout.replace('Gift 1 ', 'Gift 10 '),
    checkout.replaceAll('HK$', '$'),
    checkout.replace('HK$36.20', 'HK$136.20'),
    checkout + '\nVerify you are human',
    checkout + '\nTotal\nHK$40.00',
    checkout.replace('HK$36.20', 'HK$36.20 USD'),
    checkout.replace('HK$36.20', 'US$5.00 HKD'),
    checkout.replace(
      'Selected payment method: Visa ending in 5183',
      'Selected card ending in 1234\nOther saved card ending in 5183',
    ),
  ])
    assert.throws(() => parseTwitchCheckout(text, intent, '2026-09-16T12:00:00.000Z'));
});
test('a card charge alone or unrelated success cannot establish recipient delivery', () => {
  assert.equal(
    parseTwitchDelivery(
      "Purchase Successful\nYou have gifted 1 Tier 1 subscription to CloverReggie's community!",
      intent,
    ),
    true,
  );
  for (const text of [
    'Purchase Successful',
    "Purchase Successful\nYou have gifted 10 Tier 1 subscriptions to CloverReggie's community!",
    "Purchase Successful\nYou have gifted 1 Tier 1 subscription to secretkatchii's community!",
  ])
    assert.equal(parseTwitchDelivery(text, intent), false);
});

test('final UI submission follows the durable permit exactly once; uncertain clicks are not retried', async () => {
  const quote = parseTwitchCheckout(checkout, intent, '2026-09-16T12:00:00.000Z');
  for (const mode of [
    'success',
    'changed',
    'no-permit',
    'uncertain',
    'lease-lost',
    'async-permit',
  ]) {
    const actions: string[] = [];
    let displayed = mode === 'changed' ? checkout.replace('HK$36.20', 'HK$36.21') : checkout;
    const button = {
      count: async () => 1,
      isEnabled: async () => true,
      click: async () => {
        actions.push('purchase');
        if (mode === 'uncertain') throw Error('network timeout');
        displayed =
          "Purchase Successful\nYou have gifted 1 Tier 1 subscription to CloverReggie's community!";
      },
    };
    const frame = {
      url: () => 'https://checkout.twitch.tv/checkout',
      locator: () => ({ innerText: async () => displayed }),
      getByRole: (role: string) =>
        role === 'radio'
          ? { count: async () => 1, getAttribute: async () => 'Visa ending in 5183' }
          : button,
    };
    const scope = {
      page: { frames: () => [frame] },
      assertOwned: () => {
        if (mode === 'lease-lost') throw Error('lease lost');
      },
    } as unknown as OwnedPage;
    const run = () =>
      new TwitchCheckoutDriver().submit(scope, intent, quote, () => {
        actions.push('permit');
        if (mode === 'no-permit') throw Error('already submitted');
        if (mode === 'async-permit') return Promise.resolve();
      });
    if (mode === 'success') {
      const result = await run();
      assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/);
      assert.deepEqual(actions, ['permit', 'purchase']);
    } else {
      await assert.rejects(run());
      assert.deepEqual(
        actions,
        mode === 'uncertain'
          ? ['permit', 'purchase']
          : mode === 'no-permit' || mode === 'async-permit'
            ? ['permit']
            : [],
      );
    }
  }
});

test('inspection does not expose arbitrary card or account labels', async () => {
  const frame = {
    url: () => 'https://checkout.twitch.tv/review',
    locator: () => ({
      innerText: async () => 'Total\nHK$36.20\nGift 4111111111111111 to fixture@example.test',
      count: async () => 0,
    }),
    getByRole: (role: string, options?: { name?: unknown; level?: number }) => ({
      count: async () =>
        role === 'heading'
          ? options?.name instanceof RegExp
            ? options.level === 1
              ? 0
              : 1
            : options?.level === 1
              ? 0
              : 2
          : role === 'dialog'
            ? 0
            : 1,
      allTextContents: async () =>
        role === 'heading'
          ? options?.level === 2
            ? [' CloverReggie ', 'Private fixture@example.test']
            : []
          : ['Complete Purchase', 'Use card 4111111111111111 for fixture@example.test'],
    }),
  };
  const scope = {
    page: { frames: () => [frame] },
    context: { pages: () => [] },
    assertOwned: () => {},
  } as unknown as OwnedPage;
  const inspected = await new TwitchCheckoutDriver().inspect(scope);
  const serialized = JSON.stringify(inspected);
  assert.equal(serialized.includes('4111111111111111'), false);
  assert.equal(serialized.includes('fixture@example.test'), false);
  assert.equal(serialized.includes('Complete Purchase'), true);
  assert.ok('structure' in inspected.frames[0]);
  assert.deepEqual(inspected.frames[0].structure?.headings, { level1: 0, level2: 2, level3: 2 });
  assert.deepEqual(inspected.frames[0].structure?.recipientHeadings, {
    all: 1,
    level1: 0,
    level2: 1,
    level3: 1,
  });
  assert.deepEqual(inspected.frames[0].structure?.recipientHeadingText, {
    level1: 0,
    level2: 1,
    level3: 0,
  });
});

test('diagnostic inventories cap output and classify unknown origins without reading their DOM', async () => {
  const frames = Array.from({ length: 40 }, () => ({
    url: () => 'https://private-subdomain.example.test/private?token=secret#fragment',
  }));
  const pages = Array.from({ length: 12 }, () => ({
    isClosed: () => false,
    url: () => 'https://user:password@unknown.example.test/private?token=secret',
  }));
  const scope = {
    page: { frames: () => frames },
    context: { pages: () => pages },
    assertOwned: () => {},
  } as unknown as OwnedPage;
  const result = await new TwitchCheckoutDriver().inspect(scope);
  assert.equal(result.inventory.openPageCount, 12);
  assert.equal(result.inventory.openPageOrigins.length, 10);
  assert.equal(result.inventory.pagesTruncated, true);
  assert.equal(result.inventory.totalFrameCount, 40);
  assert.equal(result.inventory.framesTruncated, true);
  assert.equal(result.frames.length, 30);
  assert.ok(result.frames.every((frame) => frame.origin === 'unrecognized' && frame.excluded));
  assert.doesNotMatch(JSON.stringify(result), /private|unknown\.example|password|secret|fragment/);
});

test('inspection refuses results when ownership is lost during a DOM read', async () => {
  let owned = true;
  const frame = {
    url: () => 'https://www.twitch.tv/channel',
    locator: () => ({
      innerText: async () => {
        owned = false;
        return 'Payment';
      },
    }),
  };
  const scope = {
    page: { frames: () => [frame] },
    context: { pages: () => [] },
    assertOwned: () => {
      if (!owned) throw Error('synthetic lease lost');
    },
  } as unknown as OwnedPage;
  await assert.rejects(new TwitchCheckoutDriver().inspect(scope), /synthetic lease lost/);
});

test('checkout diagnostics sanitize both code and phase at runtime', () => {
  const unsafe = new TwitchCheckoutError(
    'private account text' as never,
    'private card text' as never,
  );
  assert.equal(unsafe.code, 'unexpected_checkout');
  assert.equal(unsafe.phase, undefined);
  assert.doesNotMatch(unsafe.message, /private/);
  const safe = new TwitchCheckoutError('verification_required', 'payment_review');
  assert.equal(safe.phase, 'payment_review');
  assert.match(safe.message, /payment_review/);
});

test('account diagnostics return bounded top-navigation control attributes only from the main channel frame', async () => {
  const attributes = [
    { 'aria-label': 'User avatar', title: 'Profile', 'data-a-target': 'user-menu-toggle' },
    {
      'aria-label': 'Account fixture@example.test',
      title: 'Account 4111111111111111',
      'data-a-target': 'unrelated-control',
    },
    { 'aria-label': 'User https://secret.test', title: 'Profile ' + 'x'.repeat(90) },
  ];
  let attributeReads = 0;
  const node = {
    count: async () => 2,
    filter: () => ({ count: async () => 1 }),
    allTextContents: async () => [],
    innerText: async () => '',
    evaluateAll: async (read: (items: unknown[]) => unknown) => {
      attributeReads++;
      const items = attributes.map((item) => ({
        getAttribute: (name: string) => item[name as keyof typeof item] ?? null,
      }));
      // Playwright serializes this callback into Chromium, which has no tsx helpers.
      return JSON.parse(JSON.stringify(runInNewContext(`(${read.toString()})(items)`, { items })));
    },
  };
  const frame = {
    url: () => 'https://www.twitch.tv/cloverreggie',
    locator: () => node,
    getByRole: () => node,
  };
  const child = { ...frame };
  const scope = {
    page: { frames: () => [frame, child], mainFrame: () => frame },
    context: { pages: () => [] },
    assertOwned: () => {},
  } as unknown as OwnedPage;
  const result = await new TwitchCheckoutDriver().inspect(scope);
  assert.ok('structure' in result.frames[0]);
  assert.ok('structure' in result.frames[1]);
  const controls = result.frames[0].structure?.accountControls;
  assert.equal(attributeReads, 1);
  assert.equal(result.frames[1].structure?.accountControls, undefined);
  assert.deepEqual(controls?.targets['user-menu-toggle'], { count: 2, visible: 1 });
  assert.deepEqual(controls?.roles['User Menu'], { count: 2, visible: 1 });
  assert.deepEqual(controls?.attributes, [
    { ariaLabel: 'User avatar', title: 'Profile', target: 'user-menu-toggle' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /fixture@example|411111|secret\.test|xxxxxxxx/);
});

function giftFormFixture(onReview: () => void, onSelect: () => void, mode = 'valid') {
  let stale = false;
  const cards = Array.from({ length: mode === 'duplicate-caption' ? 2 : 1 }, () => ({
    caption: mode === 'wrong-quantity' ? 'Gift 10 Subs' : 'Gift 1 Sub',
    artwork: mode === 'wrong-artwork' ? 'Gift 10 Subs at random.' : 'Gift 1 Sub at random.',
    buttons: mode === 'duplicate-button' ? 2 : 1,
  }));
  return {
    getByRole: (role: string) => {
      assert.equal(role, 'combobox', 'quantity choice is a caption next to an unnamed button');
      return { selectOption: async () => onSelect() };
    },
    getByText: (text: string, options: { exact: boolean }) => {
      assert.equal(options.exact, true);
      const matched = cards.filter((card) => card.caption === text);
      return {
        waitFor: async () => {
          if (!matched.length) throw Error('exact quantity caption absent');
          stale = mode === 'stale-caption';
        },
        count: async () => (stale ? 0 : matched.length),
        locator: (selector: string) => {
          assert.equal(selector, 'xpath=ancestor::div[.//button][1]');
          return {
            count: async () => (mode === 'duplicate-card' ? 2 : matched.length),
            getByRole: (role: string, options?: { name: string; exact: boolean }) => {
              if (role === 'img') {
                assert.equal(options?.exact, true);
                return {
                  count: async () =>
                    matched.filter((card) => card.artwork === options?.name).length,
                };
              }
              assert.equal(role, 'button');
              return {
                count: async () => matched.reduce((sum, card) => sum + card.buttons, 0),
                click: async () => onReview(),
              };
            },
          };
        },
      };
    },
  };
}

test('prepare identifies the failed phase without exposing locator or page errors or submitting', async () => {
  for (const phase of [
    'channel_heading',
    'account_menu',
    'gift_dialog',
    'payment_review',
  ] as const) {
    const actions: string[] = [];
    const failAt = (step: string) => {
      actions.push(step);
      if (step === phase) throw Error('private DOM fixture@example.test 4111111111111111');
    };
    const menu = {
      count: async () => 1,
      waitFor: async () => {},
      getByText: () => ({ waitFor: async () => failAt('account_menu') }),
    };
    const gifts = giftFormFixture(
      () => actions.push('review-opened'),
      () => failAt('gift_dialog'),
    );
    const frame = {
      url: () => 'https://checkout.twitch.tv/review',
      locator: () => ({ innerText: async () => 'Verify you are human' }),
    };
    const scope = {
      assertOwned: () => {},
      page: {
        goto: async () => {},
        locator: (selector: string) =>
          selector === '[data-a-target="dropdown-main"][aria-label="User Menu Options"]'
            ? menu
            : { count: async () => 1, click: async () => {} },
        keyboard: { press: async () => {} },
        frames: () => [frame],
        getByRole: (role: string, options?: { name?: unknown }) => {
          if (role === 'heading') return { waitFor: async () => failAt('channel_heading') };
          if (role === 'dialog') return options?.name ? gifts : { filter: () => menu };
          if (options?.name === 'Log In') return { isVisible: async () => false };
          return {
            first: () => ({ click: async () => {} }),
            click: async () => actions.push('gift-opened'),
          };
        },
      },
    } as unknown as OwnedPage;
    await assert.rejects(new TwitchCheckoutDriver().prepare(scope, intent), (error: unknown) => {
      assert.ok(error instanceof TwitchCheckoutError);
      assert.equal(error.phase, phase);
      assert.equal(
        error.code,
        phase === 'payment_review' ? 'verification_required' : 'unexpected_checkout',
      );
      assert.doesNotMatch(error.message, /private DOM|fixture@example|411111/);
      return true;
    });
    assert.equal(actions.includes('purchase'), false);
    if (phase === 'channel_heading' || phase === 'account_menu')
      assert.equal(actions.includes('gift-opened'), false);
  }
});

test('visible menu contents verify the donor and exact quantity card before review despite unnamed controls and a zero-size wrapper', async () => {
  for (const mode of [
    'correct-donor',
    'wrong-donor',
    'missing-control',
    'ambiguous-control',
    'stale-caption',
    'wrong-quantity',
    'wrong-artwork',
    'duplicate-caption',
    'duplicate-card',
    'duplicate-button',
  ]) {
    const actions: string[] = [];
    let menuVisible = false;
    const menu = {
      waitFor: async () => {
        assert.equal(menuVisible, true);
        actions.push('menu-visible');
      },
      count: async () => 1,
      getByText: (name: string, options: { exact: boolean }) => ({
        waitFor: async () => {
          assert.equal(name, intent.accountId);
          assert.equal(options.exact, true);
          if (mode === 'wrong-donor') throw Error('private different donor');
          actions.push('donor-verified');
        },
      }),
    };
    const gifts = giftFormFixture(
      () => actions.push('payment-review'),
      () => {},
      mode,
    );
    const frame = {
      url: () => 'https://checkout.twitch.tv/review',
      locator: () => ({ innerText: async () => checkout }),
      getByRole: (role: string) =>
        role === 'radio'
          ? { count: async () => 1, getAttribute: async () => 'Visa ending in 5183' }
          : { count: async () => 1 },
    };
    const scope = {
      assertOwned: () => {},
      page: {
        goto: async () => {},
        frames: () => [frame],
        keyboard: { press: async () => actions.push('close-menu') },
        locator: (selector: string) =>
          selector === 'button[data-a-target="user-menu-toggle"]'
            ? {
                count: async () =>
                  mode === 'missing-control' ? 0 : mode === 'ambiguous-control' ? 2 : 1,
                click: async () => {
                  actions.push('open-menu');
                  menuVisible = true;
                },
              }
            : selector === '[data-a-target="dropdown-main"][aria-label="User Menu Options"]'
              ? menu
              : {},
        getByRole: (role: string, options?: { name?: unknown }) => {
          if (role === 'heading') return { waitFor: async () => {} };
          if (role === 'dialog')
            return options?.name
              ? gifts
              : {
                  filter: () => ({
                    count: async () => 1,
                    waitFor: async () => {
                      throw Error('Dialog wrapper has zero size despite visible menu contents');
                    },
                  }),
                };
          if (options?.name === 'Log In') return { isVisible: async () => false };
          assert.equal(
            options?.name,
            'Gift a Sub',
            'nameless account control must use its observed stable target',
          );
          return { click: async () => actions.push('gift-opened') };
        },
      },
    } as unknown as OwnedPage;
    const prepared = new TwitchCheckoutDriver().prepare(scope, intent);
    if (mode === 'correct-donor') {
      assert.equal((await prepared).nativeTotalMinorUnits, 3620);
      assert.deepEqual(actions, [
        'open-menu',
        'menu-visible',
        'donor-verified',
        'close-menu',
        'gift-opened',
        'payment-review',
      ]);
    } else {
      await assert.rejects(
        prepared,
        (error: unknown) =>
          error instanceof TwitchCheckoutError &&
          error.phase ===
            (['wrong-donor', 'missing-control', 'ambiguous-control'].includes(mode)
              ? 'account_menu'
              : 'gift_dialog'),
      );
      assert.deepEqual(
        actions,
        mode === 'wrong-donor'
          ? ['open-menu', 'menu-visible']
          : ['missing-control', 'ambiguous-control'].includes(mode)
            ? []
            : ['open-menu', 'menu-visible', 'donor-verified', 'close-menu', 'gift-opened'],
      );
    }
  }
});

test('channel pages and lookalike checkout origins cannot provide a purchase quote', async () => {
  for (const url of [
    'https://www.twitch.tv/cloverreggie',
    'https://checkout.twitch.tv.evil.test/review',
    'http://checkout.twitch.tv/review',
  ]) {
    let bodyReads = 0;
    const frame = {
      url: () => url,
      locator: () => ({
        innerText: async () => {
          bodyReads++;
          return checkout;
        },
      }),
    };
    const scope = {
      page: { frames: () => [frame] },
      assertOwned: () => {},
    } as unknown as OwnedPage;
    await assert.rejects(new TwitchCheckoutDriver().readQuote(scope, intent));
    assert.equal(bodyReads, 0);
  }
});

test('selected card radio must be unique and match the reviewed card before any permit', async () => {
  const quote = parseTwitchCheckout(checkout, intent, '2026-09-16T12:00:00.000Z');
  for (const [count, label] of [
    [0, 'Visa ending in 5183'],
    [2, 'Visa ending in 5183'],
    [1, 'Visa ending in 1234'],
    [1, 'Visa ending in 5183 and another card'],
  ] as const) {
    let permits = 0;
    let clicks = 0;
    const frame = {
      url: () => 'https://checkout.twitch.tv/review',
      locator: () => ({ innerText: async () => checkout }),
      getByRole: (role: string) =>
        role === 'radio'
          ? { count: async () => count, getAttribute: async () => label }
          : {
              count: async () => 1,
              isEnabled: async () => true,
              click: async () => {
                clicks++;
              },
            },
    };
    const scope = {
      page: { frames: () => [frame] },
      assertOwned: () => {},
    } as unknown as OwnedPage;
    await assert.rejects(
      new TwitchCheckoutDriver().submit(scope, intent, quote, () => {
        permits++;
      }),
    );
    assert.equal(permits, 0);
    assert.equal(clicks, 0);
  }
});

test('a checkout frame leaving its origin after one click stays unknown despite channel success text', async () => {
  const quote = parseTwitchCheckout(checkout, intent, '2026-09-16T12:00:00.000Z');
  let url = 'https://checkout.twitch.tv/review';
  let clicks = 0;
  const fakeConfirmation =
    "Purchase Successful\nYou have gifted 1 Tier 1 subscription to CloverReggie's community!";
  const frame = {
    url: () => url,
    locator: () => ({ innerText: async () => (clicks ? fakeConfirmation : checkout) }),
    getByRole: (role: string) =>
      role === 'radio'
        ? { count: async () => 1, getAttribute: async () => 'Visa ending in 5183' }
        : {
            count: async () => 1,
            isEnabled: async () => true,
            click: async () => {
              clicks++;
              url = 'https://www.twitch.tv/cloverreggie';
            },
          },
  };
  const scope = { page: { frames: () => [frame] }, assertOwned: () => {} } as unknown as OwnedPage;
  await assert.rejects(
    new TwitchCheckoutDriver().submit(scope, intent, quote, () => {}),
    /outcome_unknown/,
  );
  assert.equal(clicks, 1);
});

test('production quantities require explicit opt-in and preserve exact native quote identity', () => {
  const production = {
    ...intent,
    production: true as const,
    giftUnits: 11,
    maxSpendUsdCents: 5500,
    maxNativeMinorUnits: 40000,
  };
  const text = checkout
    .replace('Gift 1 Tier 1 Subscription', 'Gift 11 Tier 1 Subscriptions')
    .replace('HK$36.20', 'HK$398.20');
  const quote = parseTwitchCheckout(text, production, '2026-09-16T12:00:00.000Z');
  assert.equal(quote.giftUnits, 11);
  assert.equal(quote.nativeTotalMinorUnits, 39820);
  assert.equal('totalUsdCents' in quote, false);
  for (const changed of [
    { ...production, production: undefined },
    { ...production, production: 'true' },
    { ...production, giftUnits: 10 },
    { ...production, username: 'another_recipient' },
    { ...production, cardLast4: '1234' },
    { ...production, maxNativeMinorUnits: 39819 },
  ])
    assert.throws(() =>
      parseTwitchCheckout(text, changed as typeof production, '2026-09-16T12:00:00.000Z'),
    );
  assert.equal(
    parseTwitchDelivery(
      "Purchase Successful\nYou have gifted 11 Tier 1 subscriptions to CloverReggie's community!",
      production,
    ),
    true,
  );
  assert.equal(
    parseTwitchDelivery(
      "Purchase Successful\nYou have gifted 10 Tier 1 subscriptions to CloverReggie's community!",
      production,
    ),
    false,
  );
});

test('production rejects invalid quantities and keeps exact USD spending ceiling', () => {
  for (const units of [0, -1, 1.5, 101, NaN, Infinity]) {
    assert.throws(() =>
      parseTwitchCheckout(
        checkout,
        { ...intent, production: true, giftUnits: units },
        '2026-09-16T12:00:00.000Z',
      ),
    );
  }
  const usd = checkout
    .replace('Gift 1 Tier 1 Subscription', 'Gift 10 Tier 1 Subscriptions')
    .replace('HK$36.20', 'US$55.00');
  const production = {
    ...intent,
    production: true as const,
    giftUnits: 10,
    maxSpendUsdCents: 5500,
    maxNativeMinorUnits: 5500,
  };
  assert.equal(
    parseTwitchCheckout(usd, production, '2026-09-16T12:00:00.000Z').totalUsdCents,
    5500,
  );
  assert.throws(() =>
    parseTwitchCheckout(usd, { ...production, maxSpendUsdCents: 5499 }, '2026-09-16T12:00:00.000Z'),
  );
});

test('production native policy does not loosen legacy acceptance planning bounds', () => {
  const overLegacyBound = { ...intent, maxSpendUsdCents: 723 };
  assert.throws(() => parseTwitchCheckout(checkout, overLegacyBound, '2026-09-16T12:00:00.000Z'));
  const production = parseTwitchCheckout(
    checkout,
    { ...overLegacyBound, production: true },
    '2026-09-16T12:00:00.000Z',
  );
  assert.equal(production.nativeTotalMinorUnits, 3620);
  assert.equal('totalUsdCents' in production, false);
  const hundred = checkout.replace('Gift 1 Tier 1 Subscription', 'Gift 100 Tier 1 Subscriptions');
  assert.equal(
    parseTwitchCheckout(
      hundred,
      { ...intent, production: true, giftUnits: 100 },
      '2026-09-16T12:00:00.000Z',
    ).giftUnits,
    100,
  );
});

test('read-only delivery reconciliation recovers exact trusted success without checkout actions', async () => {
  const production = { ...intent, production: true as const, giftUnits: 10 };
  const success =
    "Purchase Successful\nYou have gifted 10 Tier 1 subscriptions to CloverReggie's community!";
  for (const [text, expected] of [
    [success, true],
    [success.replace('10 Tier', '1 Tier'), false],
    [success.replace('CloverReggie', 'other_recipient'), false],
    ['Payment processing', false],
  ] as const) {
    const frame = {
      url: () => 'https://checkout.twitch.tv/result',
      locator: () => ({ innerText: async () => text }),
    };
    const scope = { page: { frames: () => [frame] }, assertOwned() {} } as unknown as OwnedPage;
    const delivery = await new TwitchCheckoutDriver().readDelivery(scope, production);
    assert.equal(Boolean(delivery), expected);
    if (delivery) {
      assert.match(delivery.evidenceDigest, /^[a-f0-9]{64}$/);
      assert.equal(Number.isFinite(Date.parse(delivery.completedAt)), true);
    }
  }
});

test('read-only delivery rejects ambiguous frames, challenges, and lost ownership', async () => {
  const success =
    "Purchase Successful\nYou have gifted 1 Tier 1 subscription to CloverReggie's community!";
  for (const mode of ['duplicate', 'challenge', 'lease-lost', 'origin-changed', 'untrusted']) {
    let owned = true;
    let url =
      mode === 'untrusted'
        ? 'https://untrusted.invalid/result'
        : 'https://checkout.twitch.tv/result';
    const frame = {
      url: () => url,
      locator: () => ({
        innerText: async () => {
          assert.notEqual(mode, 'untrusted', 'Untrusted DOM must not be read');
          if (mode === 'lease-lost') owned = false;
          if (mode === 'origin-changed') url = 'https://untrusted.invalid/result';
          return mode === 'challenge' ? 'Verify you are human' : success;
        },
      }),
    };
    const scope = {
      page: { frames: () => (mode === 'duplicate' ? [frame, frame] : [frame]) },
      assertOwned() {
        if (!owned) throw Error('lease lost');
      },
    } as unknown as OwnedPage;
    const action = () => new TwitchCheckoutDriver().readDelivery(scope, intent);
    if (mode === 'untrusted') assert.equal(await action(), null);
    else await assert.rejects(action());
  }
});
