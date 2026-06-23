// Public contact form (ADMIN_PAGE_PLAN §10.3). Submits to the support inbox via
// submitContact (spam-guarded: honeypot + server validation). No auth required.
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { submitContact } from '@/lib/server-fns/support';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/contact')({
  head: () =>
    seoHead({ title: 'Contact', description: 'Get in touch with corps.place', path: '/contact' }),
  component: Contact,
});

function Contact() {
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setState('sending');
    setError(null);
    try {
      await submitContact({ data: { email, subject, body, topic: 'general', website } });
      setState('sent');
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
    }
  };

  return (
    <PageShell>
      <PageHeader
        title="Contact"
        subtitle="Questions, corrections, or feedback — we read every message."
      />
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col gap-3 pt-6 text-sm">
          {state === 'sent' ? (
            <p className="text-text-secondary">
              Thanks — your message is in. We’ll reply by email.
            </p>
          ) : (
            <>
              {error ? <p className="text-destructive">{error}</p> : null}
              <Input
                placeholder="Your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                placeholder="Subject (optional)"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
              <Textarea
                placeholder="How can we help?"
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              {/* Honeypot — hidden from humans, off-screen + aria-hidden. */}
              <input
                type="text"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                className="hidden"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
              <Button
                disabled={state === 'sending' || !email || !body}
                onClick={() => void submit()}
              >
                {state === 'sending' ? 'Sending…' : 'Send'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
