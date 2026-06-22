/**
 * Stripe payments for paid league creation (Fantasy DCI plan §12). SERVER-ONLY.
 *
 * Provider split (plan §12.1, "Stripe + Alchemy"): Alchemy provisions the Stripe
 * Product / Price / WebhookEndpoint declaratively (see `alchemy.run.ts`); this
 * module is the RUNTIME half — one-time Checkout, webhook verification, refunds —
 * using the official `stripe` SDK. Guarded by `STRIPE_SECRET_KEY`: if unset we
 * report "not configured" and callers fall back to free leagues, so payments are
 * purely additive behind the `FANTASY_PAYMENTS_ENABLED` flag.
 */
import Stripe from 'stripe';

let _stripe: Stripe | null = null;

const secret = (): string | null => process.env.STRIPE_SECRET_KEY ?? null;

/** Payments are live only when the flag is on AND Stripe is configured. */
export const paymentsEnabled = (): boolean =>
  process.env.FANTASY_PAYMENTS_ENABLED === 'true' && secret() !== null;

const getStripe = (): Stripe => {
  const key = secret();
  if (!key) throw new Error('STRIPE_NOT_CONFIGURED');
  return (_stripe ??= new Stripe(key));
};

const siteOrigin = (): string =>
  (process.env.BETTER_AUTH_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

/**
 * One-time Checkout session for a league fee. Uses the Alchemy-provisioned price
 * (`STRIPE_LEAGUE_PRICE_ID`); `leagueId` rides in metadata so the webhook can
 * flip the right league to paid.
 */
export async function createLeagueCheckoutSession(input: {
  leagueId: string;
  slug: string;
  customerEmail?: string;
}): Promise<{ url: string }> {
  const priceId = process.env.STRIPE_LEAGUE_PRICE_ID;
  if (!priceId) throw new Error('STRIPE_LEAGUE_PRICE_ID not set');
  const origin = siteOrigin();
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/fantasy/${input.slug}?paid=1`,
    cancel_url: `${origin}/fantasy/${input.slug}?canceled=1`,
    metadata: { leagueId: input.leagueId },
    payment_intent_data: { metadata: { leagueId: input.leagueId } },
    customer_email: input.customerEmail,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url };
}

/** Verify + parse a webhook payload (throws on bad signature). */
export function constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  return getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/** Full refund of a captured payment intent (§12.3). Idempotent per intent. */
export async function refundPaymentIntent(paymentIntentId: string): Promise<void> {
  await getStripe().refunds.create({ payment_intent: paymentIntentId });
}
