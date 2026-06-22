import * as v from 'valibot';

/**
 * Valibot schemas for authored block content (plan §6.6). Valibot — because
 * Formisch introspects Valibot object schemas to build its form fields, and the
 * SAME schema re-validates server-side (`v.parse`), so contribution input has one
 * source of truth client+server. (Effect Schema stays for the scraped domain.)
 */

const Hex = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb color'));

// A served image reference (uploaded via /api/show-media/<id>). Shared by the
// uniform, gallery and cover blocks.
const MediaItem = v.object({
  url: v.pipe(v.string(), v.minLength(1)),
  alt: v.optional(v.string(), ''),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
});

const UniformColor = v.object({
  hex: Hex,
  label: v.optional(v.string(), ''),
});

export const UniformInputSchema = v.object({
  colors: v.array(UniformColor),
  description: v.optional(v.string(), ''),
  announcementUrl: v.optional(v.string(), ''),
  // Uniform photos (wiki plan §7.1 field name `images`).
  images: v.optional(v.array(MediaItem), []),
});
export type UniformInput = v.InferOutput<typeof UniformInputSchema>;

// Props & staging: named items with a description (photos arrive with M5 uploads).
const PropItem = v.object({
  name: v.pipe(v.string(), v.minLength(1, 'Name required')),
  description: v.optional(v.string(), ''),
});
export const PropsInputSchema = v.object({ items: v.array(PropItem) });
export type PropsInput = v.InferOutput<typeof PropsInputSchema>;

// Links & socials: labeled URLs (show/uniform announcements, listen links, IG/TikTok/YT/X).
const LinkItem = v.object({
  label: v.optional(v.string(), ''),
  url: v.pipe(v.string(), v.url('Enter a valid URL')),
});
export const LinksInputSchema = v.object({ items: v.array(LinkItem) });
export type LinksInput = v.InferOutput<typeof LinksInputSchema>;

// Concept & symbolism: a free-text explanation.
export const SymbolismInputSchema = v.object({ text: v.optional(v.string(), '') });
export type SymbolismInput = v.InferOutput<typeof SymbolismInputSchema>;

// Photos & media gallery: uploaded images (served via /api/show-media/<id>).
export const GalleryInputSchema = v.object({ items: v.array(MediaItem) });
export type GalleryInput = v.InferOutput<typeof GalleryInputSchema>;

// Cover image: a single uploaded image shown as the page hero (wiki plan §7.1
// `media` cover; show_media.kind='cover'). Optional so an empty save clears it.
export const CoverInputSchema = v.object({ image: v.optional(MediaItem) });
export type CoverInput = v.InferOutput<typeof CoverInputSchema>;

// The free-form "concept" essay — the editor-agnostic content envelope (plan §7.3).
// `doc` is the editor-native state (opaque, size-bounded); never rendered as HTML
// (I-14 — see lexical-render.tsx). `plain` is the flattened text for search/preview.
export const AboutInputSchema = v.object({
  format: v.picklist(['lexical', 'tiptap', 'editorjs']),
  version: v.literal(1),
  doc: v.pipe(v.string(), v.maxLength(200_000)),
  plain: v.pipe(v.string(), v.maxLength(50_000)),
});
export type AboutInput = v.InferOutput<typeof AboutInputSchema>;

// Registry: which Valibot schema validates each authored pinned block's content.
export const BLOCK_SCHEMAS = {
  uniform: UniformInputSchema,
  props: PropsInputSchema,
  links: LinksInputSchema,
  symbolism: SymbolismInputSchema,
  gallery: GalleryInputSchema,
  cover: CoverInputSchema,
  about: AboutInputSchema,
} as const;

export type AuthoredPinnedKey = keyof typeof BLOCK_SCHEMAS;
export const isAuthoredPinnedKey = (k: string): k is AuthoredPinnedKey => k in BLOCK_SCHEMAS;
