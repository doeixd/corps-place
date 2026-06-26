import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/reui/badge';
import { Icon } from '@/components/icon';
import { uploadAndParseResume, saveJobsProfileBlock } from '@/lib/server-fns/jobs';
import { AddCircleIcon } from '@/components/icons/generated';
import type { ParsedResume } from 'resume-parser-ats';

interface ResumeUploadProps {
  profileId: string;
  onComplete: () => void;
}

export function ResumeUpload({ profileId, onComplete }: ResumeUploadProps) {
  const [parsed, setParsed] = useState<ParsedResume | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(['name', 'summary', 'experience', 'education', 'skills', 'location'])
  );

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError('File too large (max 10 MB)');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
      const result = await uploadAndParseResume({ base64, fileName: file.name });
      if (result.ok && result.parsed) {
        setParsed(result.parsed);
      } else {
        setError((result as { error?: string }).error ?? 'Parse failed');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const applyAll = async () => {
    if (!parsed) return;
    setApplying(true);
    try {
      if (selected.has('summary') && parsed.profile.summary) {
        await saveJobsProfileBlock({
          profileId,
          kind: 'summary',
          content: {
            format: 'lexical',
            version: 1,
            doc: parsed.profile.summary,
            plain: parsed.profile.summary.slice(0, 500),
          },
        });
      }

      if (selected.has('experience') && parsed.experience.length > 0) {
        await saveJobsProfileBlock({
          profileId,
          kind: 'experience',
          content: {
            items: parsed.experience.map((e) => ({
              org: e.company ?? '',
              role: e.jobTitle ?? '',
              startYear: '',
              endYear: '',
              description: e.descriptions?.join('\n') ?? '',
            })),
          },
        });
      }

      if (selected.has('education') && parsed.education.length > 0) {
        await saveJobsProfileBlock({
          profileId,
          kind: 'education',
          content: {
            items: parsed.education.map((e) => ({
              school: e.school ?? '',
              degree: e.degree ?? '',
              field: '',
              year: e.date ?? '',
            })),
          },
        });
      }

      if (selected.has('skills') && parsed.skills.length > 0) {
        await saveJobsProfileBlock({
          profileId,
          kind: 'skills',
          content: { items: parsed.skills.flatMap((s) => s.descriptions) },
        });
      }

      onComplete();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const fieldStatus = (key: string, label: string, value: boolean) => ({
    key,
    label,
    detected: value,
  });

  if (!parsed) {
    return (
      <Card>
        <CardContent className="space-y-4 py-5">
          <h2 className="text-base font-semibold text-text-primary">Import from Résumé</h2>
          <p className="text-sm text-text-secondary">
            Upload a PDF résumé to auto-fill your profile.
          </p>
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-foreground/15 px-4 py-8 text-sm text-text-secondary hover:border-primary/50">
            <Icon icon={AddCircleIcon} size="lg" className="text-text-muted" />
            {loading ? 'Parsing…' : 'Choose PDF file'}
            <input
              type="file"
              accept=".pdf"
              onChange={handleFile}
              className="hidden"
              disabled={loading}
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    );
  }

  const fields = [
    fieldStatus('name', 'Name', !!parsed.profile.name),
    fieldStatus('summary', 'Summary', !!parsed.profile.summary),
    fieldStatus('location', 'Location', !!parsed.profile.location),
    fieldStatus('experience', 'Experience', parsed.experience.length > 0),
    fieldStatus('education', 'Education', parsed.education.length > 0),
    fieldStatus('skills', 'Skills', parsed.skills.length > 0),
  ];

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <h2 className="text-base font-semibold text-text-primary">Review Imported Data</h2>
        <p className="text-sm text-text-secondary">Select sections to import from your résumé.</p>

        <div className="space-y-2">
          {fields.map((f) => (
            <label
              key={f.key}
              className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                selected.has(f.key) ? 'border-primary/40 bg-primary/5' : 'border-border'
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(f.key)}
                onChange={() => toggle(f.key)}
                className="size-4"
              />
              <span className="flex-1 text-sm font-medium text-text-primary">{f.label}</span>
              {f.detected ? (
                <Badge variant="success-light" size="sm">
                  Detected
                </Badge>
              ) : (
                <Badge variant="secondary-light" size="sm">
                  Not found
                </Badge>
              )}
            </label>
          ))}
        </div>

        <div className="flex gap-3">
          <Button onClick={applyAll} disabled={applying || selected.size === 0} size="sm">
            {applying
              ? 'Applying…'
              : `Apply ${selected.size} section${selected.size !== 1 ? 's' : ''}`}
          </Button>
          <Button onClick={() => setParsed(null)} variant="outline" size="sm">
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
