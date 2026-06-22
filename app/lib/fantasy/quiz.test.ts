import { describe, it, expect } from 'vite-plus/test';
import { planQuestionCounts, scoreQuiz, type ServedQuestion } from './quiz';

describe('planQuestionCounts', () => {
  it('uses the 40/40/20 mix when plenty are available', () => {
    expect(planQuestionCounts(10, { easy: 50, medium: 50, hard: 50 })).toEqual({
      easy: 4,
      medium: 4,
      hard: 2,
    });
  });

  it('backfills from other buckets when one difficulty is short', () => {
    const counts = planQuestionCounts(10, { easy: 50, medium: 1, hard: 50 });
    expect(counts.easy + counts.medium + counts.hard).toBe(10);
    expect(counts.medium).toBe(1);
  });

  it('caps at the total available when fewer exist than requested', () => {
    const counts = planQuestionCounts(10, { easy: 2, medium: 1, hard: 0 });
    expect(counts.easy + counts.medium + counts.hard).toBe(3);
  });
});

describe('scoreQuiz', () => {
  const served: ServedQuestion[] = [
    { difficulty: 'easy', correctIndex: 0 }, // weight 1
    { difficulty: 'medium', correctIndex: 1 }, // weight 2
    { difficulty: 'hard', correctIndex: 2 }, // weight 3
  ];

  it('weights correct answers by difficulty', () => {
    const score = scoreQuiz(served, [0, 1, 2]); // all correct
    expect(score.raw).toBe(6);
    expect(score.max).toBe(6);
    expect(score.weighted).toBe(1);
  });

  it('only the hard answer correct → 3/6', () => {
    const score = scoreQuiz(served, [9, 9, 2]);
    expect(score.raw).toBe(3);
    expect(score.max).toBe(6);
    expect(score.weighted).toBeCloseTo(0.5, 5);
  });

  it('blank/missing answers score 0 for that question', () => {
    const score = scoreQuiz(served, [0]); // only first answered
    expect(score.raw).toBe(1);
    expect(score.max).toBe(6);
  });
});
