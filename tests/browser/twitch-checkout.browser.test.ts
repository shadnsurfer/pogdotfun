import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import type { OwnedPage } from '../../server/providers/browserbase-cdp.ts';
import {
  TwitchCheckoutDriver,
  TwitchCheckoutError,
} from '../../server/providers/twitch-checkout.ts';

const intent = {
  accountId: 'pogdotfun',
  username: 'cloverreggie',
  providerId: 'twitch:1422545006',
  giftUnits: 1,
  maxSpendUsdCents: 900,
  maxNativeMinorUnits: 4000,
  cardLast4: '5183',
};
const channelUrl = 'https://www.twitch.tv/cloverreggie';
const templates = {
  channel: readFileSync(new URL('./fixtures/twitch-channel.html', import.meta.url), 'utf8'),
  checkout: readFileSync(new URL('./fixtures/twitch-checkout.html', import.meta.url), 'utf8'),
};
interface FixtureConfig {
  donor?: string;
  total?: string;
  duplicateCustom?: boolean;
  duplicateCustomButton?: boolean;
  customValueReset?: boolean;
  duplicateAccount?: boolean;
  duplicateCaption?: boolean;
  duplicateCardButton?: boolean;
  wrongArtwork?: boolean;
  frameCount?: number;
  frameOrigin?: string;
  frameDelayMs?: number;
  cardLast4?: string;
  quantity?: number;
  recipient?: string;
  duplicateSelectedCard?: boolean;
  duplicatePurchaseButton?: boolean;
  ambiguousSubmit?: boolean;
}
let browser: Browser;
before(async () => {
  const candidates = [
    process.env.POG_CHECKOUT_TEST_CHROMIUM,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  const executablePath = candidates.find((path) => path && existsSync(path));
  assert.ok(
    executablePath,
    'No test Chromium installed. Set POG_CHECKOUT_TEST_CHROMIUM to an existing executable; this harness never installs browsers.',
  );
  browser = await chromium.launch({
    executablePath,
    headless: true,
    // Defense in depth: fixtures are fulfilled before network; an unrouted request
    // cannot reach a provider even if the routing guard regresses.
    proxy: { server: 'http://127.0.0.1:1', bypass: '' },
    args: ['--disable-background-networking', '--disable-component-update'],
  });
});
after(async () => {
  await browser?.close();
});

async function fixture(config: FixtureConfig = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const events: string[] = [];
  const requests: string[] = [];
  const aborted: string[] = [];
  await context.exposeBinding('fixtureEvent', (_source, event: string) => {
    events.push(event);
  });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(request.url());
    let body: string | undefined;
    if (request.method() === 'GET' && request.url() === channelUrl) body = templates.channel;
    else if (
      request.method() === 'GET' &&
      [
        'https://checkout.twitch.tv',
        'https://untrusted.invalid',
        'http://checkout.twitch.tv',
      ].includes(url.origin) &&
      url.pathname === '/fixture-checkout'
    )
      body = templates.checkout;
    else if (
      request.method() === 'GET' &&
      request.url() === 'https://untrusted.invalid/fixture-result'
    )
      body = '<!doctype html><title>Ambiguous synthetic result</title><p>Processing</p>';
    if (!body) {
      aborted.push(request.url());
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: body.replace(
        '__POG_FIXTURE_CONFIG__',
        JSON.stringify(config).replaceAll('<', '\\u003c'),
      ),
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(500);
  page.setDefaultNavigationTimeout(3000);
  let owned = true;
  const scope: OwnedPage = {
    page,
    context,
    assertOwned() {
      assert.ok(owned, 'Synthetic driver lease lost');
    },
  };
  return {
    scope,
    page,
    events,
    requests,
    aborted,
    close: () => context.close(),
    loseOwnership: () => {
      owned = false;
    },
  };
}

test('regression: historical named controls fail on the reduced observed structure', async () => {
  const f = await fixture();
  try {
    await f.page.goto(channelUrl);
    assert.equal(await f.page.getByRole('button', { name: 'User Menu', exact: true }).count(), 0);
    await f.page.locator('button[data-a-target="user-menu-toggle"]').click();
    assert.equal(await f.page.locator('#account-wrapper').isVisible(), false);
    assert.equal(await f.page.locator('#account-menu').isVisible(), true);
    assert.equal(
      await f.page
        .locator('#account-wrapper')
        .evaluate((element) => element.getBoundingClientRect().width),
      0,
    );
    await f.page.keyboard.press('Escape');
    await f.page.getByRole('button', { name: 'Gift a Sub', exact: true }).click();
    assert.equal(await f.page.getByText('Gift 1 Sub', { exact: true }).count(), 1);
    // First run failed here with a real Playwright TimeoutError; keep the old
    // strategy's failure as a permanent regression characterization.
    await assert.rejects(
      f.page.getByRole('button', { name: 'Gift 1 Sub', exact: true }).click({ timeout: 200 }),
      { name: 'TimeoutError' },
    );
    assert.deepEqual(f.events, []);
  } finally {
    await f.close();
  }
});

test('prepare scopes the unnamed quantity button by XPath and awaits delayed trusted review without purchasing', async () => {
  const f = await fixture({ frameDelayMs: 150 });
  try {
    const quote = await new TwitchCheckoutDriver().prepare(f.scope, intent);
    assert.equal(quote.nativeCurrency, 'HKD');
    assert.equal(quote.nativeTotalMinorUnits, 3620);
    assert.equal(quote.giftUnits, 1);
    assert.equal(quote.recipientProviderId, intent.providerId);
    assert.equal('totalUsdCents' in quote, false);
    assert.deepEqual(f.events, ['quantity-one']);
    assert.ok(
      f.requests.some((url) => url.startsWith('https://checkout.twitch.tv/fixture-checkout')),
    );
    const frame = f.page
      .frames()
      .find((frame) => frame.url().startsWith('https://checkout.twitch.tv/'))!;
    assert.equal(
      (await frame.locator('body').innerText()).includes('Selected payment method:'),
      false,
    );
    assert.equal(
      await frame.getByRole('radio', { checked: true }).getAttribute('aria-label'),
      'Visa ending in 5183',
    );
    assert.equal(
      await frame.getByRole('button', { name: 'Complete Purchase', exact: true }).isVisible(),
      true,
    );
  } finally {
    await f.close();
  }
});

test('an unsupported quantity intent rejects before navigation or any fixture action', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      new TwitchCheckoutDriver().prepare(f.scope, { ...intent, giftUnits: 2 }),
      TwitchCheckoutError,
    );
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.events, []);
  } finally {
    await f.close();
  }
});

