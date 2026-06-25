import { setup, assign, fromPromise } from 'xstate';

/**
 * Image-upload lifecycle for {@link PhotoUpload}: idle → uploading → idle. On pick we
 * immediately show a local object-URL preview (optimistic), run the caller's upload,
 * then drop the preview so the real (persisted) image shows. On failure we drop the
 * preview (reverting to the previous image) and surface the message — the component
 * toasts it via sonner. The upload itself is the caller's `onFile`, passed as input.
 */
type UploadFn = (file: File) => Promise<void>;

const revoke = (url: string | null) => {
  if (url && typeof URL !== 'undefined') URL.revokeObjectURL(url);
};

export const imageUploadMachine = setup({
  types: {
    context: {} as { upload: UploadFn; previewUrl: string | null; error: string | null },
    events: {} as { type: 'PICK'; file: File },
    input: {} as { upload: UploadFn },
  },
  actors: {
    doUpload: fromPromise(({ input }: { input: { upload: UploadFn; file: File } }) =>
      input.upload(input.file)
    ),
  },
  actions: {
    showPreview: assign({
      previewUrl: ({ context, event }) => {
        revoke(context.previewUrl);
        return URL.createObjectURL((event as { file: File }).file);
      },
      error: () => null,
    }),
    dropPreview: assign({
      previewUrl: ({ context }) => {
        revoke(context.previewUrl);
        return null;
      },
    }),
  },
}).createMachine({
  id: 'imageUpload',
  context: ({ input }) => ({ upload: input.upload, previewUrl: null, error: null }),
  initial: 'idle',
  states: {
    idle: {
      on: { PICK: { target: 'uploading', actions: 'showPreview' } },
    },
    uploading: {
      invoke: {
        src: 'doUpload',
        input: ({ context, event }) => ({
          upload: context.upload,
          file: (event as { file: File }).file,
        }),
        // Drop the preview on success — the caller has persisted the image, so the real
        // `mediaId` now renders.
        onDone: { target: 'idle', actions: 'dropPreview' },
        // Revert the preview on failure and record the message for the sonner toast.
        onError: {
          target: 'idle',
          actions: [
            'dropPreview',
            assign({
              error: ({ event }) => (event.error as Error)?.message ?? 'Image upload failed.',
            }),
          ],
        },
      },
    },
  },
});
