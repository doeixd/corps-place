import type Stripe from 'stripe';
import { createServerFileRoute } from '@tanstack/react-start/server';
import { getContributionsDb } from '@/lib/contributions-db';
import { constructWebhookEvent } from '@/lib/fantasy/payments';

/**
 * Stripe webhook (Fantasy DCI plan §12.2/§12.4). The ONLY thing that flips a
 * league to paid — never trust client-reported status. Signature-verified with
 * the raw body; idempotent (re-delivery just re-sets the same value). On a
 * `checkout.session.completed` we record the payment intent in `payment_ref`
 * (needed for refunds); an external `charge.refunded` flips it back.
 */
export const ServerRoute = createServerFileRoute('/api/fantasy/stripe-webhook').methods({
  POST: async ({ request }) => {
    const signature = request.headers.get('stripe-signature');
    if (!signature) return new Response('Missing signature', { status: 400 });

    const rawBody = await request.text();
    let event: Stripe.Event;
    try {
      event = constructWebhookEvent(rawBody, signature);
    } catch {
      return new Response('Webhook signature verification failed', { status: 400 });
    }

    const db = await getContributionsDb();
    const now = new Date().toISOString();

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const leagueId = session.metadata?.leagueId;
      const paymentIntent =
        typeof session.payment_intent === 'string' ? session.payment_intent : null;
      if (leagueId) {
        // Only flip an as-yet-unpaid league. Guards against a re-delivered or
        // out-of-order completed event resurrecting a refunded/canceled league.
        await db.execute({
          sql: "UPDATE fantasy_leagues SET payment_status = 'paid', payment_ref = ?, updated_at = ? WHERE league_id = ? AND payment_status = 'none'",
          args: [paymentIntent, now, leagueId],
        });
      }
    } else if (event.type === 'charge.refunded') {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntent =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
      if (paymentIntent) {
        await db.execute({
          sql: "UPDATE fantasy_leagues SET payment_status = 'refunded', status = 'canceled', updated_at = ? WHERE payment_ref = ?",
          args: [now, paymentIntent],
        });
      }
    }

    return Response.json({ received: true });
  },
});
