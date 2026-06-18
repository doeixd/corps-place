import { createContext, useContext, type ReactNode } from 'react';
import { corpsLogoSource, type LogoSource } from '@/components/corps-logo';

/**
 * A page-scoped registry of corps records, so leaf components (e.g. a
 * `CorpsNameCell` deep in a recap table) can resolve a corps's logo source from
 * just a key/name — instead of every list threading the resolved source down
 * through its lookup objects and prop chains.
 *
 * Resolution mirrors the recap lookups: by `corps_key` first, then by a
 * normalized name. The directory is already loaded by the pages that render
 * corps logos, so the provider just wraps that data.
 */
type CorpsLike = {
  corps_key?: string | null;
  name?: string | null;
  corps_logo?: string | null;
  corps_logo_dark?: number | null;
  corps_logo_dark_url?: string | null;
};

type Resolver = (args: { corpsKey?: string | null; name?: string | null }) => CorpsLike | undefined;

const CorpsRegistryContext = createContext<Resolver>(() => undefined);

const normalizeName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function CorpsRegistryProvider({
  corps,
  children,
}: {
  corps: readonly CorpsLike[];
  children: ReactNode;
}) {
  const byKey = new Map<string, CorpsLike>();
  const byName = new Map<string, CorpsLike>();
  for (const c of corps) {
    if (c.corps_key) byKey.set(c.corps_key, c);
    if (c.name) byName.set(normalizeName(c.name), c);
  }
  const resolve: Resolver = ({ corpsKey, name }) =>
    (corpsKey ? byKey.get(corpsKey) : undefined) ??
    (name ? byName.get(normalizeName(name)) : undefined);

  return <CorpsRegistryContext.Provider value={resolve}>{children}</CorpsRegistryContext.Provider>;
}

/**
 * Resolve a corps's logo source. Pass `override` (a `LogoSource`) to supply it
 * directly — used when the caller already holds the URL (e.g. judge pages) and
 * isn't inside a registry. When `override` is omitted, the corps is looked up in
 * the surrounding {@link CorpsRegistryProvider} by `corpsKey`/`name`.
 */
export function useCorpsLogoSource(args: {
  corpsKey?: string | null;
  name?: string | null;
  override?: LogoSource;
}): LogoSource {
  const resolve = useContext(CorpsRegistryContext);
  if (args.override !== undefined) return args.override;
  const corps = resolve({ corpsKey: args.corpsKey, name: args.name });
  return corps ? corpsLogoSource(corps) : null;
}
