import { createHash } from 'node:crypto';
import type { Frame, Locator } from 'playwright-core';
import type { AcceptanceGiftQuote } from '../acceptance/gift-types.ts';
import type { OwnedPage } from './browserbase-cdp.ts';
import type { TwitchGiftIntent } from './twitch-checkout.ts';

/** Same worker interface as Twitch, with a Kick provider ID. */
export type KickGiftIntent = TwitchGiftIntent;
export interface KickSelectorContract {
  version: 1;
  revision: string;
  /** Review provenance is configuration, never proof of a successful live purchase. */
  verifiedAt: string;
  evidenceDigest: string;
  checkoutOrigin: string;
  selectors: {
    account: string;
    channelUsername: string;
    /** Visible numeric broadcaster ID; no inference from username alone. */
    channelProviderId: string;
    openGift: string;
    quantityInput: string;
    openReview: string;
    reviewRoot: string;
    recipient: string;
    units: string;
    currency: string;
    total: string;
    /** Must identify one checked radio/input with a visible card label. */
    selectedCard: string;
    submit: string;
    confirmationRoot: string;
    receiptId: string;
    deliveryStatus: string;
  };
}
type Code =
  'contract_unverified' | 'verification_required' | 'unexpected_checkout' | 'outcome_unknown';
export class KickCheckoutError extends Error {
  constructor(readonly code: Code) {
    super(`Kick checkout held: ${code}. Reconcile the original attempt before continuing.`);
    this.name = 'KickCheckoutError';
  }
}
function fail(code: Code = 'unexpected_checkout'): never {
  throw new KickCheckoutError(code);
}
function validateIntent(intent: KickGiftIntent) {
  if (
    !/^[a-z0-9_]{3,25}$/.test(intent.accountId) ||
    !/^[a-z0-9_]{3,25}$/.test(intent.username) ||
    !/^kick:[1-9]\d{0,29}$/.test(intent.providerId) ||
    (intent.production !== undefined && intent.production !== true) ||
    !Number.isSafeInteger(intent.giftUnits) ||
    intent.giftUnits < 1 ||
    intent.giftUnits > (intent.production ? 100 : 1) ||
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
    /captcha|verify (?:that )?you are human|security challenge|verify your identity|two[ -]factor|2fa|verification code|authentication code|one[ -]time (?:password|code)/i.test(
      text,
    )
  )
    fail('verification_required');
}
const checkoutOrigins = new Set([
  'https://kick.com',
  'https://checkout.stripe.com',
  'https://js.stripe.com',
  'https://hooks.stripe.com',
]);
const selectorKeys: (keyof KickSelectorContract['selectors'])[] = [
  'account',
  'channelUsername',
  'channelProviderId',
  'openGift',
  'quantityInput',
  'openReview',
  'reviewRoot',
  'recipient',
  'units',
  'currency',
  'total',
  'selectedCard',
  'submit',
  'confirmationRoot',
  'receiptId',
  'deliveryStatus',
];

/**
 * Agent-only browser rail. No default selectors are asserted to match Kick's live UI.
 * A trusted, independently reviewed versioned DOM contract is required. Persistent
 * lease/journal ownership and issuer reconciliation remain the caller's responsibility.
 */
