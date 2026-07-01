import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Icon } from '@/components/icon';
import { NoteEditIcon } from '@/components/icons/generated';
import {
  saveProfileField,
  setProfilePhoto,
  deleteProfile,
  mergeProfiles,
} from '@/lib/server-fns/profile-owner';
// Reuse the league photo uploader (optimistic preview + auto-orient/downscale +
// error-reverting state machine) so profile photos match that UX.
import { PhotoUpload, imageFileToUploadBase64 } from '@/components/fantasy/photo-upload';
import { getCorpsDirectory } from '@/lib/server-fns/hybrid';
import {
  awardKey,
  performedKey,
  assignmentKey,
  diffCollectionOps,
  type AwardItem,
  type PerformedItem,
  type AssignmentItem,
} from '@/lib/profile-owner/merge';

// The canonical section/role vocabulary (from the live staff data) for the
// assignment section dropdown, so owners fix a caption with a controlled value.
const ROLE_TYPES = [
  'brass', 'percussion', 'visual', 'guard', 'drum-major', 'design',
  'music', 'director', 'admin', 'audio', 'medical', 'media', 'other',
] as const;

/**
 * Owner field editor for a claimed staff/judge profile (plan §6 scope: bio, photo,
 * hometown, current position — scraped competitive record stays authoritative).
 * Rendered by the route only when the viewer holds the active claim
 * (`ownership.mine && ownership.claimed`). Each field saves independently via the
 * owner-gated server-fns, then invalidates the loader so the merge re-applies.
 */
