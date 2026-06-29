// Programmatic-SEO landing pages for PageantryJobs (see sdk/docs/pageantryjobs-pseo-plan.md).
// One /jobs/c/$slug route is driven by this generated-at-module-load taxonomy:
// discipline pages, discipline×role pages, instrument×role pages, and cross-discipline
// role hubs. Content is built from small config maps so adding a discipline/role is a
// one-line change. Pages with no matching jobs are noindex'd by the route (anti-thin).

import { DISCIPLINE_LABEL } from './disciplines';

export type LandingFilter = { discipline?: string; keyword?: string; work?: 'remote' | 'onsite' };

export interface LandingDef {
  slug: string;
  kind: 'discipline' | 'role' | 'discipline-role' | 'instrument-role';
  title: string; // <title>
  h1: string;
  subhead: string;
  metaDescription: string;
  intro: string;
  faq: { q: string; a: string }[];
  filter: LandingFilter;
  aliases: string[];
  parentSlug?: string;
  related: string[];
}

// ── roles ────────────────────────────────────────────────────────────────────
// noun = display ("Coach"); kw = title keyword used by listJobs `keyword` (title LIKE);
// blurb = what the role does (drives a unique intro); aliasNouns = plural / variant terms.
interface Role {
  noun: string;
  kw: string;
  blurb: string;
  aliasNouns: string[];
}

const ROLES = {
  instructor: {
    noun: 'Instructor',
    kw: 'instructor',
    blurb: 'teaches technique and leads sectional or ensemble rehearsals',
    aliasNouns: ['Instructors', 'Teachers'],
  },
  technician: {
    noun: 'Technician',
    kw: 'tech',
    blurb: 'refines a specific caption or skill area with hands-on, detailed coaching',
    aliasNouns: ['Techs', 'Technicians'],
  },
  coach: {
    noun: 'Coach',
    kw: 'coach',
    blurb: "develops competitors' technique, conditioning, and competition performance",
    aliasNouns: ['Coaches', 'Coaching jobs'],
  },
  director: {
    noun: 'Director',
    kw: 'director',
    blurb: 'leads the program — vision, staff, and season planning',
    aliasNouns: ['Directors'],
  },
  designer: {
    noun: 'Designer',
    kw: 'designer',
    blurb: 'creates the visual, music, or program design for the production',
    aliasNouns: ['Designers'],
  },
  arranger: {
    noun: 'Arranger',
    kw: 'arranger',
    blurb: 'writes and arranges the musical book for the ensemble',
    aliasNouns: ['Arrangers', 'Composers'],
  },
  'caption-head': {
    noun: 'Caption Head',
    kw: 'caption',
    blurb: 'leads a caption staff and owns the results in their area',
    aliasNouns: ['Caption Heads', 'Caption Supervisors'],
  },
  judge: {
    noun: 'Judge',
    kw: 'judge',
    blurb: 'adjudicates competition, scoring performances against the rubric',
    aliasNouns: ['Judges', 'Adjudicators'],
  },
  choreographer: {
    noun: 'Choreographer',
    kw: 'choreograph',
    blurb: 'designs and teaches movement and choreography',
    aliasNouns: ['Choreographers'],
  },
  teacher: {
    noun: 'Teacher',
    kw: 'teacher',
    blurb: 'gives lessons and instruction to students of all levels',
    aliasNouns: ['Teachers', 'Lessons', 'Tutors'],
  },
  trainer: {
    noun: 'Trainer',
    kw: 'trainer',
    blurb: 'guides training, conditioning, and competition preparation',
    aliasNouns: ['Trainers'],
  },
  'posing-coach': {
    noun: 'Posing Coach',
    kw: 'posing',
    blurb: 'perfects stage presentation, posing, and routines for competition',
    aliasNouns: ['Posing Coaches'],
  },
  'prep-coach': {
    noun: 'Prep Coach',
    kw: 'prep',
    blurb: 'manages contest prep — nutrition, peaking, and stage readiness',
    aliasNouns: ['Prep Coaches', 'Contest Prep'],
  },
  scout: { noun: 'Scout', kw: 'scout', blurb: 'finds and signs new talent', aliasNouns: ['Scouts'] },
  photographer: {
    noun: 'Photographer',
    kw: 'photograph',
    blurb: 'shoots competition, portfolio, and promotional imagery',
    aliasNouns: ['Photographers'],
  },
  handler: {
    noun: 'Handler',
    kw: 'handler',
    blurb: 'presents and shows the animal in the ring',
    aliasNouns: ['Handlers'],
  },
  groomer: {
    noun: 'Groomer',
    kw: 'groom',
    blurb: 'grooms and conditions for show presentation',
    aliasNouns: ['Groomers'],
  },
  'stage-manager': {
    noun: 'Stage Manager',
    kw: 'stage manager',
    blurb: 'runs the show backstage — cues, crew, and call',
    aliasNouns: ['Stage Managers'],
  },
} satisfies Record<string, Role>;
type RoleKey = keyof typeof ROLES;

