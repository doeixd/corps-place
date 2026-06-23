import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The "what is this / how it works" explainer (UI/UX plan §3.1, UX audit P0). The
 * top of the funnel (landing, join) assumed players already knew what fantasy drum
 * corps is; this teaches the concept + the 5-step flow in one card.
 */
const STEPS = [
  { n: 1, title: 'Create or join', desc: 'Start a private league, or accept a friend’s invite.' },
  { n: 2, title: 'Name your corps', desc: 'Pick your team’s name, color, and logo.' },
  { n: 3, title: 'Take the quiz', desc: 'A quick DCI quiz sets your draft order.' },
  { n: 4, title: 'Draft', desc: 'Take turns drafting real corps for each judged caption.' },
  { n: 5, title: 'Score', desc: 'Earn points from real DCI recaps and climb the standings.' },
];

export function HowItWorks({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>How Fantasy DCI works</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Draft real drum corps with your friends, then earn points from how those corps actually
          score at DCI competitions. The highest total at the end of the season wins your league.
        </p>
        <ol className="grid gap-3 sm:grid-cols-5">
          {STEPS.map((s) => (
            <li key={s.n} className="flex flex-col gap-1">
              <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {s.n}
              </span>
              <span className="text-sm font-medium">{s.title}</span>
              <span className="text-xs text-muted-foreground">{s.desc}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