for (const [name, config] of [
  ['wrong donor', { donor: 'another_donor' }],
  ['duplicate account control', { duplicateAccount: true }],
  ['duplicate exact quantity caption', { duplicateCaption: true }],
  ['multiple buttons in the quantity card', { duplicateCardButton: true }],
  ['wrong quantity artwork', { wrongArtwork: true }],
] as const) {
  test(`prepare rejects ${name} before review or purchase`, async () => {
    const f = await fixture(config);
    try {
      await assert.rejects(
        new TwitchCheckoutDriver().prepare(f.scope, intent),
        TwitchCheckoutError,
      );
      assert.deepEqual(f.events, []);
      assert.equal(
        f.requests.some((url) => url.includes('fixture-checkout')),
        false,
      );
    } finally {
      await f.close();
    }
  });
}

/** Open a reduced review through actual DOM actions; no driver stubs or locator mocks. */
async function openReview(f: Awaited<ReturnType<typeof fixture>>, frames = 1) {
  await f.page.goto(channelUrl);
  await f.page.getByRole('button', { name: 'Gift a Sub', exact: true }).click();
  await f.page.locator('#one-button').click();
  for (let index = 0; index < frames; index++)
    await f.page
      .frameLocator('iframe')
      .nth(index)
      .getByRole('button', { name: 'Complete Purchase', exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 3000 });
}

