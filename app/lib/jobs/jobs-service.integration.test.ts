/**
 * Behavioral integration test for the PageantryJobs apply → applicants → status
 * flow. Mirrors `../fantasy/services/league-service.integration.test.ts`: a temp
 * libsql file pointed at by CONTRIBUTIONS_DB_URL, the schema created on a
 * `createClient({ url })` stub BEFORE the service is imported (so the service
 * wires `JobsSql` at the temp DB), then methods run via
 * `Effect.runPromise(Effect.flatMap(JobsService, …).pipe(Effect.provide(JobsServiceLive)))`.
 *
 * The tables are created here (not left to the contributions-db bootstrap)
 * because the bootstrap's `jobs_application` lacks the `status` column the
 * service reads/writes and the unique `(posting_id, applicant_user_id)` index
 * the dedup path depends on. Pre-creating with the real columns + index makes
 * the no-duplicates and status-pipeline assertions genuine.
 */
import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { Effect } from 'effect';
import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface PostingData {
  title: string;
  contentJson: string;
  remoteOk?: boolean;
  salaryMax?: number | null;
  expiresAt?: string | null;
}
interface ListFilters {
  status?: string;
  keyword?: string;
  work?: 'remote' | 'onsite';
  sort?: 'newest' | 'pay';
}

let JobsService: typeof import('./jobs-service').JobsService;
let JobsServiceLive: typeof import('./jobs-service').JobsServiceLive;
let db: Client;

const EMPLOYER = 'u-employer';
const APPLICANT = 'u-applicant';
const OTHER_EMPLOYER = 'u-other-employer';

const ctx = (userId: string) => ({
  now: new Date().toISOString(),
  authorId: userId,
  actorRole: 'user' as const,
});

const run = <A, E>(eff: Effect.Effect<A, E, import('./jobs-service').JobsService>) =>
  Effect.runPromise(eff.pipe(Effect.provide(JobsServiceLive)));

const createProfile = (userId: string, kind: string) =>
  run(Effect.flatMap(JobsService, (s) => s.createProfile(userId, kind, ctx(userId))));

const createPosting = (employerProfileId: string, userId: string, title: string) =>
  run(
    Effect.flatMap(JobsService, (s) =>
      s.createPosting(employerProfileId, { title, contentJson: '{}' }, ctx(userId))
    )
  );

const createPostingData = (
  employerProfileId: string,
  userId: string,
  data: PostingData
) => run(Effect.flatMap(JobsService, (s) => s.createPosting(employerProfileId, data, ctx(userId))));

const listPostings = (filters: ListFilters = {}) =>
  run(Effect.flatMap(JobsService, (s) => s.listPostings(filters)));

const deletePosting = (postingId: string, userId: string) =>
  run(Effect.flatMap(JobsService, (s) => s.deletePosting(postingId, ctx(userId))));

const bookmarkJob = (userId: string, postingId: string) =>
  run(Effect.flatMap(JobsService, (s) => s.bookmarkJob(userId, postingId)));

const applyToPosting = (postingId: string, applicantUserId: string, message?: string) =>
  run(Effect.flatMap(JobsService, (s) => s.applyToPosting(postingId, applicantUserId, message)));

const getApplicants = (postingId: string, employerProfileId: string) =>
  run(Effect.flatMap(JobsService, (s) => s.getApplicantsForPosting(postingId, employerProfileId)));

const setStatus = (applicationId: string, status: string, employerProfileId: string) =>
  run(Effect.flatMap(JobsService, (s) => s.setApplicationStatus(applicationId, status, employerProfileId)));

const profileIdOf = (userId: string) =>
  run(Effect.flatMap(JobsService, (s) => s.getProfileByUser(userId))).then((r) => {
    if (!r) throw new Error(`no profile for ${userId}`);
    return r.profile.profile_id;
  });

