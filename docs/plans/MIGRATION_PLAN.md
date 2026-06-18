# Migration Plan: Astro → TanStack Start

## Stack

| Layer            | Current                      | Target                                                                                                                        |
| ---------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Framework        | Astro 5 (SSR)                | TanStack Start (React) + SSR/Streaming                                                                                        |
| UI               | Vanilla JS + Astro `<style>` | React + Tailwind 4 + ReUI + shadcn/ui                                                                                         |
| Compiler         | None                         | React Compiler (`babel-plugin-react-compiler`) — auto-memoization, no manual `useMemo`/`useCallback`/`React.memo`             |
| Data Fetching    | Direct API calls             | Fate (`@nkzw/fate`) — normalized GraphQL-like queries with custom Effect + libsql backend                                     |
| State Management | Vanilla JS DOM manipulation  | **XState (`xstate`)** + XState Store + Effect for all actions (see new "State Management with XState + Effect" section below) |
| Animation        | None                         | Motion (`motion/react`)                                                                                                       |
| Icons            | Inline SVG                   | Hugeicons (`@hugeicons/react`)                                                                                                |
| Images           | Raw `<img>`                  | Unpic (`@unpic/react`)                                                                                                        |
| Auth             | None                         | Better Auth                                                                                                                   |
| Effects          | Effect TS (server only)      | Effect TS (server + optional client)                                                                                          |
| Schema           | None                         | Effect Schema (`effect/Schema`) — runtime validation for server fn inputs, API responses, form data                           |
| DB               | `@libsql/client` (SQLite)    | `@libsql/client` (SQLite)                                                                                                     |
| Theming          | Hardcoded hex values         | CSS variables (oklch) — full token system                                                                                     |
| Deploy           | `@astrojs/node` standalone   | TanStack Start Node preset                                                                                                    |

### Component Library Strategy

**ReUI** (reui.io) is the primary component source — 1003+ production-ready patterns built on shadcn/ui primitives. Use ReUI for composed, real-world UI patterns. Fall back to raw **shadcn/ui** primitives when ReUI doesn't have a matching pattern.

Both are copy-paste (not npm deps), living in `app/components/ui/`.

### React Compiler

**React Compiler** (formerly React Forget) automatically memoizes components and hooks, eliminating the need for manual `useMemo`, `useCallback`, and `React.memo` calls.

**Benefits:**

- Cleaner code — write components naturally without memoization boilerplate
- Fewer bugs — compiler enforces Rules of React at build time
- Better performance — fine-grained memoization without human error
- Works with XState — compiler understands `useActor`, `useStore` return values

**Setup:**

```bash
npm install -D babel-plugin-react-compiler
```

```typescript
// vite.config.ts
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    tanstackStart({ customViteReactPlugin: true }),
    react({
      babel: {
        plugins: ['babel-plugin-react-compiler'],
      },
    }),
    tailwindcss(),
  ],
});
```

**Guidelines:**

- Write components naturally — compiler handles memoization
- Follow Rules of React strictly (compiler will error on violations)
- Use `use no memo` directive to opt out of specific functions if needed
- XState hooks (`useActor`, `useStore`) are compiler-friendly — no manual wrapping needed
- Motion components work seamlessly with compiler

### Data Fetching with Fate

**Fate** (`@nkzw/fate`) is a normalized data fetching library that provides GraphQL-like queries with automatic caching, deduplication, and normalized responses — without the overhead of a full GraphQL server.

**Why Fate over TanStack Query:**

- **Normalized cache**: Objects are stored by `__typename` + `id`, so updates propagate everywhere automatically
- **Selection sets**: Request exactly the fields you need, reducing over-fetching
- **Relational data**: Handles nested relations elegantly (events → corps → scores)
- **Custom backend**: Works with any data source via custom source adapters

**Architecture:**

```
Client (useQuery) → Fate Server → Custom Source Adapter → Effect Services → libsql
```

**Custom Source Adapter (Effect + libsql):**

```typescript
// app/fate/custom-source.ts
import type { SourceAdapter } from '@nkzw/fate/server';
import { Effect } from 'effect';
import { EventPredictionService } from '@/lib/event-prediction-api';

export const createCustomSource = (): SourceAdapter<AppContext> => ({
  resolveById: async ({ ctx, id, input, view }) => {
    const result = await Effect.runPromise(
      Effect.provide(EventPredictionService.getById(id), EventPredictionService.Default)
    );
    return result;
  },

  resolveList: async ({ ctx, input, view }) => {
    const result = await Effect.runPromise(
      Effect.provide(EventDirectoryService.list2026Events(), EventDirectoryService.Default)
    );
    return result;
  },
});
```

**Fate Server Setup:**

```typescript
// app/fate/server.ts
import { createFateServer, createHonoFateHandler } from '@nkzw/fate/server';
import { createCustomSource } from './custom-source';
import { EventRoot, CorpsRoot, PredictionRoot } from './roots';

export const fate = createFateServer({
  context: async (adapterContext) => ({
    request: adapterContext.req.raw,
  }),
  roots: {
    Event: EventRoot,
    Corps: CorpsRoot,
    Prediction: PredictionRoot,
  },
  sources: createCustomSource(),
  mutations: {
    'event.refresh': {
      input: refreshInputSchema,
      resolve: async ({ ctx, input }) => {
        const result = await Effect.runPromise(
          Effect.provide(EventDirectoryService.refreshEvents(), EventDirectoryService.Default)
        );
        return result;
      },
    },
  },
});

export const fateHandler = createHonoFateHandler(fate);
```

**Client Usage:**

```typescript
// app/routes/events/2026/index.tsx
import { useQuery } from '@nkzw/fate/react'
import { EventRoot } from '@/fate/roots'

export const Route = createFileRoute('/events/2026/')({
  component: EventDirectory,
})

function EventDirectory() {
  const { data, isLoading } = useQuery(EventRoot.list, {
    select: {
      id: true,
      name: true,
      date: true,
      location: true,
      corps: {
        id: true,
        name: true,
        class: true,
      },
    },
  })

  if (isLoading) return <LoadingState />
  return <EventGrid events={data} />
}
```

**Integration with TanStack Start:**

- Fate server runs as a TanStack Start server function (not a separate Hono server)
- Client calls Fate via `createServerFn` wrapper
- Fate's normalized cache complements XState: Fate handles server data, XState handles UI state
- Use Fate for relational reads (events with corps, predictions with lineups)
- Use TanStack Start server functions directly for simple mutations (refresh, regenerate)

**File Structure:**

```
app/fate/
  server.ts              # createFateServer + handler
  custom-source.ts       # Custom source adapter (Effect + libsql)
  roots/
    event-root.ts        # Event queries (list, byId)
    corps-root.ts        # Corps queries
    prediction-root.ts   # Prediction queries
  client.ts              # Fate client setup for React
```

**Advantages:**

- Automatic normalization: update a corps score → all views showing that corps update instantly
- Selection sets prevent over-fetching (request only what the component needs)
- Works seamlessly with existing Effect services — no rewrite needed
- Smaller bundle than GraphQL clients (Apollo, Relay)
- Type-safe end-to-end with TypeScript

