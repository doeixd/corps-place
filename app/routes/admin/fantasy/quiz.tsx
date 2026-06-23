// Fantasy quiz bank CRUD (ADMIN_PAGE_PLAN §9.1). Reuses the existing quiz server-fns
// (adminListQuestions/adminUpsertQuestion/adminSetQuestionActive). Gated by
// manageFantasyQuiz. correct_index is intentionally only ever shown to admins here.
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  adminListQuestions,
  adminUpsertQuestion,
  adminSetQuestionActive,
} from '@/lib/server-fns/fantasy';
import { seoHead } from '@/lib/seo';

type Difficulty = 'easy' | 'medium' | 'hard';
interface Question {
  questionId: string;
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation: string | null;
  difficulty: Difficulty;
  tags: string[];
  active: boolean;
}

export const Route = createFileRoute('/admin/fantasy/quiz')({
  loader: requireAdminLoader('manageFantasyQuiz'),
  head: () =>
    seoHead({
      title: 'Admin — Fantasy quiz',
      description: 'Quiz bank',
      path: '/admin/fantasy/quiz',
    }),
  component: () => {
    const gate = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Quiz />}</AdminPage>;
  },
});

function Quiz() {
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-question form
  const [prompt, setPrompt] = useState('');
  const [choicesText, setChoicesText] = useState('');
  const [correctIndex, setCorrectIndex] = useState(0);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');

  const reload = useCallback(() => {
    adminListQuestions()
      .then((r) => setQuestions(r.questions as Question[]))
      .catch((e: unknown) => setError((e as Error).message));
  }, []);
  useEffect(() => reload(), [reload]);

  const counts = questions
    ? (['easy', 'medium', 'hard'] as Difficulty[]).map(
        (d) => `${d}: ${questions.filter((q) => q.active && q.difficulty === d).length}`
      )
    : [];

  const add = async () => {
    const choices = choicesText
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);
    if (choices.length < 2) return setError('At least 2 choices (one per line).');
    if (correctIndex >= choices.length) return setError('Correct index out of range.');
    setBusy(true);
    setError(null);
    try {
      await adminUpsertQuestion({ data: { prompt, choices, correctIndex, difficulty, tags: [] } });
      setPrompt('');
      setChoicesText('');
      setCorrectIndex(0);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (q: Question) =>
    adminSetQuestionActive({ data: { questionId: q.questionId, active: !q.active } })
      .then(reload)
      .catch((e: unknown) => setError((e as Error).message));

  return (
    <>
      <PageHeader
        title="Fantasy quiz bank"
        subtitle={counts.length ? `Active — ${counts.join(' · ')}` : ''}
      />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">New question</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <Input placeholder="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <Textarea
            placeholder="Choices — one per line"
            value={choicesText}
            onChange={(e) => setChoicesText(e.target.value)}
            rows={4}
          />
          <div className="flex items-center gap-2">
            <label className="text-text-secondary">Correct index</label>
            <Input
              className="w-20"
              type="number"
              value={String(correctIndex)}
              onChange={(e) => setCorrectIndex(Number(e.target.value))}
            />
            <select
              className="rounded border border-border bg-transparent px-2 py-1"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as Difficulty)}
            >
              <option value="easy">easy</option>
              <option value="medium">medium</option>
              <option value="hard">hard</option>
            </select>
            <Button
              size="sm"
              className="ml-auto"
              disabled={busy || !prompt}
              onClick={() => void add()}
            >
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Bank {questions ? `(${questions.length})` : ''}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {!questions ? (
            <p className="text-text-secondary">Loading…</p>
          ) : questions.length === 0 ? (
            <p className="text-text-secondary">No questions yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {questions.map((q) => (
                <div
                  key={q.questionId}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2"
                >
                  <span
                    className={
                      q.active ? 'font-medium' : 'font-medium text-text-secondary line-through'
                    }
                  >
                    {q.prompt}
                  </span>
                  <span className="text-xs text-text-secondary">{q.difficulty}</span>
                  <span className="text-xs text-text-secondary">
                    {q.choices.length} choices · correct #{q.correctIndex}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => void toggle(q)}
                  >
                    {q.active ? 'Deactivate' : 'Activate'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