let employerProfileId: string;
let otherEmployerProfileId: string;
let postingId: string;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-service-it-'));
  process.env.CONTRIBUTIONS_DB_URL = `file:${path.join(dir, 'contrib.db')}`;

  // Build the schema the exercised methods touch on a stub BEFORE importing the
  // service. CREATE ... IF NOT EXISTS means these definitions win over the
  // contributions-db bootstrap, so jobs_application keeps its `status` column.
  const stub = createClient({ url: process.env.CONTRIBUTIONS_DB_URL });
  await stub.batch(
    [
      `CREATE TABLE IF NOT EXISTS "user" (
         id TEXT PRIMARY KEY, name TEXT, email TEXT, image TEXT, role TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS jobs_profile (
         profile_id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         slug TEXT NOT NULL,
         display_name TEXT NOT NULL DEFAULT 'User',
         headline TEXT,
         location TEXT,
         location_lat REAL,
         location_lng REAL,
         status TEXT NOT NULL DEFAULT 'draft',
         contact_email TEXT,
         contact_visibility TEXT NOT NULL DEFAULT 'private',
         links_json TEXT,
         notify_on_apply INTEGER NOT NULL DEFAULT 0,
         accepted_terms_version TEXT,
         zip TEXT,
         image_media_id TEXT,
         directory_opt_out INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS jobs_posting (
         posting_id TEXT PRIMARY KEY,
         employer_profile_id TEXT NOT NULL,
         slug TEXT NOT NULL,
         title TEXT NOT NULL,
         location TEXT,
         zip TEXT,
         location_lat REAL,
         location_lng REAL,
         remote_ok INTEGER NOT NULL DEFAULT 0,
         comp_text TEXT,
         salary_min INTEGER,
         salary_max INTEGER,
         apply_url TEXT,
         apply_email TEXT,
         content_json TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'draft',
         published_at TEXT,
         is_boosted INTEGER NOT NULL DEFAULT 0,
         boosted_until TEXT,
         expires_at TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS jobs_application (
         application_id TEXT PRIMARY KEY,
         posting_id TEXT NOT NULL,
         applicant_user_id TEXT NOT NULL,
         message TEXT,
         created_at TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'new'
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_application_unique
         ON jobs_application (posting_id, applicant_user_id)`,
      `CREATE TABLE IF NOT EXISTS jobs_bookmark (
         user_id TEXT NOT NULL,
         posting_id TEXT NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (user_id, posting_id)
       )`,
      `CREATE TABLE IF NOT EXISTS jobs_revision (
         revision_id TEXT PRIMARY KEY,
         target_kind TEXT NOT NULL,
         target_id TEXT NOT NULL,
         actor_user_id TEXT NOT NULL,
         actor_role TEXT NOT NULL,
         op TEXT NOT NULL,
         before_json TEXT,
         after_json TEXT,
         created_at TEXT NOT NULL
       )`,
      `INSERT INTO "user" (id, name, email, role) VALUES ('${EMPLOYER}', 'Employer Ed', 'ed@x.test', 'user')`,
      `INSERT INTO "user" (id, name, email, role) VALUES ('${APPLICANT}', 'Applicant Ann', 'ann@x.test', 'user')`,
      `INSERT INTO "user" (id, name, email, role) VALUES ('${OTHER_EMPLOYER}', 'Rival Rae', 'rae@x.test', 'user')`,
    ],
    'write'
  );

  // Importing the service after env is set wires JobsSql at the temp DB.
  ({ JobsService, JobsServiceLive } = await import('./jobs-service'));
  const { getContributionsDb } = await import('@/lib/contributions-db');
  db = await getContributionsDb();

  await createProfile(EMPLOYER, 'employer');
  await createProfile(OTHER_EMPLOYER, 'employer');
  employerProfileId = await profileIdOf(EMPLOYER);
  otherEmployerProfileId = await profileIdOf(OTHER_EMPLOYER);

  const posting = await createPosting(employerProfileId, EMPLOYER, 'Brass Tech');
  postingId = posting.postingId;

  await createProfile(APPLICANT, 'employee');
});

