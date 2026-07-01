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
import {
  awardKey,
  performedKey,
  diffCollectionOps,
  type AwardItem,
  type PerformedItem,
} from '@/lib/profile-owner/merge';

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
    biography: string | null;
    photoUrl: string | null;
    hometown: string | null;
    currentPosition: { title: string; org: string } | null;
    awards?: readonly AwardItem[];
    performed?: readonly PerformedItem[];
  };
  /** Scraped baselines for the collection editors — the editor diffs its edited
   *  list against these to build the durable op-log (never the merged list). */
  scraped?: {
    awards: readonly AwardItem[];
    performed: readonly PerformedItem[];
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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
    fieldKey: 'awards' | 'performed',
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
  const bioDirty = bio !== (initial.biography ?? '');
  const homeDirty = hometown !== (initial.hometown ?? '');
  const posDirty =
    posTitle !== (initial.currentPosition?.title ?? '') ||
    posOrg !== (initial.currentPosition?.org ?? '');
  const anyDirty = bioDirty || homeDirty || posDirty;
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

      {/* Also-performed-with (P1) — non-DCI groups / corps the person marched in. */}
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
