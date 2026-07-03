import { createServerFn } from '@tanstack/react-start';

/**
 * Returns the AI-generated intro for a pSEO landing page slug, or null. The
 * generated intros (landing-intros.generated.json, ~260 entries) are imported
 * ONLY inside this server handler via dynamic import, so they never ship in the
 * client bundle — the route loader overrides def.intro with the result server-side.
 */
export const getLandingIntro = createServerFn({ method: 'GET' })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const mod = await import('@/lib/jobs/landing-intros.generated.json');
    const intros = ((mod as { default?: Record<string, string> }).default ?? mod) as Record<
      string,
      string
    >;
    return intros[data.slug] ?? null;
  });
