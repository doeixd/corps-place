const normalizeNameKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

// Curated legacy corps names we want discovery to keep chasing even if they no
// longer appear in the active lineup or current `/corps/` roster cache.
// Keep this list intentionally small and explicit so it can be reviewed and
// expanded over time without turning discovery back into a noise sink.
export const LEGACY_CORPS_NAMES = [
  'Glassmen',
  'The Cadets',
  'Oregon Crusaders',
  'Cadets 2',
  'Pioneer',
  'Jubal',
  'The Company',
  'Incognito',
  'Encorps',
  'Eruption',
  'City Sound',
  'Shadow',
  'Racine Scouts',
  'Thunder',
  'Bushwackers Drum Corps',
  'Bushwackers',
  'Connecticut Hurricanes',
  'Hurricanes',
  'North Star',
  'Sky Ryders',
  'Sacramento Freelancers Drum & Bugle Corps',
  'Sacramento Freelancers Alumni Corps',
  'Freelancers Alumni Corps',
  'Crusaders Senior Drum & Bugle Corps',
  'Railmen Drum and Bugle Corps',
  'Lone Star Drum and Bugle Corps',
  'U.S. Marine Drum & Bugle Corps',
  'Bluecoats Alumni Corps',
  'Bluecoats Alumni Ensemble Legacy Arc',
  'Buccaneer Alumni Corps',
  'Buccaneers Alumni',
  'Colts Alumni Corps',
  'Crossmen Alumni Corps',
  'Hawthorne Caballeros Alumni',
  'Hamburg Kingsmen Alumni',
  'Skyliners Alumni',
  'Spirit of Atlanta Alumni Corps',
  'Troopers Legacy Corps',
  'RCR Alumni Corps',
  'Valley Thunder',
  'Mon Valley Express Drum and Bugle Corps',
  'Northern Lights Drum & Bugle Corps',
  'White Sabers Mini Corps',
  'North Coast Brass',
] as const;

const LEGACY_CORPS_NAME_KEYS = new Set(LEGACY_CORPS_NAMES.map(normalizeNameKey));

export const isLegacyCorpsName = (value: string) => LEGACY_CORPS_NAME_KEYS.has(normalizeNameKey(value));
