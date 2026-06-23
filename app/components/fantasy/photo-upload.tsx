/**
 * Reusable image picker for fantasy media (corps logos, league images). Shows a
 * preview (or an empty placeholder) plus a styled file button; hands the chosen
 * File to `onFile`. Upload/persistence is the caller's concern — this component
 * only previews `mediaId` (served from /api/fantasy-media/$id) and reports files.
 */

/** Read a File to bare base64 (no data: prefix) for the upload server-fns. */
export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });

export function PhotoUpload({
  mediaId,
  onFile,
  busy = false,
  shape = 'square',
  size = 'size-12',
  labels,
  alt = '',
}: {
  mediaId?: string | null;
  onFile: (file: File) => void | Promise<void>;
  busy?: boolean;
  shape?: 'square' | 'round';
  /** Tailwind size utility for the preview box (default size-12). */
  size?: string;
  labels?: { empty: string; change: string };
  alt?: string;
}) {
  const radius = shape === 'round' ? 'rounded-full' : 'rounded';
  return (
    <div className="flex items-center gap-3">
      {mediaId ? (
        <img
          src={`/api/fantasy-media/${mediaId}`}
          alt={alt}
          className={`${size} ${radius} border border-border object-contain`}
        />
      ) : (
        <div className={`${size} ${radius} bg-muted`} />
      )}
      <label className="cursor-pointer">
        <span className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted">
          {busy
            ? 'Uploading…'
            : mediaId
              ? (labels?.change ?? 'Change image')
              : (labels?.empty ?? 'Upload image')}
        </span>
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
          }}
        />
      </label>
    </div>
  );
}
