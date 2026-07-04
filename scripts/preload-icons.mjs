#!/usr/bin/env node
/**
 * Generates standalone icon components (`app/components/icons/generated/`) from
 * the Hugeicons set — no unplugin-icons runtime overhead.
 *
 * Self-syncing: scans `app/` for icons imported from
 * `@/components/icons/generated`, resolves each `<Name>Icon` back to its
 * Hugeicons kebab name (validated against the set), then (re)writes exactly that
 * set + the barrel and prunes anything no longer referenced. Run it after adding
 * or removing an icon import: `npm run gen:icons`.
 *
 * Usage: node scripts/preload-icons.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'app/components/icons/generated');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Scan for all icon imports in the codebase
const scanDir = (dir, files = []) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.output' ||
        entry.name === 'dist' ||
        entry.name === 'generated'
      )
        continue;
      scanDir(fullPath, files);
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
};

// Load Hugeicons icon data (needed to validate resolved names below).
const hugeiconsPath = path.join(rootDir, 'node_modules/@iconify-json/hugeicons/icons.json');
if (!fs.existsSync(hugeiconsPath)) {
  // Tolerant: the generated icons are committed, so a missing dev-only dep
  // (e.g. on a lean CI) must not block `predev`/`prebuild`. Warn and skip.
  console.warn('Skipping icon gen: @iconify-json/hugeicons not installed.');
  process.exit(0);
}
const hugeicons = JSON.parse(fs.readFileSync(hugeiconsPath, 'utf-8'));

// Resolve a generated `<Name>Icon` identifier back to its Hugeicons kebab name.
// Pascal→kebab is ambiguous around digits (`ArrowLeft02` could be
// `arrow-left-02` or `arrow-left02`), so try candidates and pick whichever
// actually exists in the Hugeicons set.
const resolveIconName = (identifier) => {
  const base = identifier.replace(/Icon$/, '');
  return [
    base.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2'),
    base.replace(/([a-z])([A-Z])/g, '$1-$2'),
    base.replace(/([a-zA-Z])(\d)/g, '$1-$2'),
    base,
  ]
    .map((s) => s.toLowerCase())
    .find((c) => hugeicons.icons[c]);
};

// Scan for icons actually imported from the generated barrel (handles `as`
// aliases and multi-line import blocks).
console.log('Scanning for generated-icon imports...');
const files = scanDir(path.join(rootDir, 'app'));
const iconImports = new Set();
const unresolved = new Set();
const importRe =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@\/components\/icons\/generated['"]/g;
for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');
  for (const m of content.matchAll(importRe)) {
    for (const raw of m[1].split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (!name.endsWith('Icon')) continue;
      const kebab = resolveIconName(name);
      if (kebab) iconImports.add(kebab);
      else unresolved.add(name);
    }
  }
}
if (unresolved.size > 0) {
  console.warn(`Warning: could not resolve to Hugeicons: ${[...unresolved].sort().join(', ')}`);
}

const icons = Array.from(iconImports).sort();
console.log(`Found ${icons.length} referenced icons`);
if (icons.length === 0) {
  console.log('No icons found. Exiting.');
  process.exit(0);
}

// Convert kebab-case SVG attribute names to React's camelCase, leaving values,
// data-*, and aria-* untouched. Matches an attribute name (letters + hyphens)
// immediately followed by `=`.
const toReactAttrs = (svg) =>
  svg.replace(/(\s)([a-z][a-z-]*[a-z])=/gi, (match, ws, name) => {
    if (!name.includes('-') || /^(data|aria)-/i.test(name)) return match;
    const camel = name.replace(/-([a-z])/gi, (_, c) => c.toUpperCase());
    return `${ws}${camel}=`;
  });

// Generate icon components
const kebabToPascal = (str) =>
  str
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

const generateComponent = (iconName) => {
  const iconData = hugeicons.icons[iconName];
  if (!iconData) {
    console.warn(`Warning: Icon "${iconName}" not found in Hugeicons`);
    return null;
  }

  const componentName = kebabToPascal(iconName) + 'Icon';
  // Iconify bodies use kebab-case SVG attributes (stroke-linecap, fill-rule, …),
  // which React/JSX rejects ("Invalid DOM property"). Camel-case attribute names
  // (skip data-/aria-, which stay kebab in React).
  const svgContent = toReactAttrs(iconData.body);

  // Extract viewBox from icon data
  const viewBox = iconData.width
    ? `0 0 ${iconData.width} ${iconData.height || iconData.width}`
    : '0 0 24 24';

  // The icon body lives ONCE in the document as a <symbol> (sprite.tsx, mounted
  // in __root); each render is a tiny <use> reference. This deduplicates the
  // path data across repeated cards (e.g. /corps shipped ~200KB of identical
  // inline SVGs). Deterministic on server and client — hydration-safe.
  return `import type { SVGProps } from 'react';

export const ${componentName} = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
  const size = props.size === 'sm' ? 16 : props.size === 'lg' ? 24 : 20;
  const { size: _size, ...svgProps } = props;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="${viewBox}"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...svgProps}
    >
      <use href="#hi-${iconName}" />
    </svg>
  );
};
`;
};

// The sprite: every referenced icon's body as a <symbol>, rendered once in the
// root layout. Hidden via zero-size (NOT display:none — some engines won't
// resolve <use> targets from display:none subtrees).
const generateSprite = (iconNames) => {
  const symbols = iconNames
    .map((iconName) => {
      const iconData = hugeicons.icons[iconName];
      if (!iconData) return null;
      const viewBox = iconData.width
        ? `0 0 ${iconData.width} ${iconData.height || iconData.width}`
        : '0 0 24 24';
      return `      <symbol id="hi-${iconName}" viewBox="${viewBox}">${toReactAttrs(iconData.body)}</symbol>`;
    })
    .filter(Boolean)
    .join('\n');
  return `// Auto-generated by scripts/preload-icons.mjs — the shared icon sprite.
// Mounted once in __root; icon components render <use href="#hi-…"> against it.

export const IconSprite = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
    style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
  >
    <defs>
${symbols}
    </defs>
  </svg>
);
`;
};

console.log('Generating icon components...');
let generated = 0;
const exports = [];
const keepFiles = new Set(['index.ts', 'sprite.tsx']);

for (const iconName of icons) {
  const component = generateComponent(iconName);
  if (component) {
    const componentName = kebabToPascal(iconName) + 'Icon';
    const fileName = `${iconName}.tsx`;
    fs.writeFileSync(path.join(outputDir, fileName), component);
    keepFiles.add(fileName);
    exports.push(`export { ${componentName} } from './${iconName}';`);
    generated++;
  }
}

// Prune generated files no longer referenced, so the barrel stays in sync.
let pruned = 0;
for (const existing of fs.readdirSync(outputDir)) {
  if (!keepFiles.has(existing)) {
    fs.rmSync(path.join(outputDir, existing));
    pruned++;
  }
}

fs.writeFileSync(path.join(outputDir, 'sprite.tsx'), generateSprite(icons));

// Generate index file
const indexContent = `// Auto-generated by scripts/preload-icons.mjs
// Do not edit manually - run 'node scripts/preload-icons.mjs' to regenerate

export { IconSprite } from './sprite';
${exports.join('\n')}
`;

fs.writeFileSync(path.join(outputDir, 'index.ts'), indexContent);

console.log(
  `Generated ${generated} icon component(s)${pruned ? `, pruned ${pruned} stale` : ''} in app/components/icons/generated/`
);