export function ProfileEditor({
  entityType,
  entityId,
  initial,
  scraped,
}: {
  entityType: 'staff' | 'judge';
  entityId: string;
  initial: {
    displayName: string | null;
    biography: string | null;
    photoUrl: string | null;
    hometown: string | null;
    currentPosition: { title: string; org: string } | null;
    awards?: readonly AwardItem[];
    performed?: readonly PerformedItem[];
    assignments?: readonly AssignmentItem[];
  };
  /** Scraped baselines for the collection editors — the editor diffs its edited
   *  list against these to build the durable op-log (never the merged list). Each
   *  is optional so a route can enable only some collections (judges: awards only,
   *  since their event/caption record is score-derived and off-limits). A section
   *  renders iff its baseline is provided. */
  scraped?: {
    awards?: readonly AwardItem[];
    performed?: readonly PerformedItem[];
    assignments?: readonly AssignmentItem[];
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(initial.displayName ?? '');
  const [bio, setBio] = useState(initial.biography ?? '');
  const [hometown, setHometown] = useState(initial.hometown ?? '');
  const [posTitle, setPosTitle] = useState(initial.currentPosition?.title ?? '');
  const [posOrg, setPosOrg] = useState(initial.currentPosition?.org ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [mergeId, setMergeId] = useState('');
  // Editable collections (P1). Copy so local edits don't alias the loader data.
  const [awards, setAwards] = useState<AwardItem[]>(() =>
    (initial.awards ?? []).map((a) => ({ ...a }))
  );
  const [performed, setPerformed] = useState<PerformedItem[]>(() =>
    (initial.performed ?? []).map((p) => ({ ...p }))
  );
  const awardsDirty = JSON.stringify(awards) !== JSON.stringify(initial.awards ?? []);
  const performedDirty = JSON.stringify(performed) !== JSON.stringify(initial.performed ?? []);
  const [assignments, setAssignments] = useState<AssignmentItem[]>(() =>
    (initial.assignments ?? []).map((a) => ({ ...a }))
  );
  const assignmentsDirty =
    JSON.stringify(assignments) !== JSON.stringify(initial.assignments ?? []);
  const setAsn = (i: number, patch: Partial<AssignmentItem>) =>
    setAssignments((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  // Add-an-assignment at ANY corps (P2b): a search combobox over the corps
  // directory, fetched LAZILY on first focus (an event handler, not a mount
  // effect — the directory shouldn't load on every profile view).
  const [corpsQuery, setCorpsQuery] = useState('');
  const [corpsList, setCorpsList] = useState<
    { corps_key: string; name: string; slug: string | null }[] | null
  >(null);
  const [loadingCorps, setLoadingCorps] = useState(false);
  const loadCorps = () => {
    if (corpsList !== null || loadingCorps) return;
    setLoadingCorps(true);
    getCorpsDirectory()
      .then((rows) =>
        setCorpsList(
          (rows as { corps_key: string; name: string; slug: string | null }[]).map((c) => ({
            corps_key: c.corps_key,
            name: c.name,
            slug: c.slug,
          }))
        )
      )
      .catch(() => setCorpsList([]))
      .finally(() => setLoadingCorps(false));
  };
  const corpsMatches = (() => {
    const q = corpsQuery.trim().toLowerCase();
    if (!q || !corpsList) return [];
    return corpsList.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  })();
  const addAssignmentForCorps = (c: { corps_key: string; name: string; slug: string | null }) => {
    setAssignments((list) => [
      ...list,
      {
        corps_key: c.corps_key,
        corps_name: c.name,
        corps_slug: c.slug,
        season: null,
        title: null,
        role_type: null,
        start_year: null,
        end_year: null,
      },
    ]);
    setCorpsQuery('');
  };
  const yearOrNull = (raw: string) => {
    const t = raw.trim();
    const n = Number(t);
    return t && Number.isFinite(n) ? n : null;
  };
  // Group assignment rows by corps (matching the profile display), keeping each
  // row's flat index so edit/remove still address the underlying list.
  const assignmentGroups = (() => {
    const groups = new Map<
      string,
      { corps_name: string; items: { a: AssignmentItem; i: number }[] }
    >();
    assignments.forEach((a, i) => {
      const g = groups.get(a.corps_key) ?? { corps_name: a.corps_name, items: [] };
      g.items.push({ a, i });
      groups.set(a.corps_key, g);
    });
    return [...groups.values()];
  })();

  const onMerge = async () => {
    const other = mergeId.trim();
    if (!other) return;
    if (!confirm(`Merge profile "${other}" into this one? Its page will redirect here. You must own both.`))
      return;
    setBusy('merge');
    try {
      await mergeProfiles({
        data: { canonicalType: entityType, canonicalId: entityId, mergedType: entityType, mergedId: other },
      });
      toast.success('Profiles merged — the other page now redirects here.');
      setMergeId('');
      await router.invalidate();
    } catch {
      toast.error('Could not merge — make sure you own both profiles and the id is correct.');
    } finally {
      setBusy(null);
    }
  };

  const save = async (label: string, fieldKey: string, content: unknown) => {
    setBusy(label);
    try {
      await saveProfileField({ data: { entityType, entityId, fieldKey, content } });
      toast.success('Saved.');
      await router.invalidate();
    } catch {
      toast.error('Could not save your change.');
    } finally {
      setBusy(null);
    }
  };

  // Persist a collection edit as the durable op-log (diff vs the SCRAPED baseline,
  // not the merged list — so re-scrapes still surface new items). Drops empty rows.
  const saveCollection = async <T,>(
    label: string,
    fieldKey: 'awards' | 'performed' | 'assignments',
    scrapedList: readonly T[],
    edited: readonly T[],
    keyOf: (i: T) => string,
    isEmpty: (i: T) => boolean
  ) => {
    const cleaned = edited.filter((i) => !isEmpty(i));
    const ops = diffCollectionOps(scrapedList, cleaned, keyOf);
    await save(label, fieldKey, { ops });
  };

  // Persist a chosen photo. Rethrows on failure so PhotoUpload's machine reverts the
  // optimistic preview and toasts. imageFileToUploadBase64 orients + downscales first.
  const onPhotoFile = async (file: File) => {
    const dataBase64 = await imageFileToUploadBase64(file);
    await setProfilePhoto({ data: { entityType, entityId, dataBase64 } });
    await router.invalidate();
  };

  const onDelete = async () => {
    if (
      !confirm(
        'Permanently remove this profile from the site? This revokes your claim and removes the page, and future data updates will not bring it back. This cannot be easily undone.'
      )
    )
      return;
    setBusy('delete');
    try {
      await deleteProfile({ data: { entityType, entityId } });
      toast.success('Profile removal requested — it will disappear from the site shortly.');
      setOpen(false);
      await router.invalidate();
    } catch {
      toast.error('Could not remove the profile.');
    } finally {
      setBusy(null);
    }
  };

  const removePhoto = async () => {
    setBusy('photo');
    try {
      await setProfilePhoto({ data: { entityType, entityId, dataBase64: null } });
      toast.success('Photo removed.');
      await router.invalidate();
    } catch {
      toast.error('Could not remove the photo.');
    } finally {
      setBusy(null);
    }
  };

  // Per-field dirty detection: disable a Save until its value changes, and warn on
  // close if anything is unsaved.
  const nameDirty = displayName.trim() !== (initial.displayName ?? '');
  const bioDirty = bio !== (initial.biography ?? '');
  const homeDirty = hometown !== (initial.hometown ?? '');
  const posDirty =
    posTitle !== (initial.currentPosition?.title ?? '') ||
    posOrg !== (initial.currentPosition?.org ?? '');
  const anyDirty =
    nameDirty ||
    bioDirty ||
    homeDirty ||
    posDirty ||
    awardsDirty ||
    performedDirty ||
    assignmentsDirty;
  const closeEditor = () => {
    if (anyDirty && !confirm('You have unsaved changes. Close without saving them?')) return;
    setOpen(false);
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Icon icon={NoteEditIcon} size="sm" />
        Edit your profile
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Edit your profile</h3>
        <Button variant="ghost" size="sm" onClick={closeEditor}>
          Done
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="po-name">Display name</Label>
        <Input
          id="po-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          The name shown on your profile. The page URL stays the same.
        </span>
        <BusyButton
          busy={busy === 'name'}
          size="sm"
          className="self-start"
          disabled={!nameDirty || !displayName.trim()}
          onClick={() => void save('name', 'display_name', displayName.trim())}
        >
          Save name
        </BusyButton>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Photo</Label>
        <div className="flex items-center gap-3">
          <PhotoUpload
            imageUrl={initial.photoUrl}
            onFile={onPhotoFile}
            shape="round"
            size="size-16"
            alt=""
            labels={{ empty: 'Add a photo', change: 'Change photo' }}
          />
          {initial.photoUrl && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy === 'photo'}
              onClick={() => void removePhoto()}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="po-bio">Biography</Label>
        <textarea
          id="po-bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={5}
          className="w-full rounded-md border border-input bg-transparent p-2 text-sm"
        />
        <BusyButton
          busy={busy === 'bio'}
          size="sm"
          className="self-start"
          disabled={!bioDirty}
          onClick={() => void save('bio', 'biography', { plain: bio })}
        >
          Save bio
        </BusyButton>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="po-home">Hometown</Label>
        <Input id="po-home" value={hometown} onChange={(e) => setHometown(e.target.value)} />
        <BusyButton
          busy={busy === 'home'}
          size="sm"
          className="self-start"
          disabled={!homeDirty}
          onClick={() => void save('home', 'hometown', hometown)}
        >
          Save hometown
        </BusyButton>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Current position</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input placeholder="Title" value={posTitle} onChange={(e) => setPosTitle(e.target.value)} />
          <Input placeholder="Organization" value={posOrg} onChange={(e) => setPosOrg(e.target.value)} />
        </div>
        <BusyButton
          busy={busy === 'pos'}
          size="sm"
          className="self-start"
          disabled={!posDirty || !posTitle.trim() || !posOrg.trim()}
          onClick={() => void save('pos', 'current_position', { title: posTitle.trim(), org: posOrg.trim() })}
        >
          Save position
        </BusyButton>
      </div>

      {/* Collection editors (P1) — only when the route supplies the scraped baseline
          to diff against (staff today; judges follow in P4). */}
      {scraped && (
        <>
      {/* Awards (P1) — owner CRUD, stored as a durable op-log over the scraped list. */}
      {scraped.awards !== undefined && (
      <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <Label>Awards</Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAwards((a) => [...a, { name: '', year: null }])}
          >
            + Add award
          </Button>
        </div>
        {awards.length === 0 ? (
          <p className="text-xs text-muted-foreground">No awards yet.</p>
        ) : (
          awards.map((a, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                placeholder="Award name"
                value={a.name}
                onChange={(e) =>
                  setAwards((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
                className="flex-1"
              />
              <Input
                placeholder="Year"
                type="number"
                value={a.year ?? ''}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const n = Number(raw);
                  const year = raw && Number.isFinite(n) ? n : null;
                  setAwards((list) => list.map((x, j) => (j === i ? { ...x, year } : x)));
                }}
                className="w-20"
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Remove award"
                onClick={() => setAwards((list) => list.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          ))
        )}
        <BusyButton
          busy={busy === 'awards'}
          size="sm"
          className="self-start"
          disabled={!awardsDirty}
          onClick={() =>
            void saveCollection('awards', 'awards', scraped?.awards ?? [], awards, awardKey, (a) => !a.name.trim())
          }
        >
          Save awards
        </BusyButton>
      </div>
      )}

      {/* Also-performed-with (P1) — non-DCI groups / corps the person marched in. */}
      {scraped.performed !== undefined && (
      <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <Label>Also performed with</Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPerformed((p) => [...p, { group: '', startYear: null, endYear: null }])}
          >
            + Add group
          </Button>
        </div>
        {performed.length === 0 ? (
          <p className="text-xs text-muted-foreground">No groups yet.</p>
        ) : (
          performed.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                placeholder="Group / corps"
                value={p.group}
                onChange={(e) =>
                  setPerformed((list) => list.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)))
                }
                className="flex-1"
              />
              <Input
                placeholder="From"
                type="number"
                value={p.startYear ?? ''}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const n = Number(raw);
                  const startYear = raw && Number.isFinite(n) ? n : null;
                  setPerformed((list) => list.map((x, j) => (j === i ? { ...x, startYear } : x)));
                }}
                className="w-16"
              />
              <Input
                placeholder="To"
                type="number"
                value={p.endYear ?? ''}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const n = Number(raw);
                  const endYear = raw && Number.isFinite(n) ? n : null;
                  setPerformed((list) => list.map((x, j) => (j === i ? { ...x, endYear } : x)));
                }}
                className="w-16"
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Remove group"
                onClick={() => setPerformed((list) => list.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          ))
        )}
        <BusyButton
          busy={busy === 'performed'}
          size="sm"
          className="self-start"
          disabled={!performedDirty}
          onClick={() =>
            void saveCollection('performed', 'performed', scraped?.performed ?? [], performed, performedKey, (p) => !p.group.trim())
          }
        >
          Save groups
        </BusyButton>
      </div>
      )}

      {/* Assignments (P2) — correct the noisy scraped record: fix a section/title/
          season/years or remove a misattribution; add a row at ANY corps via the
          search combobox (P2b). */}
      {scraped.assignments !== undefined && (
      <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-3">
        <Label>Assignments</Label>
        {/* Add at any corps — lazy directory search. */}
        <div className="relative">
          <Input
            placeholder="Add a corps…"
            value={corpsQuery}
            onFocus={loadCorps}
            onChange={(e) => {
              setCorpsQuery(e.target.value);
              loadCorps();
            }}
            className="text-sm"
          />
          {corpsQuery.trim() && (
            <div className="themed-scrollbar mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border bg-background p-1">
              {corpsList === null ? (
                <p className="px-1 py-1 text-xs text-muted-foreground">Loading corps…</p>
              ) : corpsMatches.length === 0 ? (
                <p className="px-1 py-1 text-xs text-muted-foreground">No matches.</p>
              ) : (
                corpsMatches.map((c) => (
                  <button
                    key={c.corps_key}
                    type="button"
                    onClick={() => addAssignmentForCorps(c)}
                    className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-accent hover:text-foreground"
                  >
                    {c.name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        {assignments.length === 0 ? (
          <p className="text-xs text-muted-foreground">No assignments.</p>
        ) : (
          assignmentGroups.map((g) => (
            <div key={g.items[0].a.corps_key} className="rounded-md border border-border p-1.5">
              <div className="mb-1 px-0.5 text-sm font-semibold text-text-primary">{g.corps_name}</div>
              <div className="flex flex-col gap-1">
                {g.items.map(({ a, i }) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5">
                    <Input
                      placeholder="Season"
                      value={a.season ?? ''}
                      onChange={(e) => setAsn(i, { season: e.target.value || null })}
                      className="w-16"
                    />
                    <select
                      value={a.role_type ?? ''}
                      onChange={(e) => setAsn(i, { role_type: e.target.value || null })}
                      aria-label="Section"
                      className="rounded-md border border-border bg-background px-1.5 py-1.5 text-sm"
                    >
                      <option value="">section…</option>
                      {ROLE_TYPES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <Input
                      placeholder="Title"
                      value={a.title ?? ''}
                      onChange={(e) => setAsn(i, { title: e.target.value || null })}
                      className="w-32 flex-1"
                    />
                    <Input
                      placeholder="From"
                      type="number"
                      value={a.start_year ?? ''}
                      onChange={(e) => setAsn(i, { start_year: yearOrNull(e.target.value) })}
                      className="w-16"
                    />
                    <Input
                      placeholder="To"
                      type="number"
                      value={a.end_year ?? ''}
                      onChange={(e) => setAsn(i, { end_year: yearOrNull(e.target.value) })}
                      className="w-16"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Remove assignment"
                      onClick={() => setAssignments((list) => list.filter((_, j) => j !== i))}
                    >
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
        <BusyButton
          busy={busy === 'assignments'}
          size="sm"
          className="self-start"
          disabled={!assignmentsDirty}
          onClick={() =>
            void saveCollection(
              'assignments',
              'assignments',
              scraped?.assignments ?? [],
              assignments,
              assignmentKey,
              (a) => !a.corps_key
            )
          }
        >
          Save assignments
        </BusyButton>
      </div>
      )}
        </>
      )}

      <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-3">
        <Label>Merge another profile into this one</Label>
        <span className="text-xs text-muted-foreground">
          If you’re split across two pages, enter the other profile’s id (you must own both). It will
          redirect here.
        </span>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="other profile id"
            value={mergeId}
            onChange={(e) => setMergeId(e.target.value)}
          />
          <BusyButton
            busy={busy === 'merge'}
            size="sm"
            variant="outline"
            className="self-start"
            disabled={!mergeId.trim()}
            onClick={() => void onMerge()}
          >
            Merge into this
          </BusyButton>
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">
          Remove this profile from the site (revokes your claim; won’t be recreated by future updates).
        </span>
        <BusyButton
          busy={busy === 'delete'}
          size="sm"
          variant="destructive"
          className="self-start"
          onClick={() => void onDelete()}
        >
          Delete this profile
        </BusyButton>
      </div>
    </div>
  );
}
