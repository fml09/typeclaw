import { styleText } from 'node:util'

export type StyleFormat = Parameters<typeof styleText>[0]

// Callers own the color decision (an explicit `useColor`/`opts.color` flag, or
// `colorsEnabled()` in src/cli/ui.ts, which honors FORCE_COLOR). styleText's
// default stream validation is a second authority that silently overrides the
// first, so `FORCE_COLOR=1 typeclaw status | cat` would print no color. Bun
// <=1.3.x skipped the check; Bun 1.4's node-compat rewrite applies it. Both
// accept `validateStream: false`.
export function styled(format: StyleFormat, text: string): string {
  return styleText(format, text, { validateStream: false })
}