for (const [name, config] of [
  ['wrong selected card', { cardLast4: '1234' }],
  ['two selected cards', { duplicateSelectedCard: true }],
  ['wrong native quantity', { quantity: 10 }],
  ['wrong native recipient', { recipient: 'another_recipient' }],
  ['two purchase buttons', { duplicatePurchaseButton: true }],
  ['untrusted checkout origin', { frameOrigin: 'https://untrusted.invalid' }],
  ['two trusted checkout frames', { frameCount: 2 }],
] as const) {
  test(`real rendered review rejects ${name}`, async () => {
    const f = await fixture(config);
    try {
      await openReview(f, 'frameCount' in config ? config.frameCount : 1);
      await assert.rejects(
        new TwitchCheckoutDriver().readQuote(f.scope, intent),
        TwitchCheckoutError,
      );
      assert.deepEqual(f.events, ['quantity-one']);
    } finally {
      await f.close();
    }
  });
}

test('an HTTP checkout document is rejected even when its rendered quote is otherwise valid', async () => {
  const f = await fixture();
  try {
    // Chromium blocks an HTTP iframe in the HTTPS parent before it can render.
    // Load the synthetic insecure document directly to also exercise the driver's
    // protocol check, rather than weakening Chromium's mixed-content protection.
    await f.page.goto('http://checkout.twitch.tv/fixture-checkout');
    assert.equal(
      await f.page.getByRole('button', { name: 'Complete Purchase', exact: true }).count(),
      1,
    );
    await assert.rejects(
      new TwitchCheckoutDriver().readQuote(f.scope, intent),
      TwitchCheckoutError,
    );
    assert.deepEqual(f.events, []);
  } finally {
    await f.close();
  }
});

test('synthetic successful submit requires the durable permit before exactly one final click', async () => {
  const f = await fixture();
  try {
    await openReview(f);
    const driver = new TwitchCheckoutDriver();
    const quote = await driver.readQuote(f.scope, intent);
    const delivery = await driver.submit(f.scope, intent, quote, () => {
      f.events.push('permit');
    });
    assert.match(delivery.evidenceDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.events, ['quantity-one', 'permit', 'purchase']);
  } finally {
    await f.close();
  }
});

