import * as v from 'valibot';

// Freeform summary/about block — reuses the same envelope as the show wiki.
export const FreeFormBlockSchema = v.object({
  format: v.picklist(['lexical', 'tiptap', 'editorjs']),
  version: v.literal(1),
  doc: v.pipe(v.string(), v.maxLength(200_000)),
  plain: v.pipe(v.string(), v.maxLength(50_000)),
});
export type FreeFormBlock = v.InferOutput<typeof FreeFormBlockSchema>;

const MediaItem = v.object({
  url: v.pipe(v.string(), v.minLength(1)),
  alt: v.optional(v.string(), ''),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
});

// Experience: work history entries.
const ExperienceItem = v.object({
  org: v.pipe(v.string(), v.minLength(1, 'Organization required')),
  role: v.optional(v.string(), ''),
  startYear: v.optional(v.string(), ''),
  endYear: v.optional(v.string(), ''),
  description: v.optional(v.string(), ''),
});
export const ExperienceSchema = v.object({ items: v.array(ExperienceItem) });
export type ExperienceInput = v.InferOutput<typeof ExperienceSchema>;

// Education entries.
const EducationItem = v.object({
  school: v.pipe(v.string(), v.minLength(1, 'School required')),
  degree: v.optional(v.string(), ''),
  field: v.optional(v.string(), ''),
  year: v.optional(v.string(), ''),
});
export const EducationSchema = v.object({ items: v.array(EducationItem) });
export type EducationInput = v.InferOutput<typeof EducationSchema>;

// Skills: simple string tags.
export const SkillsSchema = v.object({ items: v.array(v.string()) });
export type SkillsInput = v.InferOutput<typeof SkillsSchema>;

// Availability: structured availability info.
export const AvailabilitySchema = v.object({
  fullTime: v.optional(v.boolean(), false),
  partTime: v.optional(v.boolean(), false),
  seasonal: v.optional(v.boolean(), false),
  seasonalPeriod: v.optional(v.string(), ''),
  willingToRelocate: v.optional(v.boolean(), false),
  remoteOnly: v.optional(v.boolean(), false),
  notes: v.optional(v.string(), ''),
});
export type AvailabilityInput = v.InferOutput<typeof AvailabilitySchema>;

// Gallery: uploaded images.
export const GallerySchema = v.object({ items: v.array(MediaItem) });
export type GalleryInput = v.InferOutput<typeof GallerySchema>;

// Org details (employer profile).
export const OrgDetailsSchema = v.object({
  website: v.optional(v.string(), ''),
  size: v.optional(v.string(), ''),
  foundedYear: v.optional(v.string(), ''),
  description: v.optional(v.string(), ''),
});
export type OrgDetailsInput = v.InferOutput<typeof OrgDetailsSchema>;

export const JOBS_BLOCK_SCHEMAS = {
  summary: FreeFormBlockSchema,
  about: FreeFormBlockSchema,
  experience: ExperienceSchema,
  education: EducationSchema,
  skills: SkillsSchema,
  availability: AvailabilitySchema,
  gallery: GallerySchema,
  org_details: OrgDetailsSchema,
} as const;

export type JobsBlockKind = keyof typeof JOBS_BLOCK_SCHEMAS;
export const isJobsBlockKind = (k: string): k is JobsBlockKind => k in JOBS_BLOCK_SCHEMAS;