**Trade-offs:**

- More setup than TanStack Query for simple cases
- Must implement selection translation in custom source adapter
- Smaller community than TanStack Query (but growing)

### Effect RPC with Fate

**Yes, you _can_ use Effect RPC with Fate**, but **it's not the most straightforward or recommended path** right now.

### Can You Use Them Together?

**Technically: Yes**

Fate is quite flexible. You have two main ways:

1. **Hybrid Approach (Recommended)**
   - Use **Effect RPC** for your core business logic, services, and complex operations (mutations, internal calls, etc.).
   - Use Fate's **custom source adapter** (as we discussed earlier) or native protocol to bridge reads into Fate.
   - Your Effect RPC handlers can call Effect Services, which then feed data into Fate's `resolveById` / `resolveList`.

2. **Full Native Bridge**  
   Expose your Effect RPC router via HTTP/JSON-RPC, then write a custom Fate transport that calls the RPC client under the hood.

### Should You Use Effect RPC with Fate?

| Factor                           | Recommendation                  | Why                                            |
| -------------------------------- | ------------------------------- | ---------------------------------------------- |
| **Simplicity**                   | Use tRPC + Fate                 | Fate has **first-class tRPC adapter**          |
| **Effect purity**                | Effect RPC + Custom Fate source | Maximum consistency if you're all-in on Effect |
| **Development speed**            | tRPC + Fate                     | Less glue code                                 |
| **Complex logic / transactions** | Effect RPC + Fate               | Effect Services + Layers shine here            |
| **Type safety**                  | Tie (both excellent)            | Effect Schema vs Zod/tRPC inference            |
| **Maintenance**                  | tRPC + Fate (for now)           | Better documented integration                  |

### My Honest Recommendation for Your Stack

Since you're already going deep into **Effect + Turso + custom source**:

- **Use Effect RPC** for _mutations_ and internal backend-to-backend calls (where Effect's power is most valuable).
- **Use Fate's native/custom source** for _data fetching_ (the views, `useView`, masking, etc.).
- Avoid forcing Effect RPC as the _primary transport_ for Fate unless you have a strong reason (e.g., you need streaming responses or microservices).

Fate was explicitly designed to work well alongside **tRPC** (and even allows incremental adoption next to existing tRPC procedures). Effect RPC doesn't have a ready-made adapter like tRPC does.

### Practical Suggestion (Best of Both Worlds)

```ts
// Core business logic
export const PostService = Effect.Service(...)

// Effect RPC for complex actions
const rpcRouter = RpcRouter.make(
  Rpc.effect(CreatePost, (input) => PostService.create(input))
)

// Fate source that can call RPC or services directly
const fateSource = createEffectSource() // your custom adapter
```

This way you get:

- Effect RPC for powerful, typed, layered backend operations
- Fate for excellent React data fetching ergonomics

**Project Decision:** We are committing to **Effect services/layers + Effect RPC** (for mutations, complex logic, and internal calls) paired with Fate's custom source adapter for reads and React data needs. The hybrid pattern above will be the foundation for `app/fate/` and `app/rpc/`.

---

### State Management with XState + Effect

**Core insight (Sandro Maglione):** Every system logic **is** a state machine. XState (v5+) models the states and events; Effect implements all the actions/side effects triggered by transitions. This pair forms a complete, lightweight, fully type-safe stack (both have essentially zero dependencies).

This is a **perfect fit** for our existing choice of XState + Effect.Services + Layers.

#### Recommended Workflow

1. **Implement the Machine + Effect Actions**
   - Use the modern `setup({ types: { events, context }, actions }).createMachine(...)` pattern for excellent TypeScript inference.
   - Explicitly define states (including hierarchical/parent-child and final states), events (the only way to cause transitions), context shape, entry/exit actions, and self-transitions.
   - Strongly type Events (XState's built-in or a small `MachineParams` helper that turns a map into a discriminated union of `{ type; params? }`).
   - **For every action** in the machine config, implement a corresponding function returning `Effect.Effect<Success, Error, Requirements>`:
     ```ts
     // app/machines/prediction-machine/effects.ts
     export const startPrediction = (params: { slug: string; mode: string }) =>
       EventPredictionService.getOrCreate2026EventPrediction(params) // delegate to our Service!
         .pipe(
           Effect.map((result) => ({
             /* shape for context if needed */
           }))
         );
     ```
   - Two flavors of actions:
     - `assign(...)` wrappers → pure context updates.
     - Void side-effect actions (fire-and-forget or fire follow-up events).
   - Long-running/async actions can use the `self` parameter inside the action to `self.send({ type: "loaded", ... })` or `self.send({ type: "error" })` after the Effect settles. This gives clean "loading → success | error" states without blocking the machine.
   - **Best practice alignment**: Keep all real business logic inside `Effect.Service` classes. XState actions are the thin orchestration boundary (similar to our Fate custom source and RPC handlers).

2. **Consume in React (Dumb Components)**
   - Use `@xstate/react` → `const [snapshot, send] = useMachine(machine);`
   - Rendering branches: `snapshot.matches("Active")`, `snapshot.matches({ Active: "Playing" })` (fully typed).
   - User/DOM interactions: `send({ type: "play", params: { ... } })` (from buttons, `<audio>` callbacks like `onTimeUpdate`, `onLoadedData`, Fate reactivity callbacks, etc.).
   - The React component has **exactly two jobs**:
     1. Render layout based on current `snapshot.value` + `snapshot.context`.
     2. Send events.
   - No business logic, no manual `useState` for loading/error, no direct service calls.

#### Benefits for This Migration

- **Prediction page** (the old ~1400-line beast with XState + heavy tables): Becomes dramatically simpler. Model readiness states, mode variants, prediction lifecycle, refresh-in-progress as a clean hierarchical machine.
- Refresh / ingest workflows get first-class testable state machines.
- Outstanding testability: test the machine in isolation + test the Effect programs that the actions call.
- Works beautifully with the rest of our hybrid: XState orchestrates **UI state and local effects**; heavy data access, mutations, and caching go through Fate (reads) + Effect RPC / Services (writes + complex work).
- React Compiler friendly (`useActor`, `useMachine` return values are understood).

#### Integration & Effect Best Practices Notes

- XState actions live at the same "boundary" level as our Fate resolvers and legacy `createServerFn` handlers: they may contain `Effect.runSync` / `runPromise` (or better, use the runner from a provided layer at mount), but they **must** delegate to Services.
- Consider XState actors for long-lived background processes if needed later.
- For persistence of machine state across refreshes (useful for long prediction jobs), XState has built-in persistence options or we can snapshot context into our progress DB via an Effect service.
- Pair with Motion for enter/exit animations driven by state changes (`snapshot.matches` drives `AnimatePresence` or variants).

**References:**

- Original patterns: Sandro Maglione newsletter + full article on the audio player example (highly recommended reading).
- Our `app/lib/` services remain the single source of truth for domain logic.

### Control Flow Components (Solid-style)

For presentational control flow, consider using the SolidJS-inspired components provided by **`jotai-solid-api`**:

- `<Show when={condition}>...</Show>` (with optional `fallback`)
- `<For each={items}>...</For>` (and `<Index>`)
- `<Switch>` + `<Match when={...}>` for exhaustive conditional rendering

These are exported directly from `jotai-solid-api` (alongside many other Solid-like primitives built on Jotai).

**Why consider them:**

- Much cleaner than nested ternaries, `&&` short-circuiting, or `.map()` + fragments for lists.
- Excellent readability for complex UI states (especially when combined with XState `snapshot.matches(...)` results, Effect Atom `Result` values, or Fate query data).
- `<Match>` / `<Switch>` pairs particularly well with state machine states or union types.

**Usage example (with XState or Effect data):**

```tsx
import { Show, For, Match, Switch } from "jotai-solid-api";

<Show when={snapshot.matches("Active")} fallback={<Loading />}>
  <For each={events}>
    {(event) => <EventCard event={event} />}
  </For>
</Show>

<Switch fallback={<Idle />}>
  <Match when={predictionResult.error}>{(err) => <ErrorView error={err} />}</Match>
  <Match when={predictionResult.loading}><Spinner /></Match>
  <Match when={predictionResult.data}>{(data) => <RecapTable data={data} />}</Match>
</Switch>
```

**Integration & Trade-offs:**

- The package requires installing `jotai` + `jotai-solid-api`.
- The control flow components themselves work with any reactive value (you don't _have_ to use the Jotai signal primitives or the `component()` wrapper).
- They are presentation-only ergonomics — they do not replace XState (for complex machines) or Effect Atom (for Effect-integrated state).
- React Compiler already eliminates a lot of manual memoization around lists and conditionals. Evaluate whether these components provide enough readability win to justify the extra dependency.
- If adopted, use them primarily in leaf/presentational components. Keep core state and data fetching in XState + Effect Services + Fate as per the rest of the plan.

**Recommendation:**
Use `jotai-solid-api` primarily for `<Show>` and `<For>`. For complex matching on domain types, errors, or states, strongly prefer `effect/Match` (see next section). Add the package when the first complex list + conditional screens are being ported in Phase 4. Do **not** adopt the full `component()` + signal authoring model unless the team decides to move more heavily toward Jotai.

### Predicates with `effect/Predicate`

We centralize **all** boolean logic, feature flags, guards, and conditions using:

```ts
import * as Predicate from 'effect/Predicate';
```

**Why this matters for us:**

- Composable predicate logic (`Predicate.and`, `Predicate.or`, `Predicate.not`, `Predicate.every`, `Predicate.some`)
- Excellent type-level refinements (`isString`, `isOption`, custom branded predicates, `struct`, `tuple`, etc.)
- Plays extremely well with our stack:
  - XState guards
  - `jotai-solid-api` `<Show when={...}>` / `<Match when={...}>`
  - Effect `.pipe(Effect.filter(...))`
  - Service-level decision making

**Guidelines:**

- All flags, mode checks, readiness predicates, validation conditions, and UI visibility logic should be expressed as `Predicate` values (or composed from them).
- Define reusable predicates in `app/predicates/*.ts` modules (e.g. `prediction.ts`, `event.ts`, `featureFlags.ts`).
- Prefer `Predicate.struct(...)` and `Predicate.tuple(...)` over manual `&&` / `||` chains when dealing with object or tuple shapes.
- Keep predicates pure and side-effect free.
- When a predicate is used in multiple places (machine guard + UI Show + service), define it once in a predicate module and import it everywhere.

This gives us a single, consistent, highly composable way to express "is this thing in this state / does it satisfy these conditions" across the entire application.

### Pattern Matching with `effect/Match`

For anything beyond simple boolean conditions, we **prefer `effect/Match`** over the `<Match>` / `<Switch>` components from `jotai-solid-api`.

```ts
import * as Match from 'effect/Match';
import * as Predicate from 'effect/Predicate';
```

**Why we prefer it:**

- Exhaustive, type-safe pattern matching on discriminated unions, `Schema.TaggedError`, readiness states, prediction results, etc.
- Works directly with `effect/Predicate` (e.g. `Match.when(Predicate.isSome(...), ...)`).
- Can produce plain values **or** `Effect` programs.
- Excellent for complex domain logic that belongs in services or XState actions.

**Guideline – When to use which:**

| Use Case                                                        | Preferred Tool                                        | Reason                                   |
| --------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| Simple boolean visibility / loading                             | `jotai-solid-api` `<Show>`                            | Lightweight React ergonomics             |
| Lists                                                           | `jotai-solid-api` `<For>`                             | Same as above                            |
| Complex matching on domain types, errors, modes, tagged results | `effect/Match`                                        | Full exhaustiveness + Effect integration |
| XState guards or action decisions                               | `effect/Match` (composed with Predicate)              | Keeps logic in the Effect/XState layer   |
| Quick presentational branching on snapshot values               | `jotai-solid-api` `<Match>` / `<Switch>` (acceptable) | Only when the logic is purely UI         |

**Recommendation:**

- Default to `effect/Match` for any non-trivial conditional logic.
- Keep `jotai-solid-api` primarily for `<Show>` and `<For>`.
- When using `effect/Match` in a React component, you can still feed the result into `<Show>` or render it directly.

This approach keeps our conditional logic consistent with the rest of the Effect + Predicate strategy while still allowing ergonomic UI control flow where it adds the most value.

---

## Phase 0 — Scaffold & Config

1. **Initialize TanStack Start project**
   - `npx create-tsrouter-app@latest` or manual setup in `web/` directory
   - File-based routing under `app/routes/`
   - Vite as bundler

2. **Install dependencies**
   - `@tanstack/react-start`, `@tanstack/react-router`
   - `react`, `react-dom`, `@types/react`, `@types/react-dom`
   - `tailwindcss@4`, `@tailwindcss/vite`
   - `motion` (animation library, successor to Framer Motion)
   - `@hugeicons/react` (icon library — 4000+ icons, tree-shakeable)
   - `@unpic/react`
   - `better-auth`
   - `xstate`, `@xstate/react`, `@xstate/store` (state machines + lightweight stores)
   - `effect` (already present — includes `Schema` for runtime validation)
   - `babel-plugin-react-compiler` (auto-memoization, enforces Rules of React)
   - `@nkzw/fate` (normalized data fetching with custom Effect + libsql backend)
   - `@libsql/client` (already present)
   - `jotai` + `jotai-solid-api` (optional — Solid-style `<Show>`, `<For>`, `<Match>` control flow components for presentation layer)
   - `class-variance-authority`, `clsx`, `tailwind-merge` (shadcn/ReUI deps)
   - Remove: `astro`, `@astrojs/node`

3. **Initialize shadcn/ui + ReUI**
   - `npx shadcn@latest init` — base primitives layer
   - Configure `components.json` with Tailwind 4, CSS variables, New York style
   - Set path aliases: `@/` → `app/`
   - Install ReUI components via `npx shadcn@latest add` (ReUI is shadcn-registry compatible) or copy from reui.io docs
   - ReUI and shadcn share the same `components/ui/` directory

4. **Configure Vite** (`vite.config.ts`)
   - TanStack Start plugin
   - Tailwind 4 Vite plugin
   - Port DCI API proxy config from `astro.config.mjs`
   - Path aliases: `@/` → `app/`, `@sdk/` → `sdk/`

5. **Configure SSR/Streaming**
   - TanStack Start uses React 18+ streaming SSR by default
   - `app/router.tsx` — configure `createRouter()` with `defaultPreload: 'intent'` and streaming options
   - Route loaders return data that streams to the client as it resolves
   - Use `<Suspense>` boundaries for progressive loading (event directory cards, prediction table)
   - `defer: true` on route loaders for non-critical data (refresh status, prediction details)
   - Motion animations hydrate client-side only — use `initial={false}` on server-rendered content to prevent hydration mismatches

6. **Port environment variables**
   - `.env` stays as-is
   - Add TanStack Start env typing (`env.d.ts`)

---

## Phase 1 — Shared Server Layer

6. **Migrate `src/lib/` → `app/lib/`** (server-side Effect services)
   - `eventPredictionApi.ts` — no changes needed, pure Effect + libsql
   - `eventDirectory.ts` — same, pure Effect + libsql
   - SDK imports remain relative (`../../sdk/...`)

7. **Create server functions** (TanStack Start `createServerFn`)
   - `getEventDirectory()` — wraps `EventDirectoryService.list2026Events()`
   - `refreshEvents()` — wraps refresh spawn logic
   - `getRefreshStatus()` — wraps refresh status query
   - `getEventPrediction(slug, params)` — wraps `EventPredictionService.getOrCreate2026EventPrediction()`
   - These replace the 3 API route files (`index.json.ts`, `refresh.json.ts`, `prediction.json.ts`)
   - **Effect Schema validation** on all server fn inputs:
     ```typescript
     import { Schema } from '@effect/schema';
     const GetPredictionInput = Schema.Struct({
       slug: Schema.String.pipe(Schema.nonEmpty()),
       classFilter: Schema.optional(Schema.Union(Schema.Literal('world'), Schema.Literal('open'))),
       window: Schema.optional(
         Schema.Union(
           Schema.Literal('likely'),
           Schema.Literal('possible'),
           Schema.Literal('unlikely')
         )
       ),
     });
     ```
   - Schema validation also used for: form submissions (auth, refresh trigger), API response decoding, client→server event payloads

---

## Phase 2 — Auth with Better Auth

8. **Set up Better Auth**
   - `app/lib/auth.ts` — configure Better Auth instance (SQLite adapter via `@libsql/client`)
   - Define auth schema (users table, sessions)
   - Add auth middleware to TanStack Start router
   - Create auth routes (`/sign-in`, `/sign-up`, `/sign-out`)

9. **Auth UI**
   - `app/routes/auth/sign-in.tsx` — ReUI **Card** (sign-in variant) + **Input Group** + **Button** + **Field**
   - `app/routes/auth/sign-up.tsx` — ReUI **Card** (sign-up variant) + **Input Group** + **Field**
   - `app/components/auth/user-menu.tsx` — ReUI **Dropdown Menu** with **Avatar** + sign-out item

---

## Phase 3 — Layout & Design System

10. **Root layout** (`app/routes/__root.tsx`)
    - Port `Layout.astro` → React root with `<html>`, `<head>`, `<body>`
    - Add `<AuthSessionProvider>` wrapper
    - Add ReUI **Sonner** (toast notifications)

11. **Design token system** (`app/app.css`) — oklch-based, fully themeable
    - All visual tokens are CSS custom properties, consumed by Tailwind 4 `@theme`
    - Colors use oklch for perceptual uniformity and easy light/dark theming
    - Every hardcoded value (color, radius, shadow, spacing, font) maps to a token

    ```css
    :root {
      /* ── Color palette (oklch) ── */
      --color-base-0: oklch(0.98 0.005 260); /* near-white background */
      --color-base-50: oklch(0.97 0.005 260); /* subtle background */
      --color-base-100: oklch(0.95 0.008 260); /* card background */
      --color-base-200: oklch(0.9 0.01 260); /* borders */
      --color-base-300: oklch(0.82 0.012 260); /* muted borders */
      --color-base-400: oklch(0.65 0.015 260); /* muted text */
      --color-base-500: oklch(0.5 0.018 260); /* secondary text */
      --color-base-600: oklch(0.4 0.02 260); /* body text */
      --color-base-700: oklch(0.3 0.022 260); /* headings */
      --color-base-800: oklch(0.2 0.025 260); /* strong text */
      --color-base-900: oklch(0.13 0.028 260); /* near-black */

      /* ── Semantic colors (oklch) ── */
      --color-primary: oklch(0.55 0.15 250);
      --color-primary-fg: oklch(0.98 0.005 250);
      --color-primary-muted: oklch(0.92 0.04 250);

      --color-success: oklch(0.55 0.14 155);
      --color-success-fg: oklch(0.98 0.005 155);
      --color-success-muted: oklch(0.92 0.05 155);

      --color-warning: oklch(0.75 0.15 80);
      --color-warning-fg: oklch(0.2 0.05 80);
      --color-warning-muted: oklch(0.95 0.05 80);

      --color-destructive: oklch(0.55 0.22 25);
      --color-destructive-fg: oklch(0.98 0.005 25);
      --color-destructive-muted: oklch(0.95 0.04 25);

      --color-info: oklch(0.6 0.12 240);
      --color-info-fg: oklch(0.98 0.005 240);
      --color-info-muted: oklch(0.93 0.03 240);

      /* ── Surface tokens (semantic aliases) ── */
      --surface-page: var(--color-base-0);
      --surface-card: var(--color-base-100);
      --surface-elevated: oklch(1 0 0);
      --surface-overlay: oklch(0.13 0.028 260 / 0.5);

      /* ── Text tokens ── */
      --text-primary: var(--color-base-800);
      --text-secondary: var(--color-base-500);
      --text-muted: var(--color-base-400);
      --text-inverse: var(--color-base-0);

      /* ── Border tokens ── */
      --border-default: var(--color-base-200);
      --border-muted: var(--color-base-300);
      --border-strong: var(--color-base-400);

      /* ── Radius tokens ── */
      --radius-xs: 0.25rem;
      --radius-sm: 0.375rem;
      --radius-md: 0.5rem;
      --radius-lg: 0.75rem;
      --radius-xl: 1rem;
      --radius-2xl: 1.5rem;
      --radius-full: 9999px;

      /* ── Shadow tokens ── */
      --shadow-xs: 0 1px 2px oklch(0.13 0.028 260 / 0.05);
      --shadow-sm: 0 1px 3px oklch(0.13 0.028 260 / 0.08), 0 1px 2px oklch(0.13 0.028 260 / 0.04);
      --shadow-md: 0 4px 6px oklch(0.13 0.028 260 / 0.07), 0 2px 4px oklch(0.13 0.028 260 / 0.04);
      --shadow-lg: 0 10px 15px oklch(0.13 0.028 260 / 0.08), 0 4px 6px oklch(0.13 0.028 260 / 0.04);
      --shadow-xl: 0 20px 25px oklch(0.13 0.028 260 / 0.1), 0 8px 10px oklch(0.13 0.028 260 / 0.04);

      /* ── Spacing tokens ── */
      --space-1: 0.25rem;
      --space-2: 0.5rem;
      --space-3: 0.75rem;
      --space-4: 1rem;
      --space-5: 1.25rem;
      --space-6: 1.5rem;
      --space-8: 2rem;
      --space-10: 2.5rem;
      --space-12: 3rem;
      --space-16: 4rem;

      /* ── Typography tokens ── */
      --font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, 'Cascadia Code', monospace;
      --text-xs: 0.75rem;
      --text-sm: 0.875rem;
      --text-base: 1rem;
      --text-lg: 1.125rem;
      --text-xl: 1.25rem;
      --text-2xl: 1.5rem;
      --text-3xl: 1.875rem;
      --leading-tight: 1.25;
      --leading-normal: 1.5;
      --leading-relaxed: 1.625;
      --tracking-tight: -0.025em;
      --tracking-normal: 0em;
      --tracking-wide: 0.025em;

      /* ── Transition tokens ── */
      --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
      --ease-in: cubic-bezier(0.4, 0, 1, 1);
      --ease-out: cubic-bezier(0, 0, 0.2, 1);
      --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
      --duration-fast: 100ms;
      --duration-normal: 200ms;
      --duration-slow: 300ms;

      /* ── Z-index tokens ── */
      --z-dropdown: 50;
      --z-sticky: 100;
      --z-overlay: 200;
      --z-modal: 300;
      --z-toast: 400;
    }

    /* ── Dark theme override ── */
    .dark {
      --surface-page: oklch(0.15 0.02 260);
      --surface-card: oklch(0.2 0.02 260);
      --surface-elevated: oklch(0.25 0.02 260);
      --text-primary: oklch(0.95 0.005 260);
      --text-secondary: oklch(0.7 0.015 260);
      --text-muted: oklch(0.55 0.015 260);
      --border-default: oklch(0.3 0.02 260);
      --border-muted: oklch(0.25 0.02 260);
    }

    @theme {
      /* Tailwind 4 reads these as utility classes: bg-surface-page, text-primary, etc. */
      --color-*: initial;
      --color-surface-page: var(--surface-page);
      --color-surface-card: var(--surface-card);
      --color-surface-elevated: var(--surface-elevated);
      --color-surface-overlay: var(--surface-overlay);
      --color-text-primary: var(--text-primary);
      --color-text-secondary: var(--text-secondary);
      --color-text-muted: var(--text-muted);
      --color-text-inverse: var(--text-inverse);
      --color-border-default: var(--border-default);
      --color-border-muted: var(--border-muted);
      --color-border-strong: var(--border-strong);
      --color-primary: var(--color-primary);
      --color-primary-fg: var(--color-primary-fg);
      --color-primary-muted: var(--color-primary-muted);
      --color-success: var(--color-success);
      --color-success-fg: var(--color-success-fg);
      --color-success-muted: var(--color-success-muted);
      --color-warning: var(--color-warning);
      --color-warning-fg: var(--color-warning-fg);
      --color-warning-muted: var(--color-warning-muted);
      --color-destructive: var(--color-destructive);
      --color-destructive-fg: var(--color-destructive-fg);
      --color-destructive-muted: var(--color-destructive-muted);
      --color-info: var(--color-info);
      --color-info-fg: var(--color-info-fg);
      --color-info-muted: var(--color-info-muted);

      --radius-*: initial;
      --radius-xs: var(--radius-xs);
      --radius-sm: var(--radius-sm);
      --radius-md: var(--radius-md);
      --radius-lg: var(--radius-lg);
      --radius-xl: var(--radius-xl);
      --radius-2xl: var(--radius-2xl);
      --radius-full: var(--radius-full);

      --shadow-*: initial;
      --shadow-xs: var(--shadow-xs);
      --shadow-sm: var(--shadow-sm);
      --shadow-md: var(--shadow-md);
      --shadow-lg: var(--shadow-lg);
      --shadow-xl: var(--shadow-xl);

      --font-sans: var(--font-sans);
      --font-mono: var(--font-mono);
    }
    ```

    - **Theming**: swap the entire palette by overriding `:root` variables (e.g., a DCI-branded theme, dark mode, high-contrast)
    - **No hardcoded values** in components — every color, radius, shadow, and spacing uses a Tailwind utility backed by a CSS variable
    - Inter font via `@fontsource/inter` or Google Fonts

12. **Hugeicons setup** (`app/lib/icons.ts`)
    - Install `@hugeicons/react` — 4000+ icons, tree-shakeable, consistent stroke width
    - Create `app/components/icon.tsx` wrapper that standardizes size/stroke/color via token props
    - Replace all inline SVGs (class badge icons, info toggle, back arrow, external link, dice roll) with Hugeicons equivalents
    - shadcn/ReUI components that reference `lucide-react` internally: override icon slots with Hugeicons at the call site
    - Icon sizes use token scale: `--icon-sm: 1rem`, `--icon-md: 1.25rem`, `--icon-lg: 1.5rem`

13. **Install ReUI + shadcn components** (layered approach)

    | Need          | ReUI (primary)                                               | shadcn fallback        |
    | ------------- | ------------------------------------------------------------ | ---------------------- |
    | Buttons       | ReUI **Button** (61 variants)                                | shadcn `button`        |
    | Button groups | ReUI **Button Group** (57 variants)                          | —                      |
    | Cards         | ReUI **Card** (18 variants)                                  | shadcn `card`          |
    | Badges        | ReUI **Badge** (25 variants)                                 | shadcn `badge`         |
    | Inputs        | ReUI **Input** (31 variants) + **Input Group** (40 variants) | shadcn `input`         |
    | Selects       | ReUI **Select** (33 variants)                                | shadcn `select`        |
    | Tables        | ReUI **Table** (17 variants)                                 | shadcn `table`         |
    | Data grids    | ReUI **Data Grid** (29 variants, TanStack Table)             | —                      |
    | Filters       | ReUI **Filters** (9 variants)                                | —                      |
    | Alerts        | ReUI **Alert** (20 variants)                                 | shadcn `alert`         |
    | Collapsibles  | ReUI **Collapsible** (10 variants)                           | shadcn `collapsible`   |
    | Pagination    | ReUI **Pagination** (15 variants)                            | shadcn `pagination`    |
    | Spinners      | ReUI **Spinner** (12 variants)                               | —                      |
    | Skeletons     | ReUI **Skeleton** (10 variants)                              | shadcn `skeleton`      |
    | Empty states  | ReUI **Empty** (20 variants)                                 | —                      |
    | Scroll areas  | ReUI **Scroll Area** (5 variants)                            | shadcn `scroll-area`   |
    | Toggle groups | ReUI **Toggle Group** (16 variants)                          | shadcn `toggle-group`  |
    | Checkboxes    | ReUI **Checkbox** (22 variants)                              | shadcn `checkbox`      |
    | Tooltips      | ReUI **Tooltip** (16 variants)                               | shadcn `tooltip`       |
    | Breadcrumbs   | ReUI **Breadcrumb** (15 variants)                            | shadcn `breadcrumb`    |
    | Dropdowns     | ReUI **Dropdown Menu** (18 variants)                         | shadcn `dropdown-menu` |
    | Avatars       | ReUI **Avatar** (35 variants)                                | shadcn `avatar`        |
    | Progress      | ReUI **Progress** (8 variants)                               | shadcn `progress`      |
    | Separators    | ReUI **Separator** (6 variants)                              | shadcn `separator`     |
    | Fields        | ReUI **Field** (11 variants)                                 | —                      |
    | Labels        | ReUI **Label** (13 variants)                                 | shadcn `label`         |
    | Frames        | ReUI **Frame** (17 variants, image containers)               | —                      |
    | Dialogs       | ReUI **Dialog** (10 variants)                                | shadcn `dialog`        |
    | Sheets        | ReUI **Sheet** (4 variants)                                  | shadcn `sheet`         |

14. **Shared React components** (`app/components/`)
    - `ClassBadge` — World/Open badge with Hugeicons trophy icon (ReUI **Badge** with icon pattern)
    - `PageHeader` — ReUI **Breadcrumb** + title + ReUI **Button Group** for actions (Hugeicons for back arrow, external link)
    - `StatusCard` — error/loading states using ReUI **Card** + **Spinner** / **Empty**
    - `LoadingState` — ReUI **Skeleton** or **Spinner** variant
    - `Icon` — wrapper around `@hugeicons/react` with token-based sizing (`icon-sm`, `icon-md`, `icon-lg`) and color inheritance

---

## Phase 3.5 — Motion & Animation

14. **Motion setup** (`app/lib/motion.ts`)
    - Configure `MotionConfig` with reduced motion support (`reducedMotion: 'user'`)
    - Define shared animation variants (fade, slide, stagger) in `app/lib/motion-variants.ts`
    - SSR-safe: use `initial={false}` on server-rendered content to prevent hydration mismatches

15. **Animation patterns**

    | Pattern             | Motion API                         | Use Case                                  |
    | ------------------- | ---------------------------------- | ----------------------------------------- |
    | Page transitions    | `<AnimatePresence>` + `exit` props | Route transitions between pages           |
    | List animations     | `staggerChildren` variant          | Event cards grid, recap table rows        |
    | Layout transitions  | `layout` prop                      | Filter changes, sort reordering           |
    | Presence animations | `<AnimatePresence mode="wait">`    | Loading → content, collapsible sections   |
    | Hover/tap feedback  | `whileHover`, `whileTap`           | Buttons, cards, interactive elements      |
    | Scroll-triggered    | `useInView` + `whileInView`        | Event cards fade in on scroll             |
    | Skeleton pulse      | `animate` with opacity keyframes   | Loading states (complement ReUI Skeleton) |
    | Number transitions  | `useMotionValue` + `useTransform`  | Score counters, rank changes on roll      |

16. **SSR/Streaming + Motion integration**
    - Server renders static HTML (no animations) — Motion hydrates on client
    - Use `<Suspense>` boundaries around streaming data sections
    - Prediction table: stream rows as they compute, animate each row's entrance
    - Event directory: stream cards as they load, stagger entrance animations
    - Wrap streaming boundaries with `<AnimatePresence>` for smooth loading → content transitions

---

## Phase 4 — Pages

### 17. Home page (`app/routes/index.tsx`)

- Port `index.astro` — simple landing with link to `/events/2026`
- ReUI **Card** (hero/CTA variant) + **Button** for the link
- **Motion**: fade-in on mount, subtle scale entrance for the card
- Trivial: ~30 lines of React + Tailwind

### 18. Event directory (`app/routes/events/2026/index.tsx`)

- Port `events/2026/index.astro` (~700 lines → ~300 lines React)
- **Server**: `loader` calls `getEventDirectory()` server fn, streams results via `<Suspense>`
- **Client components**:
  - `EventCard` — ReUI **Card** (media/info variant) with ReUI **Badge** for status pills (lineup, judges, prediction, scores), ReUI **Frame** for event images
    - **Motion**: `whileHover` scale, `useInView` fade-in on scroll
  - `EventGrid` — CSS grid with ReUI **Input** (search with icon variant) + ReUI **Filters** for filter chips
    - **Motion**: `layout` prop on grid container for smooth reflow when filtering, `staggerChildren` for card entrance
  - `EventPagination` — ReUI **Pagination** component
  - `RefreshPanel` — ReUI **Card** with ReUI **Button** trigger + ReUI **Progress** bar + polling via `useQuery` or `setInterval`
    - **Motion**: progress bar animates width changes
  - Empty state — ReUI **Empty** component when no events match filters
    - **Motion**: `<AnimatePresence>` fade-out cards, fade-in empty state
- Replace ~280 lines of vanilla JS DOM manipulation with React state
- Replace ~430 lines of scoped CSS with Tailwind + ReUI components

### 19. Prediction page (`app/routes/events/2026/$slug/prediction.tsx`)

- Port `events/2026/[slug]/prediction.astro` (~1400 lines → ~500 lines React)
- **Server**: `loader` calls `getEventPrediction(slug, params)` server fn, streams prediction data
- **Client components**:
  - `PageHeader` — ReUI **Breadcrumb** (back to events) + title + ReUI **Button Group** (Refresh / Regenerate)
  - `RecapTable` — ReUI **Table** (striped/dense variant) with ReUI **Scroll Area** wrapper for horizontal scroll
    - **Motion**: `<AnimatePresence>` on rows for class filter changes, `layout` prop for rank reordering on roll
  - `RecapToolbar`:
    - Class filter → ReUI **Select** (compact/native variant)
    - Window selector → ReUI **Toggle Group** (Likely / Possible / Unlikely as segmented control) with `layout` animation on indicator
    - Ranges toggle → ReUI **Checkbox** (inline variant)
    - Roll / Reset → ReUI **Button Group** with ReUI **Button** variants (Hugeicons `Dice` for roll), `whileTap` feedback
    - Scenario label → ReUI **Badge** (info variant) with `AnimatePresence` entrance on roll
  - `PredictionDetailsToggle` — ReUI **Button** (ghost/outline, small) with Hugeicons `InformationCircle` icon
  - `PredictionDetails` — ReUI **Collapsible** section:
    - **Motion**: `<AnimatePresence>` + height animation on expand/collapse
    - Header → ReUI **Badge** (success pill for readiness) + timestamp
    - Metadata chips → ReUI **Badge** (outline/subtle variants) in a flex row, `staggerChildren` entrance
    - Lineup audit → ReUI **Collapsible** (nested) with two-column grid
    - Caveats → ReUI **Alert** (warning variant)
  - Loading state → ReUI **Skeleton** (table variant) or **Spinner**
    - **Motion**: skeleton pulse animation
  - Error state → ReUI **Alert** (destructive variant)
    - **Motion**: shake animation on error entrance
- **State machine**: `predictionMachine` (XState) — ports Monte Carlo sampling logic
  - States: `idle` → `loaded` → `rolled` (with sub-states for window selection, class filtering)
  - Events: `LOAD_DATA`, `ROLL`, `RESET`, `SET_WINDOW`, `SET_CLASS_FILTER`, `TOGGLE_RANGES`
  - Context: `currentRecap`, `scenarioCount`, `isRolled`, `selectedWindow`, `classFilter`, `showRanges`
  - Actions: `rollScenario`, `sampleCaption`, `captionRange`, `computedRanges` (pure math in machine actions)
  - Consumed via `useActor(predictionMachine)` from `@xstate/react`
  - **Motion**: `useMotionValue` + `useTransform` for animated score counters during roll transitions
- Replace ~460 lines of vanilla JS with XState machine + React components
- Replace ~730 lines of scoped CSS with Tailwind + ReUI components

---

## Phase 5 — Images & Polish

20. **Unpic integration**
    - Replace any `<img>` tags with `<Image>` from `@unpic/react`
    - Event images (currently commented out in prediction page) get responsive, optimized rendering
    - Wrap in ReUI **Frame** for consistent aspect ratio and border styling
    - Unpic handles `srcset`, lazy loading, and aspect ratio automatically

21. **Responsive design audit**
    - Verify all breakpoints (900px, 760px, 680px) with Tailwind responsive prefixes (`sm:`, `md:`, `lg:`)
    - Test table horizontal scroll on mobile (ReUI **Scroll Area**)
    - ReUI **Sheet** for mobile nav/menus if needed
    - Verify Motion animations respect `prefers-reduced-motion` (configured in `MotionConfig`)

22. **Accessibility pass**
    - ReUI/shadcn components are accessible by default (Radix/Base UI primitives)
    - Verify `aria-expanded`, `aria-controls` on prediction details toggle
    - Ensure `aria-live` regions for scenario labels and loading states
    - ReUI **Tooltip** for icon-only buttons (Roll, info toggle)
    - Motion: ensure animations don't interfere with screen readers (use `aria-hidden` on decorative motion)

---

## Phase 6 — Cleanup & Deploy

23. **Remove Astro artifacts**
    - Delete `src/pages/`, `src/layouts/`, `src/components/Welcome.astro`, `src/assets/`
    - Delete `astro.config.mjs`
    - Remove `astro` and `@astrojs/node` from `package.json`

24. **Update scripts** in `package.json` — DONE
    - Modern Vite-based TanStack Start runs on plain Vite (NOT vinxi — vinxi was the legacy `app.config.ts` runner and caused the `path.replace`/503 breakage).
    - `dev` → `vite dev` (now `vp dev` under vite-plus)
    - `build` → `vite build` (now `vp build`)
    - `start` → `node .output/server/index.mjs`
    - `preview` → `vite preview` (now `vp preview`)

25. **Deploy target**
    - TanStack Start Node preset (Nitro `node-server`) — proven: `vite build` → `.output/server`, served by `node .output/server/index.mjs`.
    - SDK child process spawning requires Node runtime (not edge/serverless). See "ML Runtime Decoupling" below for how the ML runtime is kept separate from the serving runtime.

---

## ML Runtime Decoupling (TensorFlow.js / Node 20 vs. modern serving LTS)

**Problem.** The SDK (`sdk/`) runs training + inference via `@tensorflow/tfjs-node`, whose native bindings require **Node 20.x** (prebuilt binaries; newer Node often lacks prebuilts / fails to rebuild). Node 20 reached EOL ~April 2026, so we do **not** want to serve public traffic on it.

**Key fact that makes this tractable.** The web server **never imports tfjs-node**. All TF code lives in `sdk/`, and the server reaches the model exclusively by spawning `npx tsx scripts/...` in `sdk/` (`app/lib/event-prediction-api.ts`, `app/lib/event-directory.ts`). Server and ML are already **separate OS processes**; predictions/refresh write to SQLite, and the web reads from the DB. The only coupling is that `spawn` inherits the parent's `PATH`, so the child currently runs under the same Node as the server.

### Stage 1 — Pin the SDK child to Node 20 (DONE)

- `app/lib/sdk-process.ts` exports `sdkChildEnv()`. When `SDK_NODE_BIN_DIR` is set, it prepends that dir to the **child's** `PATH` so `npx`/`tsx`/`node` resolve to Node 20 for SDK workloads only; the server process can run a current LTS (22/24). When unset (local dev already on Node 20 via Volta), behavior is unchanged.
- Wired into all three spawn sites (`runCommand` ×2 + `spawnRefreshInBackground`).
- **Deploy usage:** install Node 20 alongside the serving Node, set `SDK_NODE_BIN_DIR=/path/to/node20/bin` in the server's environment. Single machine, lowest effort, keeps tfjs-node as-is.
- Volta note: `volta.node` is currently `20.20.0` (pins everything to 20 in dev). Once Stage 1 is exercised in deploy, the _server's_ Volta/engines can move to a modern LTS while `SDK_NODE_BIN_DIR` keeps the child on 20.

### Stage 2 — Isolate the ML runtime for production (PLANNED, pick one)

**Option B — Containerize (recommended default).**

- Two images: **web** (modern LTS, runs `.output/server`) and **ml-worker** (Node 20 + `@tensorflow/tfjs-node` + `sdk/`).
- They already coordinate through SQLite (the source of truth). Promote refresh/predict from "server spawns child" to "server enqueues a job; ml-worker picks it up" (a `jobs` table or a lightweight queue), or keep spawn-style by having the web container exec into / RPC the ml-worker.
- Pros: clean runtime isolation, independent scaling, no Node-version juggling on one host. Cons: most infra setup; need a shared volume/connection for the DB (or move to libsql/Turso server mode).
- libsql note: if web and ml-worker are separate containers, a shared SQLite file needs a shared volume **or** switching to a libsql server (Turso / `sqld`) so both connect over the network. This is the main design decision for Option B.

**Option (Nix) — Reproducible toolchain instead of containers.**

- A `flake.nix` pinning Node 20 + native build deps for the ML side and a modern Node for the web side; `nix develop` / `nix build` produce both runtimes deterministically. Good if deploying to a single NixOS/Nix host rather than a container orchestrator. Lower isolation than containers but reproducible and no Docker daemon.

**Option C — Remove the native-binding constraint from the serving-adjacent path.**

- Convert **inference** off `@tensorflow/tfjs-node` so it runs on any Node:
  - `@tensorflow/tfjs` with the **WASM** backend (`@tensorflow/tfjs-backend-wasm`) or pure-CPU JS backend — no native bindings. Models here are small (see `sdk/models/.../weights.bin`), so WASM latency is likely fine.
  - or convert the saved model to **ONNX** and run via `onnxruntime-node` (supports modern Node).
- **Training stays on tfjs-node offline** (run by whoever retrains, on Node 20) — only the inference path that the server triggers gets ported.
- Pros: removes the version constraint from everything the server touches; could even allow inference **in-process** later. Cons: most code change + a verification pass that WASM/ONNX outputs match tfjs-node within tolerance.

**Sequencing.** Stage 1 (done) unblocks deploying on a modern LTS today. Choose B (containerize) or Nix when moving to real prod infra; pursue C (WASM/ONNX) in parallel as the long-term path that makes B/Nix's Node-20 worker unnecessary for serving (training-only).

---

## Key Risks & Considerations

| Area                        | Detail                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SDK coupling**            | `eventPredictionApi.ts` spawns child processes (`npx tsx scripts/...`). Works in Node but not edge/serverless. Stick with Node preset.                                                                                                                                                                                                                                                             |
| **Effect TS**               | Already used in server libs. No migration needed. Could add `@effect/react` for client-side data fetching later.                                                                                                                                                                                                                                                                                   |
| **Better Auth scope**       | Net-new functionality. Current site has zero auth. Decide scope: auth-gated predictions? User accounts? Or just scaffolding?                                                                                                                                                                                                                                                                       |
| **Client JS volume**        | Prediction page has ~460 lines of math-heavy vanilla JS (Monte Carlo, caption intervals, z-scores). Ports cleanly to an XState + Effect machine (see new "State Management with XState + Effect" section). Pure logic in actions (delegating to Services), no DOM coupling. Machines + Effect programs are testable without React.                                                                 |
| **XState complexity**       | State machines add upfront modeling cost vs simple hooks. Payoff (per Sandro Maglione patterns): explicit state/event modeling, deterministic transitions, exhaustive test coverage of machines + Effect actions. Follow the recommended workflow (define machine + Effect actions delegating to Services → dumb React components using `useMachine` + `snapshot.matches`). Keep machines focused. |
| **Effect Schema**           | Runtime validation adds a thin layer over server fn inputs. Worth it for: catching malformed client data, self-documenting API contracts, and decoding external API responses. Don't over-validate — trust internal server-to-server calls.                                                                                                                                                        |
| **React Compiler**          | Auto-memoization eliminates manual `useMemo`/`useCallback`/`React.memo`. Enforces Rules of React at build time (errors on violations). Works seamlessly with XState hooks and Motion. Use `"use no memo"` directive to opt out of specific functions if needed.                                                                                                                                    |
| **Tailwind 4**              | CSS-first config (`@theme` in CSS) instead of `tailwind.config.js`. Color palette maps directly to CSS custom properties. Both ReUI and shadcn/ui v4 support this.                                                                                                                                                                                                                                 |
| **ReUI + shadcn**           | ReUI is built on shadcn/ui primitives. shadcn is the base layer (primitives), ReUI is the pattern layer (composed components). Both live in `app/components/ui/` and share the same `components.json`.                                                                                                                                                                                             |
| **ReUI Pro**                | Some advanced patterns (Data Grid, Kanban, File Upload) may require ReUI Pro. The free tier has 1003+ components which covers all current needs. Evaluate Pro if Data Grid is needed for event directory.                                                                                                                                                                                          |
| **Table complexity**        | The recap table has 15 columns with fixed widths, tabular-nums, and specific cell styling. ReUI **Table** provides styled patterns; custom Tailwind classes handle column widths and score formatting.                                                                                                                                                                                             |
| **Motion + SSR**            | Motion hydrates client-side only. Use `initial={false}` on server-rendered animated content to avoid hydration mismatches. `<AnimatePresence>` wrappers must be client-only.                                                                                                                                                                                                                       |
| **Motion performance**      | Layout animations on large lists (event grid, recap table rows) can be expensive. Use `layoutDependency` to limit re-layouts, and prefer `transform`/`opacity` animations over layout-triggering properties.                                                                                                                                                                                       |
| **Streaming boundaries**    | `<Suspense>` boundaries must be placed carefully — wrapping too much negates streaming benefits, wrapping too little creates visual fragmentation. Test with slow network throttling.                                                                                                                                                                                                              |
| **Motion + reduced motion** | `MotionConfig reducedMotion="user"` respects `prefers-reduced-motion`. All `layout` and entrance animations must gracefully degrade to instant transitions.                                                                                                                                                                                                                                        |
| **Hugeicons + shadcn/ReUI** | shadcn/ReUI components may import `lucide-react` internally. Override icon slots at the call site with Hugeicons. The `Icon` wrapper standardizes size/stroke. Tree-shaking keeps bundle small.                                                                                                                                                                                                    |
| **oklch theming**           | All colors use oklch for perceptual uniformity. Light/dark themes swap via `.dark` class overriding CSS variables. No hardcoded hex/rgb in components — every color is a token.                                                                                                                                                                                                                    |
| **Theme completeness**      | Audit every component to ensure no hardcoded colors leak through. ReUI/shadcn copy-paste components may need their internal color references updated to use token variables.                                                                                                                                                                                                                       |
| **Fate + custom source**    | Fate requires a custom source adapter to translate selection sets into Effect + libsql queries. More setup than TanStack Query for simple reads, but pays off for relational data (events → corps → scores). Use Fate for normalized reads, TanStack Start server functions for simple mutations.                                                                                                  |
| **Fate + XState boundary**  | Fate handles server data (normalized cache, selection sets). XState handles UI state (filters, modals, roll/reset). Don't duplicate: Fate caches server responses, XState machines consume Fate data via `useQuery`.                                                                                                                                                                               |

---

## File Mapping (Astro → TanStack Start)

```
src/layouts/Layout.astro              → app/routes/__root.tsx
src/pages/index.astro                 → app/routes/index.tsx
src/pages/events/2026/index.astro     → app/routes/events/2026/index.tsx
src/pages/events/2026/[slug]/
  prediction.astro                    → app/routes/events/2026/$slug/prediction.tsx
src/pages/api/events/2026/
  index.json.ts                       → app/lib/server-fns/event-directory.ts
  refresh.json.ts                     → app/lib/server-fns/event-directory.ts
src/pages/api/events/2026/[slug]/
  prediction.json.ts                  → app/lib/server-fns/event-prediction.ts
src/lib/eventPredictionApi.ts         → app/lib/event-prediction-api.ts
src/lib/eventDirectory.ts             → app/lib/event-directory.ts
src/components/Welcome.astro          → (deleted, unused)
astro.config.mjs                      → vite.config.ts
(none)                                → app/lib/auth.ts
(none)                                → app/lib/auth-client.ts
(none)                                → app/lib/motion.ts (MotionConfig provider)
(none)                                → app/lib/motion-variants.ts (shared animation variants)
(none)                                → app/lib/schemas.ts (Effect Schema definitions for server fn inputs)
(none)                                → app/components/icon.tsx (Hugeicons wrapper)
(none)                                → app/components/ui/* (ReUI + shadcn)
(none)                                → app/machines/prediction-machine.ts (XState machine)
(none)                                → app/machines/event-directory-machine.ts
(none)                                → app/machines/refresh-machine.ts
(none)                                → app/fate/server.ts (Fate server setup)
(none)                                → app/fate/custom-source.ts (Effect + libsql adapter)
(none)                                → app/fate/roots/event-root.ts
(none)                                → app/fate/roots/corps-root.ts
(none)                                → app/fate/roots/prediction-root.ts
(none)                                → app/fate/client.ts (Fate React client)
(none)                                → app/stores/theme-store.ts (@xstate/store)
(none)                                → app/stores/ui-store.ts (@xstate/store)
(none)                                → app/app.css (design tokens + oklch theme)
```
