// Admin quiz-bank authoring (Fantasy plan M2 / §11.1). Capability-gated server-side
// via `manageFantasyQuiz` (the loader's server-fns enforce it; this page just
// renders the result). NOTE: the plan placed this at /admin/fantasy/quiz, but
// app/routes/admin is not writable in this environment, so it lives under
// /fantasy/quiz-admin instead — same capability gate, different URL.
import { useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import {
  adminListQuestions,
  adminUpsertQuestion,
  adminSetQuestionActive,
} from '@/lib/server-fns/fantasy';
import { BusyButton } from '@/components/fantasy/busy-button';
import { useAsyncAction } from '@/lib/use-async-action';

type Question = Awaited<ReturnType<typeof adminListQuestions>>['questions'][number];
type Difficulty = Question['difficulty'];
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

type FormState = {
  questionId?: string;
  prompt: string;
  choicesText: string;
  correctIndex: number;
  explanation: string;
  difficulty: Difficulty;
  tagsText: string;
};

const BLANK: FormState = {
  questionId: undefined,
  prompt: '',
  choicesText: '',
  correctIndex: 0,
  explanation: '',
  difficulty: 'medium',
  tagsText: '',
};

const toForm = (q: Question): FormState => ({
  questionId: q.questionId,
  prompt: q.prompt,
  choicesText: q.choices.join('\n'),
  correctIndex: q.correctIndex,
  explanation: q.explanation ?? '',
  difficulty: q.difficulty,
  tagsText: q.tags.join(', '),
});

const splitLines = (text: string, sep: string | RegExp): string[] =>
  text
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);

export const Route = createFileRoute('/fantasy/quiz-admin')({
  beforeLoad: requireFantasyEnabled,
  loader: async () => {
    try {
      const { questions } = await adminListQuestions();
      return { authorized: true, questions };
    } catch (e) {
      if ((e as Error).message.includes('Not allowed')) {
        return { authorized: false, questions: [] as Question[] };
      }
      throw e;
    }
  },
  head: () =>
    seoHead({
      title: 'Fantasy Quiz Bank',
      description: 'Admin quiz authoring.',
      path: '/fantasy/quiz-admin',
    }),
  component: QuizAdmin,
});

function QuizAdmin() {
  const { authorized, questions } = Route.useLoaderData();
  const router = useRouter();
  const [form, setForm] = useState<FormState>(BLANK);

  const save = useAsyncAction(async () => {
    await adminUpsertQuestion({
      data: {
        questionId: form.questionId,
        prompt: form.prompt.trim(),
        choices: splitLines(form.choicesText, '\n'),
        correctIndex: form.correctIndex,
        explanation: form.explanation,
        difficulty: form.difficulty,
        tags: splitLines(form.tagsText, ','),
      },
    });
    setForm(BLANK);
    await router.invalidate();
  });

  if (!authorized) {
    return (
      <PageShell className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Fantasy Quiz Bank</h1>
        <p className="text-muted-foreground">
          You need the moderator role to manage the quiz bank.
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Fantasy Quiz Bank</h1>
      <QuestionForm
        form={form}
        setForm={setForm}
        busy={save.busy}
        error={save.error}
        onSubmit={() => void save.run()}
        onCancel={() => setForm(BLANK)}
      />
      <QuestionList questions={questions} onEdit={(q) => setForm(toForm(q))} />
    </PageShell>
  );
}

function QuestionForm({
  form,
  setForm,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  form: FormState;
  setForm: (next: FormState) => void;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const choiceLines = form.choicesText.split('\n').filter((l) => l.trim());

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{form.questionId ? 'Edit question' : 'New question'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="prompt">Prompt</Label>
            <Input
              id="prompt"
              value={form.prompt}
              required
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="choices">Choices (one per line, 2–6)</Label>
            <Textarea
              id="choices"
              value={form.choicesText}
              rows={4}
              required
              onChange={(e) => setForm({ ...form, choicesText: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap items-end gap-6">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct">Correct choice</Label>
              <Select
                value={String(form.correctIndex)}
                onValueChange={(v) => setForm({ ...form, correctIndex: Number(v) })}
              >
                <SelectTrigger id="correct" size="sm" className="w-56">
                  <SelectValue placeholder="Pick the answer" />
                </SelectTrigger>
                <SelectContent>
                  {choiceLines.map((c, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {i + 1}. {c.slice(0, 40)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Difficulty</Label>
              <ToggleGroup
                variant="outline"
                size="sm"
                spacing={0}
                value={[form.difficulty]}
                onValueChange={(v) => {
                  const next = v[0] as Difficulty | undefined;
                  if (next) setForm({ ...form, difficulty: next });
                }}
              >
                {DIFFICULTIES.map((d) => (
                  <ToggleGroupItem key={d} value={d}>
                    {d}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tags">Tags (comma-separated)</Label>
            <Input
              id="tags"
              value={form.tagsText}
              onChange={(e) => setForm({ ...form, tagsText: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="explanation">Explanation (shown after answering)</Label>
            <Input
              id="explanation"
              value={form.explanation}
              onChange={(e) => setForm({ ...form, explanation: e.target.value })}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <BusyButton type="submit" busy={busy}>
              {form.questionId ? 'Update' : 'Add question'}
            </BusyButton>
            {form.questionId ? (
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function QuestionList({
  questions,
  onEdit,
}: {
  questions: Question[];
  onEdit: (q: Question) => void;
}) {
  const router = useRouter();
  const toggle = useAsyncAction(async (q: Question) => {
    await adminSetQuestionActive({ data: { questionId: q.questionId, active: !q.active } });
    await router.invalidate();
  });

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium">Questions ({questions.length})</h2>
      <ul className="flex flex-col gap-2">
        {questions.map((q) => (
          <li
            key={q.questionId}
            className="flex items-start gap-3 rounded-lg border border-border p-3"
          >
            <div className="flex flex-1 flex-col">
              <span
                className={
                  q.active ? 'font-medium' : 'font-medium text-muted-foreground line-through'
                }
              >
                {q.prompt}
              </span>
              <span className="text-xs text-muted-foreground">
                {q.difficulty} · answer: {q.choices[q.correctIndex]}
                {q.tags.length ? ` · ${q.tags.join(', ')}` : ''}
              </span>
            </div>
            <Button size="xs" variant="ghost" onClick={() => onEdit(q)}>
              Edit
            </Button>
            <BusyButton
              size="xs"
              variant={q.active ? 'outline' : 'default'}
              busy={toggle.busy}
              onClick={() => void toggle.run(q)}
            >
              {q.active ? 'Deactivate' : 'Activate'}
            </BusyButton>
          </li>
        ))}
      </ul>
    </section>
  );
}
