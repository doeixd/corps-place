/**
 * Stripe payments for job boosting (PageantryJobs M5). SERVER-ONLY.
 *
 * Follows the exact same pattern as app/lib/fantasy/payments.ts — one-time
 * Checkout for boost, webhook verification, refunds. Guarded by STRIPE_SECRET_KEY.
 */
import Stripe from 'stripe';

let _stripe: Stripe | null = null;

const secret = (): string | null => process.env.STRIPE_SECRET_KEY ?? null;

export const paymentsEnabled = (): boolean =>
  process.env.JOBS_PAYMENTS_ENABLED === 'true' && secret() !== null;

const getStripe = (): Stripe => {
  const key = secret();
  if (!key) throw new Error('STRIPE_NOT_CONFIGURED');
  return (_stripe ??= new Stripe(key));
};

const siteOrigin = (): string =>
  (process.env.BETTER_AUTH_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

export async function createBoostCheckoutSession(input: {
  postingId: string;
  orderId: string;
  slug: string;
  customerEmail?: string;
}): Promise<{ url: string; sessionId: string }> {
  const priceId = process.env.STRIPE_BOOST_PRICE_ID;
  if (!priceId) throw new Error('STRIPE_BOOST_PRICE_ID not set');
  const origin = siteOrigin();
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/jobs/${input.slug}?boosted=1`,
    cancel_url: `${origin}/jobs/${input.slug}?canceled=1`,
    metadata: { postingId: input.postingId, orderId: input.orderId },
    payment_intent_data: { metadata: { postingId: input.postingId, orderId: input.orderId } },
    customer_email: input.customerEmail,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url, sessionId: session.id };
}

export function constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
  const webhookSecret = process.env.STRIPE_JOBS_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_JOBS_WEBHOOK_SECRET not set');
  return getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
}

export async function refundPaymentIntent(paymentIntentId: string): Promise<void> {
  await getStripe().refunds.create({ payment_intent: paymentIntentId });
}
