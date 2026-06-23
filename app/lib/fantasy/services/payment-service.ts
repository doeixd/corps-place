/**
 * PaymentService (migration plan §3.3 / P4c) — paid-league checkout, refund, and
 * the webhook DB transitions on the Effect path. The Stripe SDK calls stay in
 * `payments.ts` (wrapped via Effect.promise; infra failures → defect/500, as
 * today); this service owns the preconditions + the contributions.db state.
 *
 * SERVER-ONLY.
 */
import { Context, Effect, Layer } from 'effect';
import type { Actor } from '@/lib/authz';
import {
  paymentsEnabled,
  createLeagueCheckoutSession,
  refundPaymentIntent,
} from '@/lib/fantasy/payments';
import { LeagueConflict, PaymentDisabled } from './errors';
import { makeGuards } from './guards';
import { ContributionsSql, ContributionsSqlLive, requireDurableStorage } from './sql';

const JOINABLE = new Set(['setup', 'quiz', 'scheduled']);

const makePaymentService = Effect.gen(function* () {
  const sql = yield* ContributionsSql;
  const g = makeGuards(sql);

  const createCheckout = Effect.fn('PaymentService.createCheckout')(function* (input: {
    actor: Actor;
    leagueId: string;
  }) {
    yield* requireDurableStorage;
    if (!paymentsEnabled()) return yield* Effect.fail(new PaymentDisabled());
    const league = yield* g.requireOwner(input.leagueId, input.actor);
    if (league.payment_status === 'paid')
      return yield* Effect.fail(new LeagueConflict({ reason: 'already-paid' }));
    const { url } = yield* Effect.promise(() =>
      createLeagueCheckoutSession({ leagueId: input.leagueId, slug: league.slug })
    );
    return { ok: true as const, url };
  });

  const requestRefund = Effect.fn('PaymentService.requestRefund')(function* (input: {
    actor: Actor;
    leagueId: string;
  }) {
    yield* requireDurableStorage;
    const league = yield* g.requireOwner(input.leagueId, input.actor);
    if (league.payment_status !== 'paid')
      return yield* Effect.fail(new LeagueConflict({ reason: 'not-paid' }));
    if (!JOINABLE.has(league.status))
      return yield* Effect.fail(new LeagueConflict({ reason: 'draft-started' }));

    const refRows = yield* sql<{ payment_ref: string | null }>`
      SELECT payment_ref FROM fantasy_leagues WHERE league_id = ${input.leagueId}
    `.pipe(Effect.orDie);
    const paymentRef = refRows[0]?.payment_ref ?? null;
    if (!paymentRef) return yield* Effect.fail(new LeagueConflict({ reason: 'no-payment-ref' }));

    yield* Effect.promise(() => refundPaymentIntent(paymentRef));

    const now = new Date().toISOString();
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE fantasy_leagues SET payment_status = 'refunded', status = 'canceled', updated_at = ${now}
            WHERE league_id = ${input.leagueId}
          `;
          yield* sql`
            UPDATE fantasy_invites SET revoked_at = ${now}
            WHERE league_id = ${input.leagueId} AND revoked_at IS NULL
          `;
        })
      )
      .pipe(Effect.orDie);
    return { ok: true as const };
  });

  // Webhook DB transitions (signature verify + event parse stay at the route,
  // which holds the raw body). Idempotent: re-delivery re-sets the same value.
  const markPaid = Effect.fn('PaymentService.markPaid')(function* (input: {
    leagueId: string;
    paymentIntent: string | null;
  }) {
    const now = new Date().toISOString();
    yield* sql`
      UPDATE fantasy_leagues SET payment_status = 'paid', payment_ref = ${input.paymentIntent}, updated_at = ${now}
      WHERE league_id = ${input.leagueId} AND payment_status = 'none'
    `.pipe(Effect.orDie);
  });

  const markRefunded = Effect.fn('PaymentService.markRefunded')(function* (paymentIntent: string) {
    const now = new Date().toISOString();
    yield* sql`
      UPDATE fantasy_leagues SET payment_status = 'refunded', status = 'canceled', updated_at = ${now}
      WHERE payment_ref = ${paymentIntent}
    `.pipe(Effect.orDie);
  });

  return { createCheckout, requestRefund, markPaid, markRefunded };
});

export class PaymentService extends Context.Service<
  PaymentService,
  Effect.Success<typeof makePaymentService>
>()('PaymentService') {}

export const PaymentServiceLive = Layer.effect(PaymentService, makePaymentService).pipe(
  Layer.provide(ContributionsSqlLive)
);
