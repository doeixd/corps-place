import { useNow } from '@/lib/use-now';

/** A live mm:ss countdown to `endsAt`, driven by the shared clock (no effects). */
export function Countdown({ endsAt }: { endsAt: string }) {
  const secs = Math.max(0, Math.floor((new Date(endsAt).getTime() - useNow()) / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return (
    <span className={secs < 30 ? 'font-mono text-destructive' : 'font-mono text-muted-foreground'}>
      {mm}:{ss}
    </span>
  );
}
