import type Stripe from 'stripe';
import { createServerFileRoute } from '@tanstack/react-start/server';
import { Effect } from 'effect';
import { constructWebhookEvent } from '@/lib/jobs/payments';
import { JobsService, JobsServiceLive } from '@/lib/jobs/jobs-service';

export const ServerRoute = createServerFileRoute('/api/jobs/stripe-webhook').methods({
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

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const paymentIntent =
        typeof session.payment_intent === 'string' ? session.payment_intent : null;

      if (session.id) {
        try {
          await Effect.runPromise(
            Effect.flatMap(JobsService, (s) => s.markBoostPaid(session.id ?? '', paymentIntent)).pipe(
              Effect.provide(JobsServiceLive)
            )
          );
        } catch (err) {
          // Return 5xx so Stripe RETRIES the webhook — swallowing the error left
          // a paid order stuck 'pending' with no second chance. markBoostPaid is
          // idempotent (no-op once the order is completed), so retries are safe.
          console.error('[stripe-webhook] markBoostPaid failed', err);
          return new Response('Failed to process payment', { status: 500 });
        }
      }
    }

    return Response.json({ received: true });
  },
});
