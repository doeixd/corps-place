/**
 * Reusable image picker for fantasy media (corps logos, league images). Shows a
 * preview (or an empty placeholder) plus a styled file button; hands the chosen
 * File to `onFile`. Upload/persistence is the caller's concern — this component
 * only previews `mediaId` (served from /api/fantasy-media/$id) and reports files.
 *
 * Two layouts: the default `inline` (preview + a separate button beside it) and
 * `overlay`, where the preview IS the upload control with a small edit pill in
 * the corner — one tidy area instead of an image plus a detached button.
 */
import { NoteEditIcon, AddCircleIcon } from '@/components/icons/generated';

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
  variant = 'inline',
  fill = false,
}: {
  mediaId?: string | null;
  onFile: (file: File) => void | Promise<void>;
  busy?: boolean;
  shape?: 'square' | 'round';
  /** Tailwind size utility for the preview box (default size-12). */
  size?: string;
  labels?: { empty: string; change: string };
  alt?: string;
  /** `inline` = preview + button; `overlay` = preview is the control + edit pill. */
  variant?: 'inline' | 'overlay';
  /** overlay only — fill the parent's height (square) instead of the fixed `size`. */
  fill?: boolean;
}) {
  const radius = shape === 'round' ? 'rounded-full' : 'rounded';
  // In fill mode the box stretches to the parent's height and stays square.
  // In fill mode the parent reserves the (square) footprint; the box just fills it.
  const box = fill ? 'h-full w-full' : size;
  const fileInput = (
    <input
      type="file"
      accept="image/*"
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) void onFile(file);
      }}
    />
  );

  if (variant === 'overlay') {
    return (
      <label
        className={`group relative cursor-pointer ${fill ? 'flex h-full w-full' : 'inline-block'}`}
        title={mediaId ? (labels?.change ?? 'Change image') : (labels?.empty ?? 'Add image')}
      >
        {mediaId ? (
          <>
            <img
              src={`/api/fantasy-media/${mediaId}`}
              alt={alt}
              className={`${box} ${radius} border border-border object-contain`}
            />
            {/* Edit affordance only on hover/focus — keeps the resting state clean. */}
            <span
              className={`${radius} absolute inset-0 grid place-items-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100`}
              aria-hidden
            >
              {busy ? '…' : <NoteEditIcon className="size-4" />}
            </span>
          </>
        ) : (
          <div
            className={`${box} ${radius} grid place-items-center border border-dashed border-border text-muted-foreground transition-colors group-hover:border-text-secondary group-hover:text-text-secondary`}
            aria-hidden
          >
            {busy ? (
              <span className="text-xs">…</span>
            ) : (
              <AddCircleIcon className="size-5 opacity-40" />
            )}
          </div>
        )}
        {fileInput}
      </label>
    );
  }

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
        {fileInput}
      </label>
    </div>
  );
}
