import { useState } from 'react';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { updateLeagueConfig } from '@/lib/server-fns/fantasy';
import { Explain } from '@/components/fantasy/explain';
import { CAPTION_KEYS } from '@/lib/fantasy/captions';
import type { LeagueConfig } from '@/lib/fantasy/config';

/**
 * Owner-only league settings (§4.3) — an inline section on the dashboard (not a
 * modal). Edits the meaningful LeagueConfig fields and sends the WHOLE config to
 * updateLeagueConfig: resolveLeagueConfig merges over DEFAULT, so a partial would
 * silently reset unspecified fields; we spread the current config and override
 * only what's exposed here. Draft-shape fields disable once the draft has started
 * (the service enforces it too); scoring weights stay editable until finals week
 * (a late edit fails with a clear error).
 */
export function LeagueSettings({
  leagueId,
  config,
  draftStarted,
  onSaved,
}: {
  leagueId: string;
  config: LeagueConfig;
  draftStarted: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [draftType, setDraftType] = useState(config.draftType);
  const [pickSeconds, setPickSeconds] = useState(String(config.pickSeconds));
  const [scoringMode, setScoringMode] = useState(config.scoringMode);
  const [ge, setGe] = useState(String(config.weights.ge));
  const [visual, setVisual] = useState(String(config.weights.visual));
  const [music, setMusic] = useState(String(config.weights.music));
  const weightTotal = (Number(ge) || 0) + (Number(visual) || 0) + (Number(music) || 0);
  const weightsOk = Math.round(weightTotal) === 100;
  // Simplified to one value applied to EVERY caption (the draft is symmetric).
  // Seed it from the current config's most common per-caption value.
  const initialPerCaption = (() => {
    const counts = new Map<number, number>();
    for (const k of CAPTION_KEYS) {
      const v = config.captionCaps[k] ?? 0;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let best = 2;
    let bestCount = -1;
    for (const [v, c] of counts) if (c > bestCount) [best, bestCount] = [v, c];
    return best;
  })();
  const [perCaption, setPerCaption] = useState(String(initialPerCaption));
  const perCaptionNum = Math.max(0, Math.floor(Number(perCaption) || 0));
  const totalRounds = perCaptionNum * CAPTION_KEYS.length;
  const [quizEnabled, setQuizEnabled] = useState(config.quiz.enabled);
  const [questionCount, setQuestionCount] = useState(String(config.quiz.questionCount));
  const [notifyEmail, setNotifyEmail] = useState(config.notify?.email ?? true);
  const [notifyPush, setNotifyPush] = useState(config.notify?.push ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false); // collapsed by default — settings are advanced

  const save = async () => {
    if (!weightsOk) {
      setError('Caption weights must total 100%.');
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next: LeagueConfig = {
        ...config,
        draftType,
        captionCaps: Object.fromEntries(
          CAPTION_KEYS.map((k) => [k, perCaptionNum])
        ) as LeagueConfig['captionCaps'],
        pickSeconds: Number(pickSeconds) || config.pickSeconds,
        scoringMode,
        weights: {
          ge: Number(ge) || 0,
          visual: Number(visual) || 0,
          music: Number(music) || 0,
        },
        quiz: {
          ...config.quiz,
          enabled: quizEnabled,
          questionCount: Number(questionCount) || config.quiz.questionCount,
        },
        notify: { email: notifyEmail, push: notifyPush },
      };
      await updateLeagueConfig({ data: { leagueId, config: next } });
      setSaved(true);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        className="flex-row items-center justify-between gap-2"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <CardTitle className="cursor-pointer">League settings</CardTitle>
        <span className="text-sm font-medium text-text-secondary">{open ? 'Hide' : 'Edit'}</span>
      </CardHeader>
      {open ? (
      <CardContent className="flex flex-col gap-7">
        <p className="text-sm text-muted-foreground">
          {draftStarted
            ? 'The draft has started, so draft-shape settings are locked. Scoring weights stay editable until finals week.'
            : 'Configure the draft and scoring. Draft-shape settings lock once the draft starts.'}
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s-drafttype">
            <Explain term="draft-type">Draft type</Explain>
          </Label>
          <p className="text-xs text-muted-foreground">
            Snake reverses the pick order each round, so picking last isn't a lasting
            disadvantage. Linear keeps the same order every round.
          </p>
          <Select
            value={draftType}
            onValueChange={(v) => setDraftType(v as LeagueConfig['draftType'])}
            disabled={draftStarted}
          >
            <SelectTrigger size="sm" id="s-drafttype" className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="snake">Snake</SelectItem>
              <SelectItem value="linear">Linear</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s-pick">Pick timer (seconds)</Label>
          <p className="text-xs text-muted-foreground">
            How long each player has on the clock before their pick is auto-made from their
            queue.
          </p>
          <Input
            id="s-pick"
            type="number"
            min={10}
            value={pickSeconds}
            onChange={(e) => setPickSeconds(e.target.value)}
            disabled={draftStarted}
            className="sm:w-56"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s-percaption">Corps per caption</Label>
          <p className="text-xs text-muted-foreground">
            How many corps each player drafts for every caption. Across all{' '}
            {CAPTION_KEYS.length} captions that&apos;s the number of draft rounds.
            {draftStarted ? ' Locked — the draft has started.' : ''}
          </p>
          <Input
            id="s-percaption"
            type="number"
            min={0}
            value={perCaption}
            onChange={(e) => setPerCaption(e.target.value)}
            disabled={draftStarted}
            className="sm:w-56"
          />
          <p className="text-xs text-text-secondary">
            = <span className="font-medium tabular-nums">{totalRounds}</span> draft round
            {totalRounds === 1 ? '' : 's'} per player
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Checkbox
              id="s-quiz"
              checked={quizEnabled}
              onCheckedChange={(v) => setQuizEnabled(!!v)}
              disabled={draftStarted}
            />
            <Label htmlFor="s-quiz">Knowledge quiz sets the draft order</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Players take a short drum corps quiz; higher scores draft earlier. Turn this off to
            set the draft order at random instead.
          </p>
        </div>
        {quizEnabled ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="s-qcount">Quiz questions</Label>
            <p className="text-xs text-muted-foreground">
              How many questions each player answers in their one timed attempt.
            </p>
            <Input
              id="s-qcount"
              type="number"
              min={1}
              value={questionCount}
              onChange={(e) => setQuestionCount(e.target.value)}
              disabled={draftStarted}
              className="sm:w-56"
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s-mode">
            <Explain term="scoring-mode">Scoring mode</Explain>
          </Label>
          <p className="text-xs text-muted-foreground">How a corps earns points each time it competes:</p>
          <ul className="ml-4 flex list-disc flex-col gap-0.5 text-xs text-muted-foreground">
            <li>
              <span className="font-medium text-text-secondary">Recap</span> — each show gives the
              corps one 0&ndash;100 score: the weighted average of its caption scores (using the
              caption weights below). Standings reflect how strong the corps is right now, like a
              recap sheet. Best score wins.
            </li>
            <li>
              <span className="font-medium text-text-secondary">Sum</span> — each show adds the
              corps&apos; caption points to a season-long running total. Competing more often and
              scoring higher grows a bigger pile; the highest total at season&apos;s end wins.
            </li>
          </ul>
          <Select
            value={scoringMode}
            onValueChange={(v) => setScoringMode(v as LeagueConfig['scoringMode'])}
            disabled={draftStarted}
          >
            <SelectTrigger size="sm" id="s-mode" className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recap">Recap (weighted avg ≤ 100)</SelectItem>
              <SelectItem value="sum">Sum (points pile)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Notifications</legend>
          <p className="text-xs text-muted-foreground">
            League-wide defaults for draft alerts, reminders, and standings. Members can still mute
            their own, and email also requires each member's account-wide email opt-in.
          </p>
          <label className="flex items-center gap-2">
            <Checkbox checked={notifyEmail} onCheckedChange={(v) => setNotifyEmail(!!v)} />
            <span className="text-sm">Send email notifications</span>
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={notifyPush} onCheckedChange={(v) => setNotifyPush(!!v)} />
            <span className="text-sm">Send push notifications</span>
          </label>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Caption weights</legend>
          <p className="text-xs text-muted-foreground">
            How much each caption counts toward a corps&apos; score, as percentages. GE + Visual +
            Music must total <span className="font-medium">100%</span>.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="s-ge">GE</Label>
              <Input id="s-ge" type="number" value={ge} onChange={(e) => setGe(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="s-vis">Visual</Label>
              <Input
                id="s-vis"
                type="number"
                value={visual}
                onChange={(e) => setVisual(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="s-mus">Music</Label>
              <Input
                id="s-mus"
                type="number"
                value={music}
                onChange={(e) => setMusic(e.target.value)}
              />
            </div>
          </div>
          <p
            className={`text-xs ${weightsOk ? 'text-muted-foreground' : 'font-medium text-destructive'}`}
          >
            Total: {Math.round(weightTotal)}%{weightsOk ? '' : ' — must equal 100%'}
          </p>
        </fieldset>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-3">
          <BusyButton
            size="sm"
            busy={busy}
            disabled={!weightsOk}
            onClick={() => {
              setSaved(false);
              void save();
            }}
          >
            Save settings
          </BusyButton>
          {saved ? <span className="text-sm text-muted-foreground">Saved.</span> : null}
        </div>
      </CardContent>
      ) : null}
    </Card>
  );
}
