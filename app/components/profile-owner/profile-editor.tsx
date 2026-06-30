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

/** File → base64 (strip the data: prefix), same as contrib/image-drop. */
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });

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
}: {
  entityType: 'staff' | 'judge';
  entityId: string;
  initial: {
    biography: string | null;
    photoUrl: string | null;
    hometown: string | null;
    currentPosition: { title: string; org: string } | null;
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

  const onPhoto = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file.');
      return;
    }
    if (file.size > 16 * 1024 * 1024) {
      toast.error('Image is too large — please choose one under 16 MB.');
      return;
    }
    setBusy('photo');
    try {
      const dataBase64 = await fileToBase64(file);
      await setProfilePhoto({ data: { entityType, entityId, dataBase64 } });
      toast.success('Photo updated.');
      await router.invalidate();
    } catch {
      toast.error('Photo upload failed — try a JPG or PNG under 16 MB.');
    } finally {
      setBusy(null);
    }
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
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Done
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Photo</Label>
        <div className="flex items-center gap-3">
          {initial.photoUrl && (
            <img
              src={initial.photoUrl}
              alt=""
              className="h-10 w-10 rounded-full object-cover"
            />
          )}
          <input
            type="file"
            accept="image/*"
            disabled={busy === 'photo'}
            // Reset value so re-selecting the SAME file still fires onChange.
            onChange={(e) => {
              void onPhoto(e.target.files);
              e.target.value = '';
            }}
            className="text-sm"
          />
          {busy === 'photo' && <span className="text-xs text-muted-foreground">Uploading…</span>}
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
          disabled={!posTitle.trim() || !posOrg.trim()}
          onClick={() => void save('pos', 'current_position', { title: posTitle.trim(), org: posOrg.trim() })}
        >
          Save position
        </BusyButton>
      </div>

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
