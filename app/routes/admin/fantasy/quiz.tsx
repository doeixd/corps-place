// Fantasy quiz bank CRUD (ADMIN_PAGE_PLAN §9.1). Reuses the quiz server-fns; questions
// fetched in the loader, refreshed via invalidate. correct_index shown only to admins.
import { useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/reui/badge';
import { useAsyncAction } from '@/lib/use-async-action';
import {
  adminListQuestions,
  adminUpsertQuestion,
  adminSetQuestionActive,
} from '@/lib/server-fns/fantasy';
import { seoHead } from '@/lib/seo';

type Difficulty = 'easy' | 'medium' | 'hard';
type Question = Awaited<ReturnType<typeof adminListQuestions>>['questions'][number];
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

export const Route = createFileRoute('/admin/fantasy/quiz')({
  loader: adminLoader('manageFantasyQuiz', async () => (await adminListQuestions()).questions),
  head: () =>
    seoHead({
      title: 'Admin — Fantasy quiz',
      description: 'Quiz bank',
      path: '/admin/fantasy/quiz',
    }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return (
      <AdminPage gate={gate}>{() => <Quiz questions={(data ?? []) as Question[]} />}</AdminPage>
    );
  },
});

function Quiz({ questions }: { questions: Question[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [choicesText, setChoicesText] = useState('');
  const [correctIndex, setCorrectIndex] = useState(0);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [explanation, setExplanation] = useState('');

  const counts = (['easy', 'medium', 'hard'] as Difficulty[]).map(
    (d) => `${d}: ${questions.filter((q) => q.active && q.difficulty === d).length}`
  );

  const resetForm = () => {
    setEditingId(null);
    setPrompt('');
    setChoicesText('');
    setCorrectIndex(0);
    setDifficulty('medium');
    setExplanation('');
  };
  const startEdit = (q: Question) => {
    setEditingId(q.questionId);
    setPrompt(q.prompt);
    setChoicesText(q.choices.join('\n'));
    setCorrectIndex(q.correctIndex);
    setDifficulty(q.difficulty);
    setExplanation(q.explanation ?? '');
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // One form, two modes: create (no editingId) or update (editingId set → UPDATE by id).
  const save = useAsyncAction(async () => {
    const choices = choicesText
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);
    if (choices.length < 2) throw new Error('At least 2 choices (one per line).');
    if (correctIndex >= choices.length) throw new Error('Correct index out of range.');
    await adminUpsertQuestion({
      data: {
        questionId: editingId ?? undefined,
        prompt,
        choices,
        correctIndex,
        explanation,
        difficulty,
        tags: [],
      },
    });
    resetForm();
    await router.invalidate();
  });
  const toggle = useAsyncAction(async (q: Question) => {
    await adminSetQuestionActive({ data: { questionId: q.questionId, active: !q.active } });
    await router.invalidate();
  });

  return (
    <>
      <PageHeader title="Fantasy quiz bank" subtitle={`Active — ${counts.join(' · ')}`} />
      <Show when={save.error || toggle.error}>
        <p className="mb-4 text-sm text-destructive">{save.error ?? toggle.error}</p>
      </Show>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">
            {editingId ? 'Edit question' : 'New question'}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <Input placeholder="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <Textarea
            placeholder="Choices — one per line"
            value={choicesText}
            onChange={(e) => setChoicesText(e.target.value)}
            rows={4}
          />
          <Input
            placeholder="Explanation (optional — shown on the post-quiz review)"
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-text-secondary">Correct answer</label>
            <Select
              value={String(correctIndex)}
              onValueChange={(v) => v && setCorrectIndex(Number(v))}
            >
              <SelectTrigger size="sm" className="w-auto min-w-44 max-w-xs">
                <SelectValue placeholder="Pick the correct choice" />
              </SelectTrigger>
              <SelectContent>
                {choicesText
                  .split('\n')
                  .map((c) => c.trim())
                  .filter(Boolean)
                  .map((choice, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {i + 1}. {choice}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Select value={difficulty} onValueChange={(v) => v && setDifficulty(v as Difficulty)}>
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <For each={DIFFICULTIES}>{(d) => <SelectItem value={d}>{d}</SelectItem>}</For>
              </SelectContent>
            </Select>
            {editingId ? (
              <Button size="sm" variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            ) : null}
            <BusyButton
              size="sm"
              className={editingId ? '' : 'ml-auto'}
              busy={save.busy}
              disabled={!prompt}
              onClick={() => void save.run()}
            >
              {editingId ? 'Save changes' : 'Add'}
            </BusyButton>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Bank ({questions.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Show
            when={questions.length > 0}
            fallback={<p className="text-text-secondary">No questions yet.</p>}
          >
            <div className="flex flex-col divide-y divide-border">
              <For each={questions}>
                {(q) => (
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                    <span
                      className={
                        q.active ? 'font-medium' : 'font-medium text-text-secondary line-through'
                      }
                    >
                      {q.prompt}
                    </span>
                    <Badge variant="secondary" size="sm">
                      {q.difficulty}
                    </Badge>
                    <span className="text-xs text-text-secondary">
                      {q.choices.length} choices · correct #{q.correctIndex}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      onClick={() => startEdit(q)}
                    >
                      Edit
                    </Button>
                    <BusyButton
                      variant="ghost"
                      size="sm"
                      busy={toggle.busy}
                      onClick={() => void toggle.run(q)}
                    >
                      {q.active ? 'Deactivate' : 'Activate'}
                    </BusyButton>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </CardContent>
      </Card>
    </>
  );
}
