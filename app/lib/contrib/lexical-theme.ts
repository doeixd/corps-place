/**
 * Shared Lexical `theme` for the free-form editor and its read-only views.
 *
 * Maps text-format bits to Tailwind classes so bold/italic/underline/
 * strikethrough/inline-code render identically while editing (LexicalFreeForm)
 * and in the read-only job-description view (LexicalView). The contrib wiki view
 * renders via the pure `renderLexicalDoc` walker, which mirrors these styles.
 */
export const FREE_FORM_THEME = {
  link: 'text-primary underline underline-offset-2 hover:text-primary/80',
  text: {
    bold: 'font-semibold',
    italic: 'italic',
    underline: 'underline',
    strikethrough: 'line-through',
    underlineStrikethrough: 'underline line-through',
    code: 'rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]',
  },
} as const;
