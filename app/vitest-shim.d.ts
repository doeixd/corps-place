/**
 * Ambient module shim for `vitest`.
 *
 * The test runner is vite-plus (`vp test`), which vendors its own vitest and
 * resolves `import ... from 'vitest'` at runtime via NODE_PATH — there is no
 * standalone `vitest` package in node_modules for tsc to resolve. This shim
 * declares the small surface our tests use so `vp check` (tsc) type-checks the
 * `*.test.ts` files instead of erroring with TS2307.
 */
declare module 'vitest' {
  interface Matchers<R> {
    toBe(expected: unknown): R;
    toEqual(expected: unknown): R;
    toMatchObject(expected: object): R;
    toMatch(expected: string | RegExp): R;
    toHaveLength(expected: number): R;
    toBeDefined(): R;
    toBeNull(): R;
    toContain(expected: unknown): R;
    toThrow(expected?: string | RegExp): R;
    readonly not: Matchers<R>;
  }
  export function expect(actual: unknown): Matchers<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
}