// ── per-discipline role lists ─────────────────────────────────────────────────
const MARCHING_ROLES: RoleKey[] = [
  'instructor',
  'technician',
  'coach',
  'director',
  'designer',
  'arranger',
  'caption-head',
  'judge',
  'choreographer',
];

const ROLE_MAP: Record<string, RoleKey[]> = {
  'drum-corps': MARCHING_ROLES,
  'marching-band': MARCHING_ROLES,
  'winter-guard': ['instructor', 'coach', 'director', 'designer', 'choreographer', 'judge'],
  'color-guard': ['instructor', 'coach', 'director', 'designer', 'choreographer', 'judge'],
  'indoor-percussion': MARCHING_ROLES,
  drumline: ['instructor', 'technician', 'arranger', 'caption-head'],
  concert: ['director', 'instructor', 'arranger'],
  'baton-twirling': ['instructor', 'coach', 'choreographer', 'judge'],
  music: ['instructor', 'teacher', 'director'],
  pageants: ['coach', 'director', 'judge', 'choreographer'],
  modeling: ['coach', 'scout', 'photographer'],
  dance: ['instructor', 'choreographer', 'teacher', 'coach', 'judge'],
  cheer: ['coach', 'choreographer', 'judge'],
  gymnastics: ['coach', 'instructor', 'judge'],
  'figure-skating': ['coach', 'choreographer', 'instructor'],
  bodybuilding: ['coach', 'posing-coach', 'prep-coach', 'trainer', 'judge'],
  fitness: ['coach', 'trainer', 'judge'],
  equestrian: ['trainer', 'instructor', 'coach', 'judge'],
  'dog-showing': ['handler', 'trainer', 'groomer', 'judge'],
  theater: ['director', 'choreographer', 'designer', 'stage-manager'],
  circus: ['coach', 'instructor'],
  production: ['stage-manager'],
};

// ── instruments (× instructor/teacher) ────────────────────────────────────────
const INSTRUMENTS = [
  'trumpet',
  'cornet',
  'mellophone',
  'french-horn',
  'trombone',
  'baritone',
  'euphonium',
  'tuba',
  'sousaphone',
  'clarinet',
  'flute',
  'saxophone',
  'percussion',
  'marimba',
  'drum-set',
  'guitar',
  'bass',
  'piano',
  'voice',
] as const;

// Cross-discipline role hubs (no discipline filter — keyword only).
const CROSS_ROLES: RoleKey[] = ['instructor', 'coach', 'director', 'judge', 'choreographer', 'designer'];

