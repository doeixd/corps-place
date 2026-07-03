import type Stripe from 'stripe';
import { createFileRoute } from '@tanstack/react-router';
import { Effect } from 'effect';
import { constructWebhookEvent } from '@/lib/jobs/payments';
import { JobsService, JobsServiceLive } from '@/lib/jobs/jobs-service';

export const Route = createFileRoute('/api/jobs/stripe-webhook')({
  server: {
    handlers: {
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
      const postingId = session.metadata?.postingId;
      const paymentIntent =
        typeof session.payment_intent === 'string' ? session.payment_intent : null;

      if (session.id && postingId) {
        await Effect.runPromise(
          Effect.flatMap(JobsService, (s) => s.markBoostPaid(session.id ?? '', paymentIntent)).pipe(
            Effect.provide(JobsServiceLive)
          )
        );
      }
    }

    return Response.json({ received: true });
  },
    },
  },
});
