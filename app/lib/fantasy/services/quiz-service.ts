/**
 * QuizService (migration plan §3.3 / P2d) — admin question bank CRUD + the member
 * quiz run (getQuizForLeague / submitQuiz). Ports the legacy quiz server-fns onto
 * the Effect path; the pure composition/scoring stays in `@/lib/fantasy/quiz`.
 *
 * Capability gating (manageFantasyQuiz) is enforced at the boundary; the admin
 * methods receive the already-authorized actor. The served set NEVER includes
 * correct_index; submitQuiz uses the race-safe completing UPDATE.
 *
 * SERVER-ONLY.
 */
import { Context, Effect, Layer } from 'effect';
import { randomUUID } from 'node:crypto';
import type { Actor } from '@/lib/authz';
import type { LeagueConfig } from '@/lib/fantasy/config';
import {
  planQuestionCounts,
  scoreQuiz,
  type Difficulty,
  type ServedQuestion,
} from '@/lib/fantasy/quiz';
import { seededShuffle } from '@/lib/fantasy/draft-order';
import { QuizConflict } from './errors';
import { makeGuards } from './guards';
import { ContributionsSql, ContributionsSqlLive, requireDurableStorage } from './sql';

const GRACE_SECONDS = 30;

export interface UpsertQuestionInput {
  actor: Actor;
  questionId?: string;
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation?: string;
  difficulty: Difficulty;
  tags?: string[];
}

