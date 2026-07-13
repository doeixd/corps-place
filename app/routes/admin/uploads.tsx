// Admin file drop: upload anything here and it lands on the server's /data
// volume (host: /data/corps-place/uploads) where it can be inspected directly.
import { useRef, useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { BusyButton } from '@/components/fantasy/busy-button';
import { useAsyncAction } from '@/lib/use-async-action';
import { listAdminUploads, deleteAdminUpload } from '@/lib/server-fns/admin-uploads';
import { seoHead } from '@/lib/seo';

type UploadsData = Awaited<ReturnType<typeof listAdminUploads>>;

export const Route = createFileRoute('/admin/uploads')({
  loader: adminLoader('viewAdmin', (): Promise<UploadsData> => listAdminUploads()),
  head: () =>
    seoHead({ title: 'Admin — Uploads', description: 'File drop', path: '/admin/uploads' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => (data ? <Uploads data={data} /> : null)}</AdminPage>;
  },
});

const fmtBytes = (n: number): string => {
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
};

function Uploads({ data }: { data: UploadsData }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File[]>([]);

  const upload = useAsyncAction(async () => {
    if (!picked.length) return;
    const form = new FormData();
    for (const f of picked) form.append('file', f, f.name);
    const res = await fetch('/api/admin/upload', { method: 'POST', body: form });
    if (!res.ok)
      throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
    setPicked([]);
    if (inputRef.current) inputRef.current.value = '';
    await router.invalidate();
  });

  const remove = useAsyncAction(async (name: string) => {
    await deleteAdminUpload({ data: name });
    await router.invalidate();
  });

  return (
    <>
      <PageHeader title="Uploads" subtitle={`Files land in ${data.dir} on the server`} />
      <Show when={upload.error ?? remove.error}>
        <p className="mb-4 text-sm text-destructive">{upload.error ?? remove.error}</p>
      </Show>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Upload files</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            multiple
            className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm file:text-foreground"
            onChange={(e) => setPicked(Array.from(e.target.files ?? []))}
          />
          <BusyButton busy={upload.busy} disabled={!picked.length} onClick={() => upload.run()}>
            Upload{picked.length > 1 ? ` (${picked.length})` : ''}
          </BusyButton>
          <span className="text-xs text-text-muted">200 MB max per upload</span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>On the server ({data.files.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Show when={data.files.length === 0}>
            <p className="text-sm text-text-muted">Nothing uploaded yet.</p>
          </Show>
          <ul className="divide-y divide-border">
            <For each={data.files}>
              {(f) => (
                <li key={f.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate font-mono">{f.name}</span>
                  <span className="shrink-0 tabular-nums text-text-muted">{fmtBytes(f.bytes)}</span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-destructive hover:underline"
                    onClick={() => remove.run(f.name)}
                  >
                    Delete
                  </button>
                </li>
              )}
            </For>
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
