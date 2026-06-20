import { useState } from 'react';
import { uploadShowMedia, type UploadResult } from '@/lib/server-fns/media';

/**
 * Image upload drop-zone (M5). Reads the file → base64 → the auth-gated
 * `uploadShowMedia` fn (sharp→WebP→R2→show_media) → hands back the served ref.
 * Used by gallery / uniform / props image areas.
 */
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });

export function ImageDrop({
  corpsKey,
  season,
  kind = 'image',
  onUploaded,
}: {
  corpsKey: string;
  season: string;
  kind?: string;
  onUploaded: (r: UploadResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image`);
        const dataBase64 = await fileToBase64(file);
        const res = await uploadShowMedia({
          data: { corpsKey, season, kind, alt: '', dataBase64 },
        });
        onUploaded(res);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <label
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void handleFiles(e.dataTransfer.files);
      }}
      className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-foreground/20 p-4 text-center text-sm text-text-secondary hover:border-primary/50"
    >
      <input
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        disabled={busy}
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <span>{busy ? 'Uploading…' : 'Drop an image here, or click to choose'}</span>
      {error ? <span className="text-destructive">{error}</span> : null}
    </label>
  );
}
