import * as path from 'node:path';

/**
 * SDK child-process runtime helpers.
 *
 * The SDK (`sdk/`) runs TensorFlow.js training/inference via `@tensorflow/tfjs-node`,
 * whose native bindings require Node 20.x. The web server, however, should serve
 * traffic on a current LTS (Node 22/24) rather than an EOL runtime.
 *
 * The two are already decoupled at the OS-process level: the server never imports
 * tfjs-node — it reaches the model exclusively by spawning `npx tsx scripts/...`
 * in `sdk/`. To let the server run a modern Node while the SDK child runs Node 20,
 * set `SDK_NODE_BIN_DIR` to the directory containing the Node 20 `node`/`npx`
 * binaries. We prepend it to the child's `PATH` so `npx`/`tsx`/`node` resolve to
 * Node 20 for SDK workloads only, leaving the parent runtime untouched.
 *
 * When `SDK_NODE_BIN_DIR` is unset (e.g. local dev already pinned to Node 20 via
 * Volta), the child inherits the parent env unchanged — behavior is identical.
 *
 * Longer-term alternatives (containerized ML worker / Nix / WASM / ONNX) are
 * tracked in MIGRATION_PLAN.md → "ML Runtime Decoupling".
 */
export const sdkChildEnv = (): NodeJS.ProcessEnv => {
  const node20Dir = process.env.SDK_NODE_BIN_DIR?.trim();
  if (!node20Dir) return process.env;
  return {
    ...process.env,
    PATH: `${node20Dir}${path.delimiter}${process.env.PATH ?? ''}`,
  };
};
