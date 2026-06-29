// Satori OG card templates (1200×630). These return plain JSX element trees that
// Satori consumes directly (not React-rendered), so every multi-child box sets an
// explicit display:flex per Satori's layout rules.
import type { ReactNode } from 'react';
import { faviconPngDataUri } from './favicon.generated';

const BG = '#0a0e1a';
const GOLD = '#f5c518';
const SILVER = '#cbd5e1';
const BRONZE = '#cd7f32';
const TEXT = '#f8fafc';
const MUTED = '#94a3b8';

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '1200px',
        height: '630px',
        backgroundColor: BG,
        padding: '64px 72px',
        fontFamily: 'Inter',
        justifyContent: 'space-between',
        backgroundImage: `radial-gradient(circle at 85% 15%, rgba(245,197,24,0.14), transparent 45%)`,
      }}
    >
      {children}
    </div>
  );
}

function Eyebrow({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', color: GOLD, fontSize: 26, fontWeight: 700, letterSpacing: 4 }}>
      {text}
    </div>
  );
}

function Footer() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', color: MUTED, fontSize: 26, fontWeight: 700 }}>
      drumcorps.app
    </div>
  );
}

const medalColor = (i: number) => (i === 0 ? GOLD : i === 1 ? SILVER : BRONZE);

/** Default site card: favicon + DrumCorps.app + a one-line explainer. */
export function HomeCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div
      style={{
        display: 'flex',
        width: '1200px',
        height: '630px',
        backgroundColor: BG,
        fontFamily: 'Inter',
        alignItems: 'center',
        padding: '0 96px',
        // Warm wash in the site's primary orange (#fd5007 — the favicon hue).
        backgroundImage: 'radial-gradient(circle at 18% 28%, rgba(253,80,7,0.22), transparent 55%)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 56 }}>
        <img src={faviconPngDataUri} width={224} height={224} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 660 }}>
          <div style={{ display: 'flex', color: TEXT, fontSize: 92, fontWeight: 700 }}>{title}</div>
          <div style={{ display: 'flex', color: MUTED, fontSize: 36, lineHeight: 1.3 }}>{subtitle}</div>
        </div>
      </div>
    </div>
  );
}

/** Scored-event card: title + date/place + gold/silver/bronze podium. */
export function ScoreCard({
  title,
  sub,
  podium,
}: {
  title: string;
  sub: string;
  podium: { corps: string; score: string }[];
}) {
  return (
    <Frame>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Eyebrow text="DRUM CORPS SCORES" />
        <div style={{ display: 'flex', color: TEXT, fontSize: 62, fontWeight: 700, lineHeight: 1.05 }}>
          {title}
        </div>
        {sub ? <div style={{ display: 'flex', color: MUTED, fontSize: 28 }}>{sub}</div> : <div />}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {podium.map((p, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            <div
              style={{
                display: 'flex',
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: medalColor(i),
                color: '#0a0e1a',
                fontSize: 26,
                fontWeight: 700,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {i + 1}
            </div>
            <div style={{ display: 'flex', flex: 1, color: TEXT, fontSize: 38, fontWeight: 700 }}>
              {p.corps}
            </div>
            <div style={{ display: 'flex', color: TEXT, fontSize: 38, fontWeight: 700 }}>{p.score}</div>
          </div>
        ))}
      </div>
      <Footer />
    </Frame>
  );
}

/** Per-season archive card. */
export function SeasonCard({ season, count }: { season: string; count: number }) {
  return (
    <Frame>
      <Eyebrow text="DRUM CORPS SCORES" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', color: TEXT, fontSize: 110, fontWeight: 700 }}>
          {season} Scores
        </div>
        <div style={{ display: 'flex', color: MUTED, fontSize: 34 }}>
          {count > 0 ? `${count} shows · final scores & full recaps` : 'Final scores & full recaps'}
        </div>
      </div>
      <Footer />
    </Frame>
  );
}

/** Per-corps show/program card. */
export function ShowCard({
  corps,
  season,
  title,
  sub,
}: {
  corps: string;
  season: string;
  title: string;
  sub?: string;
}) {
  return (
    <Frame>
      <Eyebrow text={`DRUM CORPS SHOW · ${season}`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', color: GOLD, fontSize: 38, fontWeight: 700 }}>{corps}</div>
        <div style={{ display: 'flex', color: TEXT, fontSize: 84, fontWeight: 700, lineHeight: 1.05 }}>
          {title}
        </div>
        {sub ? <div style={{ display: 'flex', color: MUTED, fontSize: 30 }}>{sub}</div> : <div />}
      </div>
      <Footer />
    </Frame>
  );
}
