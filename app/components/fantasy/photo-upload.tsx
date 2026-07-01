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
import { useEffect } from 'react';
import { useMachine } from '@xstate/react';
import { toast } from 'sonner';
import { NoteEditIcon, AddCircleIcon } from '@/components/icons/generated';
import { imageUploadMachine } from '@/machines/image-upload-machine';

/** Read a File to bare base64 (no data: prefix) for the upload server-fns. */
export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });

/**
 * Prepare an image File for upload: orient it, downscale to ≤1600px, and re-encode
 * to JPEG via canvas. This makes phone uploads robust — it shrinks huge camera
 * photos and converts iOS HEIC to a format the server's sharp pipeline always reads
 * (Safari can decode HEIC into a canvas). If the browser can't decode the file
 * (e.g. HEIC on desktop), it falls back to the raw bytes and lets the server try.
 */
export async function imageFileToUploadBase64(file: File): Promise<string> {
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
      return await fileToBase64(file);
    }
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, 'image/jpeg', 0.9)
    );
    if (!blob) throw new Error('encode failed');
    return await fileToBase64(new File([blob], 'upload.jpg', { type: 'image/jpeg' }));
  } catch {
    // Unsupported decode (e.g. HEIC on desktop) / no canvas — send the raw bytes.
    return fileToBase64(file);
  }
}

export function PhotoUpload({
  mediaId,
  imageUrl,
  onFile,
  shape = 'square',
  size = 'size-12',
  labels,
  alt = '',
  variant = 'inline',
  fill = false,
}: {
  mediaId?: string | null;
  /** A persisted image URL to preview directly (e.g. a profile photo_url), for
   *  consumers not served by /api/fantasy-media. Takes precedence over mediaId. */
  imageUrl?: string | null;
  /** Persist the file. MUST reject on failure so the upload state machine can revert
   *  the optimistic preview and toast the error. */
  onFile: (file: File) => void | Promise<void>;
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
  // Upload lifecycle: optimistic local preview while it persists, sonner toast on error.
  const [state, send] = useMachine(imageUploadMachine, {
    input: { upload: (file: File) => Promise.resolve(onFile(file)) },
  });
  const uploading = state.matches('uploading');
  const uploadError = state.context.error;
  useEffect(() => {
    if (uploadError) toast.error(uploadError);
  }, [uploadError]);

  const radius = shape === 'round' ? 'rounded-full' : 'rounded-lg';
  // In fill mode the parent reserves the (square) footprint; the box just fills it.
  const box = fill ? 'h-full w-full' : size;
  // The optimistic preview (local object URL) wins until the upload settles; then the
  // persisted media takes over.
  const src =
    state.context.previewUrl ??
    imageUrl ??
    (mediaId ? `/api/fantasy-media/${mediaId}` : null);

  const fileInput = (
    <input
      type="file"
      accept="image/*"
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) send({ type: 'PICK', file });
      }}
    />
  );

  const spinner = uploading ? (
    <span
      className={`${radius} absolute inset-0 z-10 grid place-items-center bg-black/40`}
      aria-label="Uploading"
    >
      <span className="size-5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
    </span>
  ) : null;

  if (variant === 'overlay') {
    return (
      <label
        className={`group relative cursor-pointer ${fill ? 'flex h-full w-full' : 'inline-block'}`}
        title={mediaId ? (labels?.change ?? 'Change image') : (labels?.empty ?? 'Add image')}
      >
        {src ? (
          <>
            <img
              src={src}
              alt={alt}
              className={`${box} ${radius} border border-border object-cover`}
            />
            {/* Edit affordance only on hover/focus — keeps the resting state clean. */}
            {!uploading ? (
              <span
                className={`${radius} absolute inset-0 grid place-items-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100`}
                aria-hidden
              >
                <NoteEditIcon className="size-4" />
              </span>
            ) : null}
          </>
        ) : (
          <div
            className={`${box} ${radius} grid place-items-center border border-dashed border-border text-muted-foreground transition-colors group-hover:border-text-secondary group-hover:text-text-secondary`}
            aria-hidden
          >
            <AddCircleIcon className="size-5 opacity-40" />
          </div>
        )}
        {spinner}
        {fileInput}
      </label>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div className={`relative ${size} shrink-0`}>
        {src ? (
          <img
            src={src}
            alt={alt}
            className={`${size} ${radius} border border-border object-cover`}
          />
        ) : (
          <div className={`${size} ${radius} bg-muted`} />
        )}
        {spinner}
      </div>
      <label className="cursor-pointer">
        <span className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted">
          {uploading
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
