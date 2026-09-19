import { createHash } from 'node:crypto';
import type { Frame } from 'playwright-core';
import type { AcceptanceGiftQuote } from '../acceptance/gift-types.ts';
import type { OwnedPage } from './browserbase-cdp.ts';

export interface TwitchGiftIntent {
  /** Explicit production authority; omitted intents remain single-sub acceptance only. */
  production?: true;
  accountId: string;
  username: string;
  providerId: string;
  giftUnits: number;
  maxSpendUsdCents: number;
  /** Exact native total guard, configured by the operator; not a promised issuer FX rate. */
  maxNativeMinorUnits: number;
  cardLast4: string;
}
export const twitchCheckoutPhases = [
  'channel_heading',
  'account_menu',
  'gift_dialog',
  'payment_review',
] as const;
export type TwitchCheckoutPhase = (typeof twitchCheckoutPhases)[number];
type TwitchCheckoutCode =
  'session_expired' | 'verification_required' | 'unexpected_checkout' | 'outcome_unknown';
const checkoutCodes: readonly string[] = [
  'session_expired',
  'verification_required',
  'unexpected_checkout',
  'outcome_unknown',
];
export class TwitchCheckoutError extends Error {
  readonly code: TwitchCheckoutCode;
  readonly phase?: TwitchCheckoutPhase;
  constructor(code: TwitchCheckoutCode, phase?: TwitchCheckoutPhase) {
    const safeCode = checkoutCodes.includes(code) ? code : 'unexpected_checkout';
    const safePhase = twitchCheckoutPhases.includes(phase as TwitchCheckoutPhase)
      ? phase
      : undefined;
    super(
      `Twitch checkout paused: ${safeCode}${safePhase ? ` (${safePhase})` : ''}. Reconcile the original attempt before continuing.`,
    );
    this.name = 'TwitchCheckoutError';
    this.code = safeCode;
    this.phase = safePhase;
  }
}
const fail = (): never => {
  throw new TwitchCheckoutError('unexpected_checkout');
};
function validate(intent: TwitchGiftIntent) {
  if (
    !/^[a-z0-9_]{3,25}$/.test(intent.accountId) ||
    !/^[a-z0-9_]{3,25}$/.test(intent.username) ||
    !/^twitch:\d+$/.test(intent.providerId) ||
    (intent.production !== undefined && intent.production !== true) ||
    !Number.isSafeInteger(intent.giftUnits) ||
    intent.giftUnits < 1 ||
    intent.giftUnits > (intent.production === true ? 100 : 1) ||
    !Number.isSafeInteger(intent.maxSpendUsdCents) ||
    intent.maxSpendUsdCents < 1 ||
    !Number.isSafeInteger(intent.maxNativeMinorUnits) ||
    intent.maxNativeMinorUnits < 1 ||
    !/^\d{4}$/.test(intent.cardLast4)
  )
    fail();
}
function challenge(text: string) {
  if (
    /verify (?:that )?you are human|complete (?:the |this )?(?:captcha|verification)|security challenge|verify your identity/i.test(
      text,
    )
  )
    throw new TwitchCheckoutError('verification_required');
}
function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function parseTwitchCheckout(
  text: string,
  intent: TwitchGiftIntent,
  observedAt: string,
): AcceptanceGiftQuote {
  validate(intent);
  challenge(text);
  if (!Number.isFinite(Date.parse(observedAt))) fail();
  const normalized = text.replace(/\u00a0/g, ' ').replace(/\r/g, '');
  const products = [
    ...normalized.matchAll(
      /\b(?:Gift|Gifting)\s+(\d+)\s+(?:Tier\s*1\s+)?(?:Gift\s+)?Sub(?:scription)?s?\s+to\s+([a-zA-Z0-9_]+)['’]s\s+community\b/gi,
    ),
  ];
  const selectedCards = [
    ...normalized.matchAll(
      /Selected payment method:\s*(?:Visa|Mastercard|Master Card|American Express|Amex)\s+(?:ending in\s+|[*• ]+)(\d{4})\b/gi,
    ),
  ];
  if (
    products.length !== 1 ||
    Number(products[0][1]) !== intent.giftUnits ||
    products[0][2].toLowerCase() !== intent.username ||
    selectedCards.length !== 1 ||
    selectedCards[0][1] !== intent.cardLast4
  )
    fail();
  const totals = [
    ...normalized.matchAll(
      /(?:^|\n)[ \t]*(?:Order )?Total[ \t]*[:\n]?[ \t]*(HK\$|US\$|USD[ \t]*\$?)[ \t]*(\d+(?:,\d{3})*\.\d{2})(?:[ \t]+(HKD|USD))?[ \t]*(?=\n|$)/gim,
    ),
  ];
  if (totals.length !== 1) fail();
  const [, prefix, amount, suffix] = totals[0];
  const currency = prefix.toUpperCase();
  if (suffix && suffix.toUpperCase() !== (currency === 'HK$' ? 'HKD' : 'USD')) fail();
  const minor = Number(amount.replaceAll(',', '').replace('.', ''));
  if (!Number.isSafeInteger(minor) || minor < 1 || minor > intent.maxNativeMinorUnits) fail();
  const base = {
    accountId: intent.accountId,
    recipientPlatform: 'twitch' as const,
    recipientUsername: intent.username,
    recipientProviderId: intent.providerId,
    kind: 'gift_sub' as const,
    giftUnits: intent.giftUnits,
    nativeTotalMinorUnits: minor,
    observedAt,
  };
  if (currency === 'HK$') {
    // A deliberately conservative planning bound (HK$1 = US$0.20), not an issuer guarantee.
    // Exact USD posting is checked separately against the original funded allowance.
    // Production uses the independently configured native cap above. Its coordinator
    // enforces authenticated USD funding and reconciles actual issuer charges; no
    // native quote can assert a USD posting. Acceptance keeps its historical bound.
    if (intent.production !== true && Math.ceil(minor / 5) > intent.maxSpendUsdCents) fail();
    return { ...base, nativeCurrency: 'HKD' };
  }
  if (minor > intent.maxSpendUsdCents) fail();
  return { ...base, nativeCurrency: 'USD', totalUsdCents: minor };
}
export function parseTwitchDelivery(text: string, intent: TwitchGiftIntent): boolean {
  validate(intent);
  if (!/Purchase Successful/i.test(text)) return false;
  return new RegExp(
    `\\b(?:gifted\\s+)?${intent.giftUnits}\\s+Tier\\s*1\\s+subscriptions?\\s+(?:gifted\\s+)?to\\s+${escaped(intent.username)}['’]s\\s+community\\b`,
    'i',
  ).test(text);
}
function trusted(frame: Frame) {
  try {
    const url = new URL(frame.url());
    return url.protocol === 'https:' && url.hostname === 'checkout.twitch.tv';
  } catch {
    return false;
  }
}
async function checkoutFrame(scope: OwnedPage): Promise<{ frame: Frame; text: string }> {
  scope.assertOwned();
  const found: { frame: Frame; text: string }[] = [];
  for (const frame of scope.page.frames().filter(trusted)) {
    let text = await frame.locator('body').innerText();
    scope.assertOwned();
    challenge(text);
    if (
      (await frame.getByRole('button', { name: 'Complete Purchase', exact: true }).count()) === 1
    ) {
      const selected = frame.getByRole('radio', { checked: true });
      if ((await selected.count()) !== 1) fail();
      const label = await selected.getAttribute('aria-label');
      scope.assertOwned();
      const match =
        /^(Visa|Mastercard|Master Card|American Express|Amex)\s+(?:ending in\s+|[*• ]+)(\d{4})$/i.exec(
          label ?? '',
        );
      if (!match) return fail();
      if (!/Selected payment method:/i.test(text))
        text += `\nSelected payment method: ${match[1]} ending in ${match[2]}`;
      else if (
        !new RegExp(
          `Selected payment method:\\s*${match[1]}\\s+ending in\\s+${match[2]}\\b`,
          'i',
        ).test(text)
      )
        fail();
      found.push({ frame, text });
    }
  }
  if (found.length !== 1) fail();
  return found[0];
}

async function inspectAccountControls(frame: Frame) {
  const counts = async (locator: ReturnType<Frame['locator']>) => ({
    count: await locator.count(),
    visible: await locator.filter({ visible: true }).count(),
  });
  const targetNames = ['user-menu-toggle', 'login-button', 'signup-button'] as const;
  const roleNames = ['User Menu', 'Account', 'Profile'] as const;
  const targets = Object.fromEntries(
    await Promise.all(
      targetNames.map(async (name) => [
        name,
        await counts(frame.locator(`[data-a-target="${name}"]`)),
      ]),
    ),
  );
  const roles = Object.fromEntries(
    await Promise.all(
      roleNames.map(async (name) => [
        name,
        await counts(frame.getByRole('button', { name, exact: true })),
      ]),
    ),
  );
  const [dropdownMain, domDialogs, topNavigation] = await Promise.all([
    counts(frame.locator('[data-a-target="dropdown-main"]')),
    counts(frame.locator('[role="dialog"]')),
    counts(frame.locator('[data-a-target="top-nav-container"], nav')),
  ]);
  // Read attributes only on top-navigation buttons, and discard unsafe values in the page.
  const attributes = await frame
    .locator('[data-a-target="top-nav-container"] button, nav button')
    .evaluateAll((buttons) => {
      return buttons
        .slice(0, 100)
        .map((button) =>
          Object.fromEntries(
            [
              ['ariaLabel', 'aria-label'],
              ['title', 'title'],
              ['target', 'data-a-target'],
            ].map(([key, attribute]) => {
              const normalized = button.getAttribute(attribute)?.trim() ?? '';
              return [
                key,
                normalized.length <= 80 &&
                /^[a-zA-Z][a-zA-Z0-9 _-]*$/.test(normalized) &&
                /user|account|profile|log[ _-]?in/i.test(normalized) &&
                !/\d{5}/.test(normalized)
                  ? normalized
                  : undefined,
              ];
            }),
          ),
        )
        .filter((button) => button.ariaLabel || button.title || button.target)
        .slice(0, 20);
    });
  return { targets, roles, dropdownMain, domDialogs, topNavigation, attributes };
}

const diagnosticOrigins = new Set([
  'https://www.twitch.tv',
  'https://checkout.twitch.tv',
  'https://s.amazon-adsystem.com',
  'https://ssl.kaptcha.com',
]);
function diagnosticOrigin(value: string) {
  try {
    const origin = new URL(value).origin;
    return diagnosticOrigins.has(origin) ? origin : 'unrecognized';
  } catch {
    return 'unrecognized';
  }
}
function diagnosticSessionKey(scope: OwnedPage) {
  return typeof scope.diagnosticIdentity === 'string' &&
    scope.diagnosticIdentity.length > 0 &&
    scope.diagnosticIdentity.length <= 1024
    ? createHash('sha256').update(scope.diagnosticIdentity).digest('hex')
    : undefined;
}
function diagnosticIntentKey(intent: TwitchGiftIntent) {
  return JSON.stringify([
    intent.accountId,
    intent.username,
    intent.providerId,
    intent.giftUnits,
    intent.maxSpendUsdCents,
    intent.maxNativeMinorUnits,
    intent.cardLast4,
    intent.production === true,
  ]);
}
const paymentDiagnosticLabels = [
  'Payment',
  'Checkout',
  'Payment Method',
  'Payment Methods',
  'Payment Details',
  'Review Purchase',
  'Complete Purchase',
  'Confirm Purchase',
  'Purchase',
  'Pay',
  'Continue',
  'Continue to Payment',
  'Next',
  'Try Again',
  'Retry',
  'Loading',
  'Something Went Wrong',
] as const;
function paymentLabels(values: string[]) {
  const present = new Set(
    values.slice(0, 200).map((value) => value.replace(/\s+/g, ' ').trim().toLowerCase()),
  );
  return paymentDiagnosticLabels.filter((label) => present.has(label.toLowerCase())).slice(0, 20);
}

/** Fixed, inspectable UI actions. No CAPTCHA solving, card entry, hidden APIs or purchase retries. */
export class TwitchCheckoutDriver {
  private preparationSequence = 0;
  private previousPreparation?: {
    intentKey: string;
    sessionKey: string;
    observedAt: string;
    phase: 'payment_review';
    diagnostics: Awaited<ReturnType<TwitchCheckoutDriver['readDiagnostics']>>;
  };
  async prepare(scope: OwnedPage, intent: TwitchGiftIntent): Promise<AcceptanceGiftQuote> {
    const sequence = ++this.preparationSequence;
    this.previousPreparation = undefined;
    validate(intent);
    scope.assertOwned();
    let phase: TwitchCheckoutPhase = 'channel_heading';
    try {
      await scope.page.goto(`https://www.twitch.tv/${intent.username}`, {
        waitUntil: 'domcontentloaded',
      });
      scope.assertOwned();
      await scope.page
        .getByRole('heading', { name: new RegExp(`^${escaped(intent.username)}$`, 'i'), level: 1 })
        .waitFor({ state: 'visible', timeout: 20000 });
      scope.assertOwned();
      phase = 'account_menu';
      if (await scope.page.getByRole('button', { name: 'Log In', exact: true }).isVisible())
        throw new TwitchCheckoutError('session_expired');
      // The signed-in Twitch control has this stable target but no accessible name.
      // Verified against the owned live session on 16 September 2026.
      const accountMenu = scope.page.locator('button[data-a-target="user-menu-toggle"]');
      if ((await accountMenu.count()) !== 1) fail();
      scope.assertOwned();
      await accountMenu.click();
      scope.assertOwned();
      // Twitch's dialog wrapper has no visible box; its observed menu content does.
      const menu = scope.page.locator(
        '[data-a-target="dropdown-main"][aria-label="User Menu Options"]',
      );
      await menu.waitFor({ state: 'visible', timeout: 10000 });
      if ((await menu.count()) !== 1) fail();
      await menu.getByText(intent.accountId, { exact: true }).waitFor({ state: 'visible' });
      scope.assertOwned();
      await scope.page.keyboard.press('Escape');
      scope.assertOwned();
      phase = 'gift_dialog';
      await scope.page.getByRole('button', { name: 'Gift a Sub', exact: true }).click();
      scope.assertOwned();
      const gifts = scope.page.getByRole('dialog', { name: 'Gift a Sub', exact: true });
      await gifts
        .getByRole('combobox', { name: 'Gift to the Community', exact: true })
        .selectOption({ label: 'Tier 1 Gifts' });
      scope.assertOwned();
      // Preset cards and custom input structure were inspected in Twitch's public
      // gift dialog on 16 September 2026. Never select an arbitrary unnamed button.
      const presets = [1, 5, 10, 20, 50, 100];
      if (presets.includes(intent.giftUnits)) {
        const title = `Gift ${intent.giftUnits} Sub${intent.giftUnits === 1 ? '' : 's'}`;
        const caption = gifts.getByText(title, { exact: true });
        await caption.waitFor({ state: 'visible', timeout: 10000 });
        if ((await caption.count()) !== 1) fail();
        const card = caption.locator('xpath=ancestor::div[.//button][1]');
        if (
          (await card.count()) !== 1 ||
          (await card.getByRole('img', { name: `${title} at random.`, exact: true }).count()) !== 1
        )
          fail();
        const button = card.getByRole('button');
        if ((await button.count()) !== 1) fail();
        scope.assertOwned();
        await button.click();
      } else {
        if (intent.production !== true) fail();
        const input = gifts.getByRole('spinbutton', {
          name: 'Custom Quantity (Max 200)',
          exact: true,
        });
        await input.waitFor({ state: 'visible', timeout: 10000 });
        if (
          (await input.count()) !== 1 ||
          (await input.getAttribute('min')) !== '1' ||
          (await input.getAttribute('max')) !== '200'
        )
          fail();
        const card = input.locator('xpath=ancestor::div[.//button][1]');
        if (
          (await card.count()) !== 1 ||
          (await card.getByText('Custom Quantity', { exact: true }).count()) !== 1
        )
          fail();
        const button = card.getByRole('button');
        if ((await button.count()) !== 1) fail();
        scope.assertOwned();
        await input.fill(String(intent.giftUnits));
        scope.assertOwned();
        if ((await input.inputValue()) !== String(intent.giftUnits)) fail();
        scope.assertOwned();
        await button.click();
      }
      // Opening review is not purchase authority: exact native quote validation follows.
      scope.assertOwned();
      phase = 'payment_review';
      for (let poll = 0; poll < 10; poll++) {
        try {
          const view = await checkoutFrame(scope);
          return parseTwitchCheckout(view.text, intent, new Date().toISOString());
        } catch (error) {
          if (error instanceof TwitchCheckoutError && error.code === 'verification_required')
            throw error;
          if (poll === 9) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        scope.assertOwned();
      }
      return fail();
    } catch (error) {
      // Preserve a lost ownership failure; never expose Playwright locator/DOM messages.
      scope.assertOwned();
      const sessionKey = diagnosticSessionKey(scope);
      if (phase === 'payment_review' && sessionKey) {
        try {
          const diagnostics = await this.readDiagnostics(scope);
          scope.assertOwned();
          if (sequence === this.preparationSequence)
            this.previousPreparation = {
              intentKey: diagnosticIntentKey(intent),
              sessionKey,
              observedAt: new Date().toISOString(),
              phase,
              diagnostics,
            };
        } catch {
          // Diagnostic failure never changes checkout authority or the original error.
          scope.assertOwned();
        }
      }
      throw new TwitchCheckoutError(
        error instanceof TwitchCheckoutError ? error.code : 'unexpected_checkout',
        phase,
      );
    }
  }
  async readQuote(scope: OwnedPage, intent: TwitchGiftIntent) {
    const view = await checkoutFrame(scope);
    return parseTwitchCheckout(view.text, intent, new Date().toISOString());
  }
  /** Recover visible delivery after interruption; never navigates, submits, or retries. */
  async readDelivery(scope: OwnedPage, intent: TwitchGiftIntent) {
    validate(intent);
    scope.assertOwned();
    const found: string[] = [];
    for (const frame of scope.page.frames().filter(trusted)) {
      const text = await frame.locator('body').innerText();
      scope.assertOwned();
      if (!trusted(frame)) throw new TwitchCheckoutError('outcome_unknown');
      challenge(text);
      if (parseTwitchDelivery(text, intent)) found.push(text);
    }
    scope.assertOwned();
    if (found.length > 1) fail();
    if (!found.length) return null;
    return {
      completedAt: new Date().toISOString(),
      evidenceDigest: createHash('sha256').update(found[0]).digest('hex'),
    };
  }
  async submit(
    scope: OwnedPage,
    intent: TwitchGiftIntent,
    quote: AcceptanceGiftQuote,
    beforeSubmit: () => void,
  ) {
    const view = await checkoutFrame(scope);
    const fresh = parseTwitchCheckout(view.text, intent, quote.observedAt);
    if (JSON.stringify(fresh) !== JSON.stringify(quote)) fail();
    const button = view.frame.getByRole('button', { name: 'Complete Purchase', exact: true });
    if (!(await button.isEnabled())) fail();
    if (!trusted(view.frame)) fail();
    scope.assertOwned();
    const permit = beforeSubmit();
    // TypeScript accepts async callbacks for void: a pending commit grants no click permission.
    if (permit !== undefined) fail();
    scope.assertOwned();
    // One final action. Any thrown error leaves the durable intent unresolved.
    await button.click({ timeout: 10000 });
    for (let poll = 0; poll < 30; poll++) {
      scope.assertOwned();
      if (!trusted(view.frame)) throw new TwitchCheckoutError('outcome_unknown');
      const text = await view.frame.locator('body').innerText();
      scope.assertOwned();
      if (!trusted(view.frame)) throw new TwitchCheckoutError('outcome_unknown');
      challenge(text);
      if (parseTwitchDelivery(text, intent))
        return {
          completedAt: new Date().toISOString(),
          evidenceDigest: createHash('sha256').update(text).digest('hex'),
        };
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new TwitchCheckoutError('outcome_unknown');
  }
  private async readDiagnostics(scope: OwnedPage) {
    scope.assertOwned();
    const pages = scope.context.pages().filter((page) => !page.isClosed());
    const allFrames = scope.page.frames();
    const inventory = {
      openPageCount: pages.length,
      openPageOrigins: pages.slice(0, 10).map((page) => diagnosticOrigin(page.url())),
      pagesTruncated: pages.length > 10,
      totalFrameCount: allFrames.length,
      trustedCheckoutFrameCount: allFrames.filter(
        (frame) => diagnosticOrigin(frame.url()) === 'https://checkout.twitch.tv',
      ).length,
      framesTruncated: allFrames.length > 30,
    };
    const frames = [];
    for (const frame of allFrames.slice(0, 30)) {
      const origin = diagnosticOrigin(frame.url());
      scope.assertOwned();
      if (origin !== 'https://checkout.twitch.tv' && origin !== 'https://www.twitch.tv') {
        frames.push({ origin, excluded: true });
        continue;
      }
      const text = await frame.locator('body').innerText();
      scope.assertOwned();
      const buttons = await frame.getByRole('button').allTextContents();
      scope.assertOwned();
      const headingCounts = await Promise.all(
        [1, 2, 3].map((level) => frame.getByRole('heading', { level }).count()),
      );
      const recipientHeadingCounts = await Promise.all(
        [undefined, 1, 2, 3].map((level) =>
          frame
            .getByRole('heading', { name: /^cloverreggie$/i, ...(level ? { level } : {}) })
            .count(),
        ),
      );
      const recipientTextCounts = await Promise.all(
        [1, 2, 3].map(
          async (level) =>
            (await frame.getByRole('heading', { level }).allTextContents()).filter((text) =>
              /^cloverreggie$/i.test(text.trim()),
            ).length,
        ),
      );
      const [
        userMenuButtons,
        userMenuOptions,
        dialogs,
        giftDialogs,
        communitySelectors,
        giftOneButtons,
        completePurchaseButtons,
      ] = await Promise.all([
        frame.getByRole('button', { name: 'User Menu', exact: true }).count(),
        frame.locator('[data-a-target="dropdown-main"][aria-label="User Menu Options"]').count(),
        frame.getByRole('dialog').count(),
        frame.getByRole('dialog', { name: 'Gift a Sub', exact: true }).count(),
        frame.getByRole('combobox', { name: 'Gift to the Community', exact: true }).count(),
        frame.locator('button[data-a-target="gift-button-1"]').count(),
        frame.getByRole('button', { name: 'Complete Purchase', exact: true }).count(),
      ]);
      const accountControls =
        origin === 'https://www.twitch.tv' && frame === scope.page.mainFrame()
          ? await inspectAccountControls(frame)
          : undefined;
      scope.assertOwned();
      let payment;
      if (origin === 'https://www.twitch.tv' && frame === scope.page.mainFrame()) {
        const headings = await frame.getByRole('heading').allTextContents();
        scope.assertOwned();
        const boundedText = text.slice(0, 100_000);
        payment = {
          headingLabels: paymentLabels(headings),
          buttonLabels: paymentLabels(buttons),
          markers: {
            payment: /\bpayment\b/i.test(boundedText),
            checkout: /\bcheckout\b/i.test(boundedText),
            loading: /\bloading\b/i.test(boundedText),
            somethingWentWrong: /\bsomething went wrong\b/i.test(boundedText),
            tryAgain: /\btry again\b/i.test(boundedText),
            loginRequired: /\b(?:log in|sign in) to (?:purchase|continue|subscribe)\b/i.test(
              boundedText,
            ),
            verificationRequired:
              /verify (?:that )?you are human|complete (?:the |this )?(?:captcha|verification)|security challenge|verify your identity/i.test(
                boundedText,
              ),
          },
        };
      }
      frames.push({
        origin,
        ...(payment ? { payment } : {}),
        structure: {
          accountControls,
          headings: {
            level1: headingCounts[0],
            level2: headingCounts[1],
            level3: headingCounts[2],
          },
          recipientHeadings: {
            all: recipientHeadingCounts[0],
            level1: recipientHeadingCounts[1],
            level2: recipientHeadingCounts[2],
            level3: recipientHeadingCounts[3],
          },
          recipientHeadingText: {
            level1: recipientTextCounts[0],
            level2: recipientTextCounts[1],
            level3: recipientTextCounts[2],
          },
          userMenuButtons,
          userMenuOptions,
          dialogs,
          giftDialogs,
          communitySelectors,
          giftOneButtons,
          completePurchaseButtons,
        },
        buttons: buttons
          .map((t) => t.replace(/\s+/g, ' ').trim())
          .filter(
            (t) =>
              /^(?:Gift a Sub|Complete Purchase|Purchase|Pay|Continue|Next|Back|Close|User Menu|Log In|Sign Up|Gift a specific viewer|Back to Subscribe|(?:Gift|Pay|Purchase) (?:HK\$|US\$|USD )\d{1,5}\.\d{2})$/.test(
                t,
              ) ||
              (origin === 'https://www.twitch.tv' &&
                t.length <= 80 &&
                /^(?:Gift|Pay|Purchase|HK\$)/.test(t) &&
                /^[a-zA-Z0-9 $.,()-]+$/.test(t) &&
                !/\d{5}/.test(t)),
          )
          .slice(-30),
        buttonCount: buttons.length,
        lines: text
          .split('\n')
          .map((t) => t.trim())
          .filter((t) =>
            /^(?:Subtotal|Total|Tax|Complete Purchase|Purchase Successful|Gift to the Community|Tier [123] Gifts|Gift \d{1,3} Subs?|(?:HK\$|US\$|USD )\d{1,5}\.\d{2}|pogdotfun|cloverreggie)$/i.test(
              t,
            ),
          )
          .slice(-40),
      });
    }
    scope.assertOwned();
    return { inventory, frames };
  }
  async inspect(scope: OwnedPage, intent?: TwitchGiftIntent) {
    const diagnostics = await this.readDiagnostics(scope);
    scope.assertOwned();
    const previous = this.previousPreparation;
    if (
      intent &&
      previous &&
      previous.intentKey === diagnosticIntentKey(intent) &&
      previous.sessionKey === diagnosticSessionKey(scope)
    ) {
      return {
        ...diagnostics,
        previousPreparation: {
          observedAt: previous.observedAt,
          phase: previous.phase,
          diagnostics: previous.diagnostics,
        },
      };
    }
    return diagnostics;
  }
}
