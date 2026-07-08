import { Component, useEffect, useState, type ReactNode } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { FREE_FORM_THEME } from '@/lib/contrib/lexical-theme';

const PROSE =
  '[&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-medium [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary';

function PlainFallback({ plain }: { plain: string }) {
  return (
    <div className="whitespace-pre-line text-sm leading-relaxed text-text-secondary">{plain}</div>
  );
}

/** Catches a LexicalComposer parse error and renders the plain-text fallback. */
class DocErrorBoundary extends Component<
  { plain: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <PlainFallback plain={this.props.plain} />;
    return this.props.children;
  }
}

/**
 * Read-only renderer for a stored Lexical FreeFormDoc. Walks the serialized node
 * tree (no raw HTML / no dangerouslySetInnerHTML), so authored content can't
 * inject markup or script. SSR-safe: renders the plain-text flattening until
 * mounted, then mounts a read-only Lexical instance. A bad `doc` falls back to
 * the plain text instead of crashing.
 */
export function LexicalView({ doc, plain }: { doc: string; plain: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <PlainFallback plain={plain} />;

  return (
    <DocErrorBoundary plain={plain}>
      <LexicalComposer
        initialConfig={{
          namespace: 'job-description-view',
          nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
          theme: FREE_FORM_THEME,
          editable: false,
          editorState: doc,
          onError: (e) => {
            throw e;
          },
        }}
      >
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className={`text-sm leading-relaxed text-text-secondary outline-none ${PROSE}`}
            />
          }
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </LexicalComposer>
    </DocErrorBoundary>
  );
}