describe('JobsService apply → applicants → status flow', () => {
  it('surfaces an application to the posting owner with its message + applicant', async () => {
    await applyToPosting(postingId, APPLICANT, 'I am a great fit');

    const applicants = await getApplicants(postingId, employerProfileId);
    expect(applicants).toHaveLength(1);
    expect(applicants[0].message).toBe('I am a great fit');
    expect(applicants[0].applicant_user_id).toBe(APPLICANT);
    expect(applicants[0].display_name).toBe('User'); // seeded profile name
    expect(applicants[0].applicant_email).toBe('ann@x.test');
  });

  it('hides applicants from a different employer (read ownership guard)', async () => {
    const applicants = await getApplicants(postingId, otherEmployerProfileId);
    expect(applicants).toEqual([]);
  });

  it('does not create duplicate applications (INSERT OR IGNORE + unique index)', async () => {
    await applyToPosting(postingId, APPLICANT, 'second attempt');
    const applicants = await getApplicants(postingId, employerProfileId);
    expect(applicants).toHaveLength(1);
    // Original message survives — the second insert was ignored.
    expect(applicants[0].message).toBe('I am a great fit');
  });

  it('updates status for the owner and blocks a non-owner (write ownership guard)', async () => {
    const [{ application_id }] = await getApplicants(postingId, employerProfileId);

    await setStatus(application_id, 'shortlisted', employerProfileId);
    let row = (await getApplicants(postingId, employerProfileId))[0];
    expect(row.status).toBe('shortlisted');

    // Wrong owner — the guard scopes the UPDATE to the employer's own postings.
    await setStatus(application_id, 'passed', otherEmployerProfileId);
    row = (await getApplicants(postingId, employerProfileId))[0];
    expect(row.status).toBe('shortlisted');
  });
});

describe('JobsService listPostings expiry + filter + sort', () => {
  it('hides expired postings from the board', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const expired = await createPostingData(employerProfileId, EMPLOYER, {
      title: 'Expired Gig',
      contentJson: '{}',
      expiresAt: past,
    });
    const live = await createPostingData(employerProfileId, EMPLOYER, {
      title: 'Live Gig',
      contentJson: '{}',
      expiresAt: future,
    });

    const { rows, total } = await listPostings({ keyword: 'Gig' });
    const ids = rows.map((r) => r.posting_id);
    expect(ids).toContain(live.postingId);
    expect(ids).not.toContain(expired.postingId);
    expect(total).toBe(1);
  });

  it('filters by work=remote and sorts by pay descending', async () => {
    const remote = await createPostingData(employerProfileId, EMPLOYER, {
      title: 'Sortable Remote Role',
      contentJson: '{}',
      remoteOk: true,
      salaryMax: 90_000,
    });
    const onsite = await createPostingData(employerProfileId, EMPLOYER, {
      title: 'Sortable Onsite Role',
      contentJson: '{}',
      remoteOk: false,
      salaryMax: 120_000,
    });

    const remoteOnly = await listPostings({ work: 'remote', keyword: 'Sortable' });
    expect(remoteOnly.rows.map((r) => r.posting_id)).toEqual([remote.postingId]);

    const byPay = await listPostings({ sort: 'pay', keyword: 'Sortable Role'.split(' ')[0] });
    // Neither is boosted, so order is purely salary_max DESC: onsite (120k) then remote (90k).
    const payIds = byPay.rows.map((r) => r.posting_id);
    expect(payIds.indexOf(onsite.postingId)).toBeLessThan(payIds.indexOf(remote.postingId));
  });
});

describe('JobsService deletePosting cascade', () => {
  it('removes the posting plus its applications and bookmarks', async () => {
    const posting = await createPostingData(employerProfileId, EMPLOYER, {
      title: 'Doomed Posting',
      contentJson: '{}',
    });

    await applyToPosting(posting.postingId, APPLICANT, 'pick me');
    await bookmarkJob(APPLICANT, posting.postingId);

    // Sanity: rows exist before delete.
    const appsBefore = await db.execute({
      sql: 'SELECT count(*) AS c FROM jobs_application WHERE posting_id = ?',
      args: [posting.postingId],
    });
    expect(Number(appsBefore.rows[0].c)).toBe(1);

    await deletePosting(posting.postingId, EMPLOYER);

    const { rows } = await listPostings({ keyword: 'Doomed' });
    expect(rows.map((r) => r.posting_id)).not.toContain(posting.postingId);

    const apps = await db.execute({
      sql: 'SELECT count(*) AS c FROM jobs_application WHERE posting_id = ?',
      args: [posting.postingId],
    });
    expect(Number(apps.rows[0].c)).toBe(0);

    const bookmarks = await db.execute({
      sql: 'SELECT count(*) AS c FROM jobs_bookmark WHERE posting_id = ?',
      args: [posting.postingId],
    });
    expect(Number(bookmarks.rows[0].c)).toBe(0);
  });
});