const makeQuizService = Effect.gen(function* () {
  const sql = yield* ContributionsSql;
  const g = makeGuards(sql);

  const audit = (actorId: string, action: string, after: unknown) =>
    sql`
      INSERT INTO fantasy_admin_audit
        (audit_id, actor_user_id, action, league_id, before_json, after_json, created_at)
      VALUES (${randomUUID()}, ${actorId}, ${action}, ${null}, ${null},
              ${after == null ? null : JSON.stringify(after)}, ${new Date().toISOString()})
    `.pipe(Effect.orDie, Effect.asVoid);

  const adminListQuestions = Effect.fn('QuizService.adminListQuestions')(function* () {
    const rows = yield* sql<{
      question_id: string;
      prompt: string;
      choices_json: string;
      correct_index: number;
      explanation: string | null;
      difficulty: string;
      tags_json: string;
      active: number;
    }>`
      SELECT question_id, prompt, choices_json, correct_index, explanation, difficulty,
             tags_json, active, created_at, updated_at
      FROM fantasy_quiz_questions ORDER BY created_at DESC
    `.pipe(Effect.orDie);
    return {
      questions: rows.map((q) => ({
        questionId: q.question_id,
        prompt: q.prompt,
        choices: JSON.parse(q.choices_json) as string[],
        correctIndex: Number(q.correct_index),
        explanation: q.explanation == null ? null : q.explanation,
        difficulty: q.difficulty as Difficulty,
        tags: JSON.parse(q.tags_json) as string[],
        active: Boolean(q.active),
      })),
    };
  });

  const adminUpsertQuestion = Effect.fn('QuizService.adminUpsertQuestion')(function* (
    input: UpsertQuestionInput
  ) {
    yield* requireDurableStorage;
    if (input.correctIndex >= input.choices.length)
      return yield* Effect.fail(new QuizConflict({ reason: 'bad-correct-index' }));

    const now = new Date().toISOString();
    const questionId = input.questionId ?? randomUUID();
    const choicesJson = JSON.stringify(input.choices);
    const tagsJson = JSON.stringify(input.tags ?? []);

    if (input.questionId) {
      yield* sql`
        UPDATE fantasy_quiz_questions
        SET prompt = ${input.prompt}, choices_json = ${choicesJson}, correct_index = ${input.correctIndex},
            explanation = ${input.explanation ?? ''}, difficulty = ${input.difficulty},
            tags_json = ${tagsJson}, updated_at = ${now}
        WHERE question_id = ${questionId}
      `.pipe(Effect.orDie);
    } else {
      yield* sql`
        INSERT INTO fantasy_quiz_questions
          (question_id, prompt, choices_json, correct_index, explanation, difficulty,
           tags_json, active, author_user_id, created_at, updated_at)
        VALUES (${questionId}, ${input.prompt}, ${choicesJson}, ${input.correctIndex},
                ${input.explanation ?? ''}, ${input.difficulty}, ${tagsJson}, 1,
                ${input.actor.userId}, ${now}, ${now})
      `.pipe(Effect.orDie);
    }
    yield* audit(input.actor.userId, input.questionId ? 'quiz.update' : 'quiz.create', {
      questionId,
    });
    return { ok: true as const, questionId };
  });

  const adminSetQuestionActive = Effect.fn('QuizService.adminSetQuestionActive')(function* (input: {
    actor: Actor;
    questionId: string;
    active: boolean;
  }) {
    yield* requireDurableStorage;
    yield* sql`
      UPDATE fantasy_quiz_questions SET active = ${input.active ? 1 : 0}, updated_at = ${new Date().toISOString()}
      WHERE question_id = ${input.questionId}
    `.pipe(Effect.orDie);
    yield* audit(input.actor.userId, 'quiz.setActive', {
      questionId: input.questionId,
      active: input.active,
    });
    return { ok: true as const };
  });

  const getQuizForLeague = Effect.fn('QuizService.getQuizForLeague')(function* (input: {
    actor: Actor;
    leagueId: string;
  }) {
    yield* g.requireMember(input.leagueId, input.actor);
    const league = yield* g.loadLeagueById(input.leagueId);
    const quizCfg = (JSON.parse(league.config_json) as LeagueConfig).quiz;
    if (!quizCfg.enabled) return { state: 'disabled' as const };

    // Already completed? (one scored attempt per member, §A9.)
    const done = yield* sql<{ weighted_score: number }>`
      SELECT weighted_score FROM fantasy_quiz_attempts
      WHERE league_id = ${input.leagueId} AND user_id = ${input.actor.userId} AND completed_at IS NOT NULL
    `.pipe(Effect.orDie);
    if (done[0]) return { state: 'done' as const, weightedScore: Number(done[0].weighted_score) };

    // Resume an in-progress attempt, else compose + create one.
    const inProgress = yield* sql<{
      attempt_id: string;
      question_ids_json: string;
      started_at: string;
    }>`
      SELECT attempt_id, question_ids_json, started_at FROM fantasy_quiz_attempts
      WHERE league_id = ${input.leagueId} AND user_id = ${input.actor.userId} AND completed_at IS NULL
    `.pipe(Effect.orDie);

    let attemptId: string;
    let startedAt: string;
    let questionIds: string[];

    if (inProgress[0]) {
      attemptId = inProgress[0].attempt_id;
      startedAt = inProgress[0].started_at;
      questionIds = JSON.parse(inProgress[0].question_ids_json) as string[];
    } else {
      const active = yield* sql<{ question_id: string; difficulty: string }>`
        SELECT question_id, difficulty FROM fantasy_quiz_questions WHERE active = 1
      `.pipe(Effect.orDie);
      if (active.length === 0) return { state: 'unavailable' as const };

      const idsByDiff = (d: Difficulty) =>
        active.filter((q) => q.difficulty === d).map((q) => q.question_id);
      const byDiff = {
        easy: idsByDiff('easy'),
        medium: idsByDiff('medium'),
        hard: idsByDiff('hard'),
      };
      const counts = planQuestionCounts(quizCfg.questionCount, {
        easy: byDiff.easy.length,
        medium: byDiff.medium.length,
        hard: byDiff.hard.length,
      });
      const seed = `${input.leagueId}:${input.actor.userId}`;
      const pick = (ids: string[], n: number) => seededShuffle(ids, seed).slice(0, n);
      questionIds = seededShuffle(
        [
          ...pick(byDiff.easy, counts.easy),
          ...pick(byDiff.medium, counts.medium),
          ...pick(byDiff.hard, counts.hard),
        ],
        seed
      );
      startedAt = new Date().toISOString();
      attemptId = randomUUID();
      yield* sql`
        INSERT INTO fantasy_quiz_attempts
          (attempt_id, league_id, user_id, question_ids_json, answers_json, started_at)
        VALUES (${attemptId}, ${input.leagueId}, ${input.actor.userId}, ${JSON.stringify(questionIds)}, '[]', ${startedAt})
      `.pipe(Effect.orDie);
    }

    // Hydrate prompts + choices ONLY (never correct_index) in served order.
    const rows = yield* sql<{ question_id: string; prompt: string; choices_json: string }>`
      SELECT question_id, prompt, choices_json FROM fantasy_quiz_questions
      WHERE ${sql.in('question_id', questionIds)}
    `.pipe(Effect.orDie);
    const byId = new Map(rows.map((r) => [r.question_id, r]));
    const questions = questionIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => ({
        questionId: r.question_id,
        prompt: r.prompt,
        choices: JSON.parse(r.choices_json) as string[],
      }));

    const endsAt = new Date(
      new Date(startedAt).getTime() + questionIds.length * quizCfg.perQuestionSeconds * 1000
    ).toISOString();

    return { state: 'in_progress' as const, attemptId, questions, startedAt, endsAt };
  });

  const submitQuiz = Effect.fn('QuizService.submitQuiz')(function* (input: {
    actor: Actor;
    leagueId: string;
    answers: number[];
  }) {
    yield* requireDurableStorage;
    yield* g.requireMember(input.leagueId, input.actor);

    const attempts = yield* sql<{
      attempt_id: string;
      question_ids_json: string;
      started_at: string;
    }>`
      SELECT attempt_id, question_ids_json, started_at FROM fantasy_quiz_attempts
      WHERE league_id = ${input.leagueId} AND user_id = ${input.actor.userId} AND completed_at IS NULL
    `.pipe(Effect.orDie);
    const attempt = attempts[0];
    if (!attempt) return yield* Effect.fail(new QuizConflict({ reason: 'no-attempt' }));

    const league = yield* g.loadLeagueById(input.leagueId);
    const perQuestionSeconds = (JSON.parse(league.config_json) as LeagueConfig).quiz
      .perQuestionSeconds;

    const questionIds = JSON.parse(attempt.question_ids_json) as string[];
    const elapsedSec = (Date.now() - new Date(attempt.started_at).getTime()) / 1000;
    if (elapsedSec > questionIds.length * perQuestionSeconds + GRACE_SECONDS)
      return yield* Effect.fail(new QuizConflict({ reason: 'expired' }));

    // Load difficulty + correct answers (server-side only) in served order.
    const rows = yield* sql<{ question_id: string; difficulty: string; correct_index: number }>`
      SELECT question_id, difficulty, correct_index FROM fantasy_quiz_questions
      WHERE ${sql.in('question_id', questionIds)}
    `.pipe(Effect.orDie);
    const byId = new Map(
      rows.map((r) => [
        r.question_id,
        { difficulty: r.difficulty as Difficulty, correctIndex: Number(r.correct_index) },
      ])
    );
    const served: ServedQuestion[] = questionIds.map((id) => {
      const q = byId.get(id);
      return { difficulty: q?.difficulty ?? 'easy', correctIndex: q?.correctIndex ?? -1 };
    });

    const score = scoreQuiz(served, input.answers);
    const now = new Date().toISOString();

    // Race-safe completion: only the FIRST submit (completed_at NULL) wins, so a
    // member can't re-score. RETURNING confirms we won.
    const completed = yield* sql<{ attempt_id: string }>`
      UPDATE fantasy_quiz_attempts
      SET answers_json = ${JSON.stringify(input.answers)}, raw_score = ${score.raw},
          max_score = ${score.max}, weighted_score = ${score.weighted}, completed_at = ${now}
      WHERE attempt_id = ${attempt.attempt_id} AND completed_at IS NULL
      RETURNING attempt_id
    `.pipe(Effect.orDie);
    if (completed.length !== 1)
      return yield* Effect.fail(new QuizConflict({ reason: 'already-done' }));

    yield* sql`
      UPDATE fantasy_members SET quiz_score = ${score.weighted}
      WHERE league_id = ${input.leagueId} AND user_id = ${input.actor.userId}
    `.pipe(Effect.orDie);

    return { ok: true as const, weightedScore: score.weighted };
  });

  // Post-completion review: the member's finished attempt with each served question,
  // their answer, and the correct answer. Only for a COMPLETED attempt (the quiz is
  // over, so revealing correct_index can't be used to game the score). Member-gated.
  const getQuizReview = Effect.fn('QuizService.getQuizReview')(function* (input: {
    actor: Actor;
    leagueId: string;
  }) {
    yield* g.requireMember(input.leagueId, input.actor);
    const attempts = yield* sql<{ question_ids_json: string; answers_json: string | null }>`
      SELECT question_ids_json, answers_json FROM fantasy_quiz_attempts
      WHERE league_id = ${input.leagueId} AND user_id = ${input.actor.userId} AND completed_at IS NOT NULL
    `.pipe(Effect.orDie);
    const attempt = attempts[0];
    if (!attempt) return { available: false as const };

    const questionIds = JSON.parse(attempt.question_ids_json) as string[];
    const answers = (attempt.answers_json ? JSON.parse(attempt.answers_json) : []) as number[];

    const rows = yield* sql<{
      question_id: string;
      prompt: string;
      choices_json: string;
      correct_index: number;
      explanation: string | null;
    }>`
      SELECT question_id, prompt, choices_json, correct_index, explanation
      FROM fantasy_quiz_questions WHERE ${sql.in('question_id', questionIds)}
    `.pipe(Effect.orDie);
    const byId = new Map(rows.map((r) => [r.question_id, r]));

    const items = questionIds
      .map((id, i) => {
        const r = byId.get(id);
        if (!r) return null;
        return {
          prompt: r.prompt,
          choices: JSON.parse(r.choices_json) as string[],
          correctIndex: Number(r.correct_index),
          yourIndex: typeof answers[i] === 'number' ? answers[i] : -1,
          explanation: r.explanation ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);

    return { available: true as const, items };
  });

  return {
    adminListQuestions,
    adminUpsertQuestion,
    adminSetQuestionActive,
    getQuizForLeague,
    submitQuiz,
    getQuizReview,
  };
});

export class QuizService extends Context.Service<
  QuizService,
  Effect.Success<typeof makeQuizService>
>()('QuizService') {}

export const QuizServiceLive = Layer.effect(QuizService, makeQuizService).pipe(
  Layer.provide(ContributionsSqlLive)
);