// ── helpers ───────────────────────────────────────────────────────────────────
const dLabel = (d: string) => DISCIPLINE_LABEL[d] ?? d;
// Clean primary term for titles/H1 — strips compound suffixes so "Bodybuilding &
// physique" → "Bodybuilding", "Equestrian / horse showing" → "Equestrian".
const shortLabel = (label: string) => label.split(/\s*[&/(]/)[0].trim();
// The secondary term(s) of a compound label, as extra alias keywords
// ("horse showing", "physique", "wind ensemble").
const labelExtras = (label: string) =>
  label
    .split(/\s*[&/(]\s*/)
    .slice(1)
    .map((s) => s.replace(/[)]/g, '').trim())
    .filter(Boolean);
const titleCase = (s: string) =>
  s
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
const lc = (s: string) => s.toLowerCase();

function discIntro(label: string): string {
  return (
    `Browse current ${lc(label)} jobs on PageantryJobs — the dedicated job board for ` +
    `the pageantry and performing-arts world. Programs, studios, gyms, and organizations ` +
    `post ${lc(label)} openings here as they hire. Filter by location or remote, save ` +
    `searches, and apply directly.`
  );
}
function roleIntro(label: string, role: Role): string {
  return (
    `Find ${lc(label)} ${lc(role.noun)} jobs on PageantryJobs. A ${lc(role.noun)} ${role.blurb}. ` +
    `New ${lc(label)} ${lc(role.noun.toLowerCase())} roles are posted by programs and ` +
    `organizations across the country — browse openings below, save the search, and apply ` +
    `directly, or get notified when a new one is posted.`
  );
}
function commonFaq(thing: string): { q: string; a: string }[] {
  return [
    {
      q: `Where can I find ${thing} jobs?`,
      a: `PageantryJobs lists ${thing} jobs posted directly by programs and organizations. New roles are added as employers hire — save this search to get notified.`,
    },
    {
      q: `How do I apply for a ${thing} job?`,
      a: `Open any posting below and apply on PageantryJobs. Some roles also link to the employer's own application.`,
    },
  ];
}

// ── builders ──────────────────────────────────────────────────────────────────
function disciplinePage(d: string): LandingDef {
  const label = shortLabel(dLabel(d)); // clean primary term for SEO ("Bodybuilding")
  const extras = labelExtras(dLabel(d)); // compound terms → extra keywords
  const roles = ROLE_MAP[d] ?? [];
  return {
    slug: d,
    kind: 'discipline',
    title: `${label} Jobs | PageantryJobs`,
    h1: `${label} Jobs`,
    subhead: `Find ${lc(label)} jobs, instructors, coaches, and staff roles.`,
    metaDescription: `Browse ${lc(label)} jobs on PageantryJobs — instructor, coach, director, and staff openings posted by programs and organizations. Apply directly.`,
    intro: discIntro(label),
    faq: commonFaq(`${lc(label)}`),
    filter: { discipline: d },
    aliases: [
      `${label} Careers`,
      `${label} Staff Jobs`,
      `${label} Positions`,
      ...extras.map((e) => `${titleCase(e.replace(/ /g, '-'))} Jobs`),
    ],
    related: roles.map((r) => `${d}-${r}`),
  };
}

function disciplineRolePage(d: string, roleKey: RoleKey): LandingDef {
  const label = shortLabel(dLabel(d));
  const role = ROLES[roleKey];
  const phrase = `${label} ${role.noun}`;
  return {
    slug: `${d}-${roleKey}`,
    kind: 'discipline-role',
    title: `${phrase} Jobs | PageantryJobs`,
    h1: `${phrase} Jobs`,
    subhead: `Find ${lc(phrase)} jobs — ${role.aliasNouns.map(lc).join(', ')}.`,
    metaDescription: `${phrase} jobs on PageantryJobs. A ${lc(role.noun)} ${role.blurb}. Browse openings and apply directly.`,
    intro: roleIntro(label, role),
    faq: commonFaq(`${lc(phrase)}`),
    filter: { discipline: d, keyword: role.kw },
    aliases: role.aliasNouns.map((a) => `${label} ${a}`),
    parentSlug: d,
    related: [d, ...(ROLE_MAP[d] ?? []).filter((r) => r !== roleKey).map((r) => `${d}-${r}`)].slice(0, 8),
  };
}

function instrumentPage(instrument: string): LandingDef {
  const label = titleCase(instrument);
  const role = ROLES.instructor;
  return {
    slug: `${instrument}-instructor`,
    kind: 'instrument-role',
    title: `${label} Instructor Jobs | PageantryJobs`,
    h1: `${label} Instructor Jobs`,
    subhead: `Find ${lc(label)} instructor and ${lc(label)} teacher jobs.`,
    metaDescription: `${label} instructor & teacher jobs on PageantryJobs. ${label} instructors teach technique and lead lessons — browse openings and apply directly.`,
    intro:
      `Find ${lc(label)} instructor and ${lc(label)} teacher jobs on PageantryJobs. ${label} ` +
      `instructors ${role.blurb} — from private lessons to ensemble and marching programs. ` +
      `Browse openings below, save the search, or get notified when a new ${lc(label)} teaching role is posted.`,
    faq: commonFaq(`${lc(label)} instructor`),
    filter: { keyword: instrument.replace('-', ' ') },
    aliases: [`${label} Teachers`, `${label} Lessons`, `${label} Teaching Jobs`, `${label} Tutor`],
    related: ['music-instructor', 'music-teacher'],
  };
}

function crossRolePage(roleKey: RoleKey): LandingDef {
  const role = ROLES[roleKey];
  return {
    slug: roleKey,
    kind: 'role',
    title: `${role.noun} Jobs in the Performing Arts | PageantryJobs`,
    h1: `${role.noun} Jobs`,
    subhead: `${role.aliasNouns.join(', ')} across drum corps, marching band, dance, pageants, and more.`,
    metaDescription: `${role.noun} jobs across the pageantry & performing-arts world on PageantryJobs. A ${lc(role.noun)} ${role.blurb}. Browse openings and apply directly.`,
    intro:
      `Find ${lc(role.noun)} jobs across the pageantry and performing-arts world — drum corps, ` +
      `marching band, color guard, dance, pageants, fitness, and more. A ${lc(role.noun)} ${role.blurb}. ` +
      `Browse openings below or filter by discipline.`,
    faq: commonFaq(`${lc(role.noun)}`),
    filter: { keyword: role.kw },
    aliases: role.aliasNouns,
    related: Object.keys(ROLE_MAP)
      .filter((d) => (ROLE_MAP[d] ?? []).includes(roleKey))
      .slice(0, 8)
      .map((d) => `${d}-${roleKey}`),
  };
}

// ── assemble ──────────────────────────────────────────────────────────────────
function buildDefs(): LandingDef[] {
  const defs: LandingDef[] = [];
  for (const d of Object.keys(ROLE_MAP)) {
    defs.push(disciplinePage(d));
    for (const r of ROLE_MAP[d]!) defs.push(disciplineRolePage(d, r));
  }
  for (const inst of INSTRUMENTS) defs.push(instrumentPage(inst));
  for (const r of CROSS_ROLES) defs.push(crossRolePage(r));
  // de-dup by slug (cross-role 'coach' etc. could collide with a discipline named the same — they don't, but be safe)
  const seen = new Set<string>();
  return defs.filter((d) => (seen.has(d.slug) ? false : (seen.add(d.slug), true)));
}

export const LANDING_DEFS: LandingDef[] = buildDefs();
export const LANDING_BY_SLUG: Record<string, LandingDef> = Object.fromEntries(
  LANDING_DEFS.map((d) => [d.slug, d])
);

/** Defs grouped by discipline for the hub/nav. */
export const LANDING_DISCIPLINES = Object.keys(ROLE_MAP).map((d) => ({
  discipline: d,
  label: dLabel(d),
  pageSlug: d,
  roleSlugs: (ROLE_MAP[d] ?? []).map((r) => `${d}-${r}`),
}));
