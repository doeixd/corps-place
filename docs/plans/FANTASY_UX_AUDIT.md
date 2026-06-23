# Fantasy DCI — end-to-end UX audit

> A full-journey review of the Fantasy DCI experience: create a league → edit
> settings → get invited → create an account → name a corps → take the quiz →
> get notified → engage with the draft → see standings → get updates. Audited as
> a real user (including a newcomer who has never heard of fantasy drum corps).
>
> Status tags: ✅ already shipped on `feat/fantasy-ux` this pass · ⚠️ gap (with
> priority). Cross-references the UI/UX plan (`FANTASY_UI_UX_IMPROVEMENT_PLAN.md`).

---

## The through-line problem

Three issues repeat at **every** stage and are the highest-leverage fixes:

1. **No concept explanation at the top of the funnel.** The landing, create, and
   join pages all assume you already know what fantasy drum corps *is*. A cold
   invite link goes straight to "Continue with Google" with zero "what am I
   joining?".
2. **Weak "what happens next" hand-offs.** Every transition (create → ?, join → ?,
   quiz-done → ?, scheduled → live) drops the user without telling them what to do
   or when.
3. **Unexplained jargon** — captions (`GE1 / GE2 / VP / VA / CG / MB / MA / MP`),
   "seeding," "recap," "World/Open." No glossary. The plan's `<Explain>` primitive
   (§3) was specced but never built.

---

## Stage-by-stage

### 1. Discover — `/fantasy` landing
- **Good:** logged-out vs. logged-in CTAs; a one-line value prop; league cards.
- ⚠️ **High:** no "what is this / how it works." A newcomer has no mental model.
  Needs a 3-sentence concept + a 4-step **Create → Invite → Quiz → Draft →
  Standings** visual (specced in plan §3.1, unbuilt).
- ⚠️ **Low:** the empty state ("create one to get started") assumes understanding.

### 2. Create a league — `/fantasy/create`
- **Good:** two fields only, season pre-filled, auto-navigates to the league after.
- ⚠️ **Med:** "Season" is unexplained (does it lock corps to a year?); no "you'll
  invite + draft next" framing; lands silently on the dashboard with no "now invite
  people" nudge.
- ✅ The dashboard it lands on now has status narration + tab nav + the inline
  settings section + the default share link.

### 3. Edit settings
- ✅ Inline `LeagueSettings` section (not a modal); real `LeagueConfig` editing;
  draft-shape fields lock once the draft starts.
- ⚠️ **Low:** field-level help (what "reverse weighting" / "scoring mode" mean) — an
  `<Explain>` consumer.

### 4. Invite
- ✅ Default share link (no button); "anyone who opens it can join… each person joins
  once" explainer; Copy + native Share; usage count.
- ⚠️ **Low:** the link doesn't show *who* invited or the draft date.

### 5. Get invited / join — `/fantasy/join/$token`
- **Good:** the token survives the OAuth round-trip; member count/cap shown; clear
  invalid / expired / used-up / closed states.
