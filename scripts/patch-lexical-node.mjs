#!/usr/bin/env node
// Nitro resolves ESM packages under the 'node' condition at build time but only
// copies the 'production' (.prod.mjs) variants into .output/server/node_modules.
// The SSR runtime imports the missing .node.mjs files — copy prod→node to fix.
import { existsSync, copyFileSync } from 'node:fs';
import { globSync } from 'node:fs';

const DIR = '.output/server/node_modules';
if (existsSync(DIR)) {
  let count = 0;
  for (const prod of globSync(`${DIR}/**/*.prod.mjs`, { nodir: true })) {
    const node = prod.replace('.prod.mjs', '.node.mjs');
    if (!existsSync(node)) {
      copyFileSync(prod, node);
      count++;
    }
  }
  if (count > 0) console.log(`[patch-node-exports] created ${count} .node.mjs files`);
}
