import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setCorpsIdentity } from '@/lib/server-fns/fantasy';
import { uploadFantasyLogo } from '@/lib/server-fns/fantasy-media';
import { useAsyncAction, matchMessage } from '@/lib/use-async-action';
import { BusyButton } from '@/components/fantasy/busy-button';
import { PhotoUpload, imageFileToUploadBase64 } from '@/components/fantasy/photo-upload';

export type CorpsIdentityInitial = {
  corpsName?: string | null;
  showTitle?: string | null;
  color?: string | null;
  logoMediaId?: string | null;
};

/**
 * Brand a fantasy corps: name, show title, accent color, logo (plan §7.4). The
 * logo goes through the dedicated `uploadFantasyLogo` (NOT the wiki upload).
 * Calls `setCorpsIdentity` and invokes `onSaved` on success.
 */
export function CorpsIdentityForm({
  leagueId,
  initial,
  onSaved,
}: {
  leagueId: string;
  initial?: CorpsIdentityInitial;
  onSaved?: () => void;
}) {
  const [corpsName, setCorpsName] = useState(initial?.corpsName ?? '');
  const [showTitle, setShowTitle] = useState(initial?.showTitle ?? '');
  const [color, setColor] = useState(initial?.color ?? '#cc0000');
  const [logoMediaId, setLogoMediaId] = useState<string | null>(initial?.logoMediaId ?? null);

  // Throws on failure so PhotoUpload's machine reverts the preview + toasts the error.
  const uploadLogo = async (file: File) => {
    const dataBase64 = await imageFileToUploadBase64(file);
    const res = await uploadFantasyLogo({ data: { leagueId, dataBase64 } });
    setLogoMediaId(res.mediaId);
  };

  const save = useAsyncAction(
    async () => {
      await setCorpsIdentity({
        data: {
          leagueId,
          corpsName: corpsName.trim(),
          showTitle,
          color,
          logoMediaId: logoMediaId ?? undefined,
        },
      });
      onSaved?.();
    },
    (err) =>
      matchMessage(
        err,
        { 'name-taken': 'That corps name is already taken in this league.' },
        `Could not save: ${err.message}`
      )
  );

  const busy = save.busy;
  const error = save.error;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run();
      }}
      className="flex max-w-md flex-col gap-4"
    >
      <p className="text-sm text-muted-foreground">
        This is <strong>your team&apos;s</strong> identity — its name, color, and logo. (You&apos;ll
        draft the real drum corps during the draft.)
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="corpsName">Corps name</Label>
        <Input
          id="corpsName"
          value={corpsName}
          maxLength={40}
          required
          onChange={(e) => setCorpsName(e.target.value)}
          placeholder="e.g. Crimson Guard"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="showTitle">Show title</Label>
        <Input
          id="showTitle"
          value={showTitle}
          maxLength={80}
          onChange={(e) => setShowTitle(e.target.value)}
          placeholder="e.g. Echoes of Tomorrow"
        />
      </div>

      <div className="flex items-center gap-3">
        <Label htmlFor="color">Corps color</Label>
        <input
          id="color"
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="size-9 cursor-pointer rounded border border-border bg-transparent"
        />
        <span className="text-sm text-muted-foreground">{color}</span>
      </div>

      <PhotoUpload
        mediaId={logoMediaId}
        onFile={uploadLogo}
        alt="Corps logo"
        labels={{ empty: 'Upload logo', change: 'Change logo' }}
      />

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <BusyButton type="submit" busy={busy} disabled={corpsName.trim().length === 0}>
        Save corps identity
      </BusyButton>
    </form>
  );
}
