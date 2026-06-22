import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setCorpsIdentity } from '@/lib/server-fns/fantasy';
import { uploadFantasyLogo } from '@/lib/server-fns/fantasy-media';
import { useAsyncAction, matchMessage } from '@/lib/use-async-action';

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });

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

  const upload = useAsyncAction(
    async (file: File) => {
      const dataBase64 = await fileToBase64(file);
      const res = await uploadFantasyLogo({ data: { leagueId, dataBase64 } });
      setLogoMediaId(res.mediaId);
    },
    (err) => `Logo upload failed: ${err.message}`
  );

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

  const busy = upload.busy || save.busy;
  const error = save.error ?? upload.error;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run();
      }}
      className="flex max-w-md flex-col gap-4"
    >
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
        <Label htmlFor="color">Accent color</Label>
        <input
          id="color"
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="size-9 cursor-pointer rounded border border-border bg-transparent"
        />
        <span className="text-sm text-muted-foreground">{color}</span>
      </div>

      <div className="flex items-center gap-3">
        {logoMediaId ? (
          <img
            src={`/api/fantasy-media/${logoMediaId}`}
            alt="Corps logo"
            className="size-12 rounded object-contain"
          />
        ) : null}
        <label className="cursor-pointer">
          <span className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted">
            {upload.busy ? 'Uploading…' : logoMediaId ? 'Change logo' : 'Upload logo'}
          </span>
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload.run(file);
            }}
          />
        </label>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Button type="submit" disabled={busy || corpsName.trim().length === 0}>
        {save.busy ? 'Saving…' : 'Save corps identity'}
      </Button>
    </form>
  );
}