test('ambiguous post-click frame navigation rejects without a blind second purchase click', async () => {
  const f = await fixture({ ambiguousSubmit: true });
  try {
    await openReview(f);
    const driver = new TwitchCheckoutDriver();
    const quote = await driver.readQuote(f.scope, intent);
    await assert.rejects(
      driver.submit(f.scope, intent, quote, () => {
        f.events.push('permit');
      }),
      (error: unknown) => error instanceof TwitchCheckoutError && error.code === 'outcome_unknown',
    );
    assert.deepEqual(f.events, ['quantity-one', 'permit', 'purchase']);
    assert.equal(
      f.requests.filter((url) => url === 'https://untrusted.invalid/fixture-result').length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('ownership loss after the final permit prevents the real DOM purchase click', async () => {
  const f = await fixture();
  try {
    await openReview(f);
    const driver = new TwitchCheckoutDriver();
    const quote = await driver.readQuote(f.scope, intent);
    await assert.rejects(
      driver.submit(f.scope, intent, quote, () => {
        f.events.push('permit');
        f.loseOwnership();
      }),
      /Synthetic driver lease lost/,
    );
    assert.deepEqual(f.events, ['quantity-one', 'permit']);
  } finally {
    await f.close();
  }
});

test('unexpected fixture requests are aborted, never forwarded to external providers', async () => {
  const f = await fixture();
  try {
    await f.page.goto(channelUrl);
    const outcome = await f.page.evaluate(async () => {
      try {
        await fetch('https://network-forbidden.invalid/should-not-leave-browser');
        return 'unexpected';
      } catch {
        return 'blocked';
      }
    });
    assert.equal(outcome, 'blocked');
    assert.deepEqual(f.aborted, ['https://network-forbidden.invalid/should-not-leave-browser']);
    assert.deepEqual(f.events, []);
  } finally {
    await f.close();
  }
});

test('inspection returns bounded canonical payment facts and origin-only inventory without actions or private text', async () => {
  const f = await fixture();
  try {
    await openReview(f);
    await f.page.evaluate(() => {
      history.replaceState({}, '', '/cloverreggie?token=secret-query#secret-fragment');
      const section = document.createElement('section');
      section.innerHTML =
        '<h2>PAYMENT</h2><h3>Checkout</h3><h4>Payment fixture@example.test</h4><button>Try Again</button><button>Payment 4111111111111111</button><p>Something went wrong. Loading payment. Try again.</p>';
      document.body.append(section);
    });
    const second = await f.scope.context.newPage();
    await second.goto(channelUrl);
    const events = [...f.events];
    const result = (await new TwitchCheckoutDriver().inspect(f.scope)) as unknown as {
      inventory: {
        openPageCount: number;
        openPageOrigins: string[];
        totalFrameCount: number;
        trustedCheckoutFrameCount: number;
      };
      frames: Array<{
        origin: string;
        payment?: {
          headingLabels: string[];
          buttonLabels: string[];
          markers: Record<string, boolean>;
        };
      }>;
    };
    assert.equal(result.inventory.openPageCount, 2);
    assert.deepEqual(result.inventory.openPageOrigins, [
      'https://www.twitch.tv',
      'https://www.twitch.tv',
    ]);
    assert.equal(result.inventory.totalFrameCount, 2);
    assert.equal(result.inventory.trustedCheckoutFrameCount, 1);
    const payment = result.frames.find(
      (frame) => frame.origin === 'https://www.twitch.tv',
    )!.payment!;
    assert.deepEqual(payment.headingLabels, ['Payment', 'Checkout']);
    assert.deepEqual(payment.buttonLabels, ['Try Again']);
    assert.equal(payment.markers.payment, true);
    assert.equal(payment.markers.checkout, true);
    assert.equal(payment.markers.somethingWentWrong, true);
    assert.equal(payment.markers.tryAgain, true);
    assert.equal(payment.markers.loading, true);
    assert.doesNotMatch(
      JSON.stringify(result),
      /fixture@example|411111|secret-query|secret-fragment/,
    );
    assert.deepEqual(f.events, events);
  } finally {
    await f.close();
  }
});

test('payment-review failure capture is evidence from only the exact owned session and intent, cleared on a new preparation', async () => {
  const f = await fixture({ cardLast4: '1234' });
  try {
    f.scope.diagnosticIdentity = 'synthetic-gift:synthetic-session:generation-1';
    const driver = new TwitchCheckoutDriver();
    await assert.rejects(
      driver.prepare(f.scope, intent),
      (error: unknown) => error instanceof TwitchCheckoutError && error.phase === 'payment_review',
    );
    await f.page
      .locator('iframe')
      .evaluateAll((elements) => elements.forEach((element) => element.remove()));
    const result = await driver.inspect(f.scope, intent);
    assert.ok('previousPreparation' in result);
    assert.equal(result.previousPreparation.phase, 'payment_review');
    assert.equal(result.previousPreparation.diagnostics.inventory.trustedCheckoutFrameCount, 1);
    assert.equal(result.inventory.trustedCheckoutFrameCount, 0);
    assert.equal(Number.isFinite(Date.parse(result.previousPreparation.observedAt)), true);
    assert.equal(
      'previousPreparation' in
        (await driver.inspect(f.scope, { ...intent, maxSpendUsdCents: 800 })),
      false,
    );
    assert.equal('previousPreparation' in (await driver.inspect(f.scope)), false);
    f.scope.diagnosticIdentity = 'synthetic-gift:different-session:generation-2';
    assert.equal('previousPreparation' in (await driver.inspect(f.scope, intent)), false);
    f.scope.diagnosticIdentity = 'synthetic-gift:synthetic-session:generation-1';
    await assert.rejects(driver.prepare(f.scope, { ...intent, giftUnits: 2 }));
    assert.equal('previousPreparation' in (await driver.inspect(f.scope, intent)), false);
    assert.deepEqual(f.events, ['quantity-one']);
    assert.doesNotMatch(
      JSON.stringify(result),
      /synthetic-session|generation-1|1234|sessionKey|intentKey/,
    );
  } finally {
    await f.close();
  }
});

for (const [units, expectedAction, total] of [
  [10, 'quantity-ten', 'HK$362.00'],
  [11, 'quantity-custom', 'HK$398.20'],
] as const) {
  test(`production preparation binds exact ${units} gifts and makes zero final actions`, async () => {
    const f = await fixture({ total });
    const production = {
      ...intent,
      production: true as const,
      giftUnits: units,
      maxSpendUsdCents: 5500,
      maxNativeMinorUnits: 40000,
    };
    try {
      const driver = new TwitchCheckoutDriver();
      const quote = await driver.prepare(f.scope, production);
      assert.equal(quote.giftUnits, units);
      assert.equal(quote.nativeTotalMinorUnits, units === 10 ? 36200 : 39820);
      assert.deepEqual(f.events, [expectedAction]);
      const delivery = await driver.submit(f.scope, production, quote, () => {
        f.events.push('permit');
      });
      assert.match(delivery.evidenceDigest, /^[a-f0-9]{64}$/);
      assert.deepEqual(f.events, [expectedAction, 'permit', 'purchase']);
      // A replacement driver only reads the already-visible success after a restart.
      const recovered = await new TwitchCheckoutDriver().readDelivery(f.scope, production);
      assert.equal(recovered?.evidenceDigest, delivery.evidenceDigest);
      assert.deepEqual(f.events, [expectedAction, 'permit', 'purchase']);
    } finally {
      await f.close();
    }
  });
}

for (const config of [
  { duplicateCustom: true },
  { duplicateCustomButton: true },
  { customValueReset: true },
]) {
  test(`production custom quantity rejects ambiguous or changed controls ${JSON.stringify(config)}`, async () => {
    const f = await fixture(config);
    try {
      await assert.rejects(
        new TwitchCheckoutDriver().prepare(f.scope, { ...intent, production: true, giftUnits: 11 }),
        TwitchCheckoutError,
      );
      assert.deepEqual(f.events, []);
    } finally {
      await f.close();
    }
  });
}

for (const [name, config] of [
  ['changed native quote', { total: 'HK$362.01' }],
  ['wrong selected card', { cardLast4: '1234' }],
  ['wrong recipient', { recipient: 'another_recipient' }],
  ['wrong quantity', { quantity: 11 }],
] as const) {
  test(`production submit blocks ${name} before durable permit or purchase`, async () => {
    const f = await fixture(Object.assign({ quantity: 10, total: 'HK$362.00' }, config));
    try {
      await openReview(f);
      const production = {
        ...intent,
        production: true as const,
        giftUnits: 10,
        maxSpendUsdCents: 5500,
        maxNativeMinorUnits: 40000,
      };
      const quote = {
        accountId: 'pogdotfun',
        recipientPlatform: 'twitch' as const,
        recipientUsername: 'cloverreggie',
        recipientProviderId: 'twitch:1422545006',
        kind: 'gift_sub' as const,
        giftUnits: 10,
        nativeCurrency: 'HKD' as const,
        nativeTotalMinorUnits: 36200,
        observedAt: '2026-09-16T12:00:00.000Z',
      };
      await assert.rejects(
        new TwitchCheckoutDriver().submit(f.scope, production, quote, () => {
          f.events.push('permit');
        }),
        TwitchCheckoutError,
      );
      assert.deepEqual(f.events, ['quantity-one']);
    } finally {
      await f.close();
    }
  });
}

test('production ownership loss at durable permit blocks the final purchase', async () => {
  const f = await fixture({ quantity: 10, total: 'HK$362.00' });
  try {
    await openReview(f);
    const driver = new TwitchCheckoutDriver();
    const production = {
      ...intent,
      production: true as const,
      giftUnits: 10,
      maxSpendUsdCents: 5500,
      maxNativeMinorUnits: 40000,
    };
    const quote = await driver.readQuote(f.scope, production);
    await assert.rejects(
      driver.submit(f.scope, production, quote, () => {
        f.events.push('permit');
        f.loseOwnership();
      }),
      /Synthetic driver lease lost/,
    );
    assert.deepEqual(f.events, ['quantity-one', 'permit']);
  } finally {
    await f.close();
  }
});
