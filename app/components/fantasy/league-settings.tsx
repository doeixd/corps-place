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
  const [quizEnabled, setQuizEnabled] = useState(config.quiz.enabled);
  const [questionCount, setQuestionCount] = useState(String(config.quiz.questionCount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next: LeagueConfig = {
        ...config,
        draftType,
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
      <CardHeader>
        <CardTitle>League settings</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {draftStarted
            ? 'The draft has started, so draft-shape settings are locked. Scoring weights stay editable until finals week.'
            : 'Configure the draft and scoring. Draft-shape settings lock once the draft starts.'}
        </p>

        <div className="grid grid-cols-2 items-center gap-3">
          <Label htmlFor="s-drafttype">Draft type</Label>
          <Select
            value={draftType}
            onValueChange={(v) => setDraftType(v as LeagueConfig['draftType'])}
            disabled={draftStarted}
          >
            <SelectTrigger size="sm" id="s-drafttype">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="snake">Snake</SelectItem>
              <SelectItem value="linear">Linear</SelectItem>
            </SelectContent>
          </Select>

          <Label htmlFor="s-pick">Pick timer (seconds)</Label>
          <Input
            id="s-pick"
            type="number"
            min={10}
            value={pickSeconds}
            onChange={(e) => setPickSeconds(e.target.value)}
            disabled={draftStarted}
          />
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="s-quiz"
            checked={quizEnabled}
            onCheckedChange={(v) => setQuizEnabled(!!v)}
            disabled={draftStarted}
          />
          <Label htmlFor="s-quiz">Knowledge quiz sets the draft order</Label>
        </div>
        {quizEnabled ? (
          <div className="grid grid-cols-2 items-center gap-3">
            <Label htmlFor="s-qcount">Quiz questions</Label>
            <Input
              id="s-qcount"
              type="number"
              min={1}
              value={questionCount}
              onChange={(e) => setQuestionCount(e.target.value)}
              disabled={draftStarted}
            />
          </div>
        ) : null}

        <div className="grid grid-cols-2 items-center gap-3">
          <Label htmlFor="s-mode">Scoring mode</Label>
          <Select
            value={scoringMode}
            onValueChange={(v) => setScoringMode(v as LeagueConfig['scoringMode'])}
            disabled={draftStarted}
          >
            <SelectTrigger size="sm" id="s-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recap">Recap (weighted avg ≤ 100)</SelectItem>
              <SelectItem value="sum">Sum (points pile)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Caption weights</legend>
          <p className="text-xs text-muted-foreground">
            GE / Visual / Music — normalized to 100 when saved.
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
        </fieldset>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-3">
          <BusyButton
            size="sm"
            busy={busy}
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
    </Card>
  );
}