export class KickCheckoutDriver {
  private readonly contract?: KickSelectorContract;
  private readonly submitted = new Set<string>();
  constructor(contract?: KickSelectorContract) {
    this.contract = contract ? structuredClone(contract) : undefined;
  }
  configured(): boolean {
    try {
      this.configuration();
      return true;
    } catch {
      return false;
    }
  }
  private configuration() {
    const c = this.contract;
    const age = Date.now() - Date.parse(c?.verifiedAt ?? '');
    if (
      !c ||
      c.version !== 1 ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(c.revision) ||
      !/^[a-f0-9]{64}$/.test(c.evidenceDigest) ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 90 * 86400000 ||
      !checkoutOrigins.has(c.checkoutOrigin) ||
      !c.selectors ||
      selectorKeys.some(
        (key) =>
          typeof c.selectors[key] !== 'string' ||
          !c.selectors[key].trim() ||
          c.selectors[key].length > 256 ||
          /[\r\n]|>>/.test(c.selectors[key]),
      )
    )
      fail('contract_unverified');
    return c;
  }
  private guard(scope: OwnedPage, intent: KickGiftIntent, frame?: Frame) {
    scope.assertOwned();
    const page = new URL(scope.page.url());
    if (
      page.origin !== 'https://kick.com' ||
      page.username ||
      page.password ||
      page.pathname.toLowerCase().replace(/\/$/, '') !== `/${intent.username}`
    )
      fail();
    if (frame) {
      const url = new URL(frame.url());
      if (url.origin !== this.configuration().checkoutOrigin || url.username || url.password)
        fail();
    }
  }
  private async unique(locator: Locator) {
    if ((await locator.count()) !== 1 || !(await locator.isVisible())) fail();
    return locator;
  }
  private async text(locator: Locator) {
    await this.unique(locator);
    const text = (await locator.innerText()).replace(/\u00a0/g, ' ').trim();
    if (!text || text.length > 1024) fail();
    return text;
  }
  private async identity(scope: OwnedPage, intent: KickGiftIntent) {
    const c = this.configuration();
    validateIntent(intent);
    this.guard(scope, intent);
    challenge(await scope.page.locator('body').innerText());
    const account = await this.text(scope.page.locator(c.selectors.account));
    const channel = await this.text(scope.page.locator(c.selectors.channelUsername));
    const provider = await this.text(scope.page.locator(c.selectors.channelProviderId));
    this.guard(scope, intent);
    if (
      account.toLowerCase() !== intent.accountId ||
      channel.toLowerCase() !== intent.username ||
      provider !== intent.providerId.slice(5)
    )
      fail();
  }
  private async view(scope: OwnedPage, intent: KickGiftIntent, confirmation = false) {
    await this.identity(scope, intent);
    const c = this.configuration();
    const found: { frame: Frame; root: Locator }[] = [];
    for (const frame of scope.page.frames()) {
      let origin: string;
      try {
        origin = new URL(frame.url()).origin;
      } catch {
        continue;
      }
      if (origin !== c.checkoutOrigin) continue;
      this.guard(scope, intent, frame);
      challenge(await frame.locator('body').innerText());
      const root = frame.locator(
        confirmation ? c.selectors.confirmationRoot : c.selectors.reviewRoot,
      );
      const count = await root.count();
      this.guard(scope, intent, frame);
      if (count > 1) fail();
      if (count === 1 && (await root.isVisible())) found.push({ frame, root });
    }
    if (confirmation && found.length === 0) return null;
    if (found.length !== 1) fail();
    return found[0];
  }
  private async quote(
    scope: OwnedPage,
    intent: KickGiftIntent,
    view: { frame: Frame; root: Locator },
    observedAt: string,
    includeCard = true,
  ): Promise<AcceptanceGiftQuote> {
    const s = this.configuration().selectors;
    const read = (selector: string) => this.text(view.root.locator(selector));
    const recipient = await read(s.recipient);
    const units = await read(s.units);
    const currency = await read(s.currency);
    const total = await read(s.total);
    if (includeCard) {
      const card = await this.unique(view.root.locator(s.selectedCard));
      if (!(await card.isChecked())) fail();
      const label = (await card.getAttribute('aria-label')) ?? (await card.innerText());
      const match =
        /^(?:American Express|Amex|Visa|Mastercard|Master Card)\s+(?:ending in\s+|[*• ]+)(\d{4})$/i.exec(
          label.trim(),
        );
      if (!match || match[1] !== intent.cardLast4) fail();
    }
    this.guard(scope, intent, view.frame);
    const amount = /^(?:(?:USD\s*|US\$|\$)\s*)?(0|[1-9]\d{0,7})\.(\d{2})$/.exec(total);
    if (
      recipient.toLowerCase() !== intent.username ||
      units !== String(intent.giftUnits) ||
      currency !== 'USD' ||
      !amount
    )
      fail();
    const minor = Number(amount[1]) * 100 + Number(amount[2]);
    if (
      !Number.isSafeInteger(minor) ||
      minor < 1 ||
      minor > intent.maxNativeMinorUnits ||
      minor > intent.maxSpendUsdCents
    )
      fail();
    return {
      accountId: intent.accountId,
      recipientPlatform: 'kick',
      recipientUsername: intent.username,
      recipientProviderId: intent.providerId,
      kind: 'gift_sub',
      giftUnits: intent.giftUnits,
      nativeTotalMinorUnits: minor,
      nativeCurrency: 'USD',
      totalUsdCents: minor,
      observedAt,
    };
  }
  async prepare(scope: OwnedPage, intent: KickGiftIntent) {
    const c = this.configuration();
    validateIntent(intent);
    scope.assertOwned();
    if (scope.diagnosticIdentity && this.submitted.has(scope.diagnosticIdentity))
      fail('outcome_unknown');
    try {
      await scope.page.goto(`https://kick.com/${intent.username}`, {
        waitUntil: 'domcontentloaded',
      });
      await this.identity(scope, intent);
      const gift = await this.unique(scope.page.locator(c.selectors.openGift));
      this.guard(scope, intent);
      await gift.click({ timeout: 10000 });
      await this.identity(scope, intent);
      const quantity = await this.unique(scope.page.locator(c.selectors.quantityInput));
      this.guard(scope, intent);
      await quantity.fill(String(intent.giftUnits));
      this.guard(scope, intent);
      if ((await quantity.inputValue()) !== String(intent.giftUnits)) fail();
      const review = await this.unique(scope.page.locator(c.selectors.openReview));
      await this.identity(scope, intent);
      this.guard(scope, intent);
      await review.click({ timeout: 10000 });
      return await this.readQuote(scope, intent);
    } catch (error) {
      scope.assertOwned();
      throw error instanceof KickCheckoutError
        ? error
        : new KickCheckoutError('unexpected_checkout');
    }
  }
  async readQuote(scope: OwnedPage, intent: KickGiftIntent) {
    try {
      return await this.quote(
        scope,
        intent,
        (await this.view(scope, intent))!,
        new Date().toISOString(),
      );
    } catch (error) {
      scope.assertOwned();
      throw error instanceof KickCheckoutError
        ? error
        : new KickCheckoutError('unexpected_checkout');
    }
  }
  /** Observation only: no navigation, challenge bypass, or purchase retry. */
  async readDelivery(
    scope: OwnedPage,
    intent: KickGiftIntent,
    expectedQuote?: AcceptanceGiftQuote,
  ) {
    const view = await this.view(scope, intent, true);
    if (!view) return null;
    const s = this.configuration().selectors;
    const facts = await this.quote(scope, intent, view, '', false);
    if (
      expectedQuote &&
      JSON.stringify(facts) !== JSON.stringify({ ...expectedQuote, observedAt: '' })
    )
      fail('outcome_unknown');
    const status = await this.text(view.root.locator(s.deliveryStatus));
    const receiptId = await this.text(view.root.locator(s.receiptId));
    if (!/^Purchase successful$/i.test(status) || !/^[a-zA-Z0-9_-]{1,128}$/.test(receiptId))
      fail('outcome_unknown');
    this.guard(scope, intent, view.frame);
    return {
      completedAt: new Date().toISOString(),
      evidenceDigest: createHash('sha256')
        .update(JSON.stringify({ facts, receiptId, revision: this.configuration().revision }))
        .digest('hex'),
    };
  }
  async submit(
    scope: OwnedPage,
    intent: KickGiftIntent,
    quote: AcceptanceGiftQuote,
    beforeSubmit: () => void,
  ) {
    const session = scope.diagnosticIdentity;
    if (!session || this.submitted.has(session)) fail('outcome_unknown');
    const age = Date.now() - Date.parse(quote.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 30000) fail();
    const view = (await this.view(scope, intent))!;
    const fresh = await this.quote(scope, intent, view, quote.observedAt);
    if (JSON.stringify(fresh) !== JSON.stringify(quote)) fail();
    const button = await this.unique(view.root.locator(this.configuration().selectors.submit));
    if (!(await button.isEnabled())) fail();
    await this.identity(scope, intent);
    this.guard(scope, intent, view.frame);
    if (this.submitted.has(session)) fail('outcome_unknown');
    if (Date.now() - Date.parse(quote.observedAt) > 30000) fail();
    const permit = beforeSubmit();
    if (permit !== undefined) fail();
    this.submitted.add(session);
    this.guard(scope, intent, view.frame);
    try {
      await button.click({ timeout: 10000 });
      const delivery = await this.readDelivery(scope, intent, quote);
      if (!delivery) fail('outcome_unknown');
      return delivery;
    } catch {
      scope.assertOwned();
      fail('outcome_unknown');
    }
  }
  async inspect(scope: OwnedPage, _intent?: KickGiftIntent) {
    scope.assertOwned();
    let configured = false;
    try {
      this.configuration();
      configured = true;
    } catch {
      /* Report only non-sensitive capability. */
    }
    return {
      platform: 'kick',
      configured,
      selectorContractVersion: configured ? 1 : null,
      reconciliationRequired:
        !!scope.diagnosticIdentity && this.submitted.has(scope.diagnosticIdentity),
    };
  }
}