- ⚠️ **High:** **zero "what joining means."** Before "Continue with Google" it should
  say: "You'll name a corps, take a quick quiz, then draft real drum corps." No owner
  name, no draft date, and a silent redirect to the dashboard on success (no "here's
  step 1").

### 6. Create an account
- **Good:** one-click Google, minimal friction, returns to the exact invite.
- ⚠️ **Med:** the commitment ask is uninvited — no "why" before the OAuth dialog.

### 7. Name your corps
- ✅ `<PhotoUpload>` refactor; the identity form gates the dashboard ("Name your
  corps" card).
- ⚠️ **Low:** doesn't distinguish *your team's* identity from the real corps you'll
  draft (a confusion the create-flow review flagged too).

### 8. Take the quiz — `/fantasy/$slug/quiz`
- **Good:** "one timed attempt, sets your seeding" upfront; all-answered validation;
  countdown; clean error states.
- ⚠️ **Med:** no **progress** ("Q5 of 10"); no time estimate; "seeding" is jargon (say
  "higher score → pick earlier"); **dead-end on completion** — "this sets your
  seeding" but not *when the draft is* or what to do now; a returning user sees an
  old score with no date or next step.

### 9. Get notified of the draft
- **Good:** email reminders at T-60 and T-10 (`jobs.ts`); grouped digests (no spam).
- ⚠️ **High:** **channel coverage is lopsided.** Push fires for **on-clock only**
  (`DraftService.notifyOnClock → sendPushToUser`); reminders are **email-only**; and
  there's **nothing** for "draft is live now," "you're up next," "your pick was
  auto-made," "draft complete," "quiz is open," or "draft scheduled." This is exactly
  the **plan §12.4 notification matrix** (designed, not built). The push opt-in is
  labeled "draft alerts" but only delivers on-clock + (email) reminders — a mismatch.
- ✅ The push toggle is now hidden unless VAPID is configured (no more dead button).

### 10. Be informed of the process
- ✅ Per-phase **status narration** on the dashboard + `aria-live` turn
  announcements + the on-clock banner with round/pick progress.
- ⚠️ **Med:** narration lives only on the dashboard — the quiz, join, and standings
  pages don't tell you "what's happening / what's next."

### 11. Engage with the draft — `/fantasy/$slug/draft`
- ✅ **Big:** compact **logo board** (rows = participants, tooltips); inline **section
  picker** (caption tabs, corps by prior-season rank, taken grayed); collapsible
  board; on-clock banner; completion → final board + standings link; **draft-queue
  editor** (auto-pick wishlist) in the drawer; and the **eligible-pool fix** (only
  corps actually competing, World/Open).
- ⚠️ **Low:** no pre-draft **order preview**; no "up next" peek; an auto-pick that
  fires isn't yet announced to the picked member (ties to §12.4).

### 12. See standings — `/fantasy/$slug/standings`
- **Good:** rank/total prominent; logos + color; live/final indicator; empty-state
  explained; live updates.
- ⚠️ **High:** the caption headers (`GE1 … MP`) have **no legend**; **no explanation
  of how scoring works / the scale**; no "updated after which recap / when"; and
  **mobile is 11+ columns** — it needs the same compact treatment the draft board got
  (rank | corps | total, tap to expand the per-caption breakdown).

### 13. Get notified of updates
- **Good:** standings + season-complete email digests; a resilient cron queue.
- ⚠️ **Med:** notifications are gated league-wide by `config.notify.email` with no
  **per-user** opt-out; subjects are generic (don't say which recap); no push for
  standings movement.

---

## Prioritized punch list

**P0 — comprehension (cheap, highest impact)**
1. Landing "what is this + how it works" strip (§3.1).
2. Join page: "what joining means" + a post-join step-1 (§4.7).
3. An `<Explain>` / glossary primitive → caption legend on standings + the quiz
   "seeding" wording + settings help (§3).

**P1 — the notification matrix (§12.4, already designed)**
4. A unified `NotificationService.emit`: push **and** email for draft-scheduled /
   live / up-next / auto-picked / complete; per-user prefs. The single biggest
   functional gap.

**P2 — surface polish**
5. Standings: a scoring explainer + "updated after X" + a **mobile-compact** layout.
6. Quiz: a progress indicator + a concrete completion next-step ("draft is {date}").
7. Create / identity: "what's next" framing + team-vs-real-corps clarity.

**P3 — nice-to-haves**
8. Pre-draft order preview; richer invite metadata; push success confirmation.

---

## Verdict

The **engagement core is strong** — the draft room, logo board, queue, and settings
all landed this pass and hold up. The **edges are thin**: the top of the funnel
doesn't teach the game, the hand-offs between stages are silent, and notifications
only cover a single moment. The cheapest wins are **P0** (comprehension copy + the
glossary primitive); the biggest functional win is **P1** (the §12.4 notification
matrix, already designed).
