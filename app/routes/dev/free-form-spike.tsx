import { createFileRoute, notFound } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { PageShell } from '@/components/page-shell';
import { LexicalFreeForm, lexicalEmpty } from '@/components/contrib/lexical-free-form';
import { TiptapFreeForm, tiptapEmpty } from '@/components/contrib/tiptap-free-form';
import type { FreeFormDoc } from '@/lib/contrib/free-form';

// Dev-only editor bake-off (M-spike). Verifies both candidates mount as client-only
// islands, SSR a read-only fallback (M-3 gate), and serialize to FreeFormDoc.
export const Route = createFileRoute('/dev/free-form-spike')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: SpikePage,
});

function SpikePage() {
  // Mount guard: server + first client paint render the read-only `plain` view;
  // the editor instance mounts only after hydration. This is the M-3 SSR contract.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [lex, setLex] = useState<FreeFormDoc>(lexicalEmpty);
  const [tip, setTip] = useState<FreeFormDoc>(tiptapEmpty);

  return (
    <PageShell>
      <h1 className="mb-1 text-2xl font-bold text-text-primary">Free-form editor bake-off</h1>
      <p className="mb-6 text-sm text-text-secondary">
        Dev-only (M-spike). {mounted ? 'Editors mounted client-side.' : 'SSR read-only fallback.'}
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <EditorPanel title="Lexical" value={lex}>
          {mounted ? <LexicalFreeForm value={lex} onChange={setLex} /> : <ReadOnly doc={lex} />}
        </EditorPanel>
        <EditorPanel title="TipTap" value={tip}>
          {mounted ? <TiptapFreeForm value={tip} onChange={setTip} /> : <ReadOnly doc={tip} />}
        </EditorPanel>
      </div>
    </PageShell>
  );
}

function EditorPanel({
  title,
  value,
  children,
}: {
  title: string;
  value: FreeFormDoc;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">{title}</h2>
      {children}
      <details className="text-xs">
        <summary className="cursor-pointer text-text-secondary">
          content_json ({value.format}, {value.doc.length} bytes)
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-foreground/5 p-2">
          {JSON.stringify({ ...value, doc: JSON.parse(value.doc || 'null') }, null, 2)}
        </pre>
      </details>
    </section>
  );
}

// The no-JS / pre-hydration read-only render. The spike uses `plain`; the real M4
// renderer walks the node tree through a per-format allowlist (I-14).
function ReadOnly({ doc }: { doc: FreeFormDoc }) {
  return (
    <div className="min-h-32 whitespace-pre-line rounded-lg p-3 text-sm ring-1 ring-foreground/15">
      {doc.plain || <span className="text-text-secondary">Describe the concept…</span>}
    </div>
  );
}
