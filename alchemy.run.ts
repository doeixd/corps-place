/**
 * Alchemy Infrastructure-as-Code for Fantasy DCI payments (plan §12.1,
 * "Stripe + Alchemy"). This declaratively provisions the Stripe resources the
 * runtime payment code (`app/lib/fantasy/payments.ts`) depends on: a Product, a
 * one-time Price (the league fee), and the WebhookEndpoint that points at our
 * handler. Run at DEPLOY time (`tsx alchemy.run.ts` / `alchemy deploy`) — it is
 * NOT imported by the app and not part of the client/server bundle.
 *
 * After applying, copy the printed IDs/secret into the app environment:
 *   STRIPE_LEAGUE_PRICE_ID, STRIPE_WEBHOOK_SECRET
 * (plus STRIPE_SECRET_KEY for the runtime SDK, and FANTASY_PAYMENTS_ENABLED=true).
 */
import alchemy from 'alchemy';
import { Product, Price, WebhookEndpoint } from 'alchemy/stripe';

const app = await alchemy('drumcorps-fantasy');

const apiKey = alchemy.secret(process.env.STRIPE_API_KEY ?? '');
const origin = (process.env.BETTER_AUTH_URL ?? 'https://drumcorps.app').replace(/\/+$/, '');

export const leagueProduct = await Product('fantasy-league', {
  apiKey,
  name: 'Fantasy DCI League',
  description: 'One-time fee to create a private fantasy drum corps league for a season.',
});

export const leaguePrice = await Price('fantasy-league-fee', {
  apiKey,
  product: leagueProduct.id,
  currency: 'usd',
  unitAmount: 2000, // $20.00; adjust to taste
});

export const fantasyWebhook = await WebhookEndpoint('fantasy-stripe-webhook', {
  apiKey,
  url: `${origin}/api/fantasy/stripe-webhook`,
  enabledEvents: ['checkout.session.completed', 'charge.refunded'],
});

console.log('Set these in the app environment:');
console.log(`  STRIPE_LEAGUE_PRICE_ID=${leaguePrice.id}`);
console.log(`  STRIPE_WEBHOOK_SECRET=${fantasyWebhook.secret}`);

await app.finalize();
