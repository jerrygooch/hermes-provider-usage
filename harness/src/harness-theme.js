/**
 * Render a REAL Hermes desktop theme in the harness.
 *
 * Mirrors `applyTheme` from apps/desktop/src/themes/context.tsx — the one place
 * the desktop turns a DesktopTheme into CSS custom properties on <html>: it
 * sets the brand seeds, per-appearance mix knobs, and the non-derived `--dt-*`
 * palette, toggles `.dark`, and tags `[data-hermes-theme]`/`[data-hermes-mode]`.
 * The real compiled styles.css then derives every `--ui-*` / `--dt-*` token
 * from those seeds with `color-mix()`, exactly as it computes them in the app.
 *
 * Palettes are the real presets (`@/themes/presets` → `THEME_PRESET_PALETTES`).
 * Browser-only on purpose: the Electron title-bar call, the localStorage boot
 * keys, and the appearance (translucency) store have no bearing on the
 * captured surface and are skipped.
 */
import { ensureContrast, parseColor } from '@hermes/shared/color'

import { harmonize, readableInk } from '@/themes/color'
import { BUILTIN_THEMES, DEFAULT_TYPOGRAPHY } from '@/themes/presets'

// styles.css --dt-primary-solid-foreground fallback — keep in sync.
const PRIMARY_SOLID_FOREGROUND = '#fcfcfc'

/** Mirror of renderedModeFor: bright palettes keep light even in dark mode. */
const renderedModeFor = (colors, mode) => {
  const rgb = parseColor(colors.background)
  if (!rgb) {
    return mode
  }
  const [r, g, b] = rgb.map(v => v / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark'
}

const mixesFor = isDark => ({
  '--theme-mix-chrome': isDark ? '74%' : '92%',
  '--theme-mix-sidebar': '100%',
  '--theme-mix-card': isDark ? '38%' : '22%',
  '--theme-mix-elevated': isDark ? '46%' : '28%',
  '--theme-mix-bubble': isDark ? '46%' : '0%'
})

export function applyHarnessTheme(spec) {
  const theme = spec && BUILTIN_THEMES[spec.name]
  if (!theme) {
    throw new Error(`unknown harness theme: ${spec && spec.name}`)
  }
  const mode = spec.mode === 'dark' ? 'dark' : 'light'
  // getBaseColors(): paired themes hand back their dark palette in dark mode
  // and their light palette otherwise; dark-only themes reuse their one palette.
  const c = mode === 'dark' ? theme.darkColors ?? theme.colors : theme.colors
  const rendered = renderedModeFor(c, mode)
  const isDark = rendered === 'dark'
  const midground = c.midground ?? c.ring
  const root = document.documentElement

  root.style.setProperty('color-scheme', rendered)
  root.dataset.hermesTheme = theme.name
  root.dataset.hermesMode = rendered
  root.classList.toggle('dark', isDark)

  const typo = { ...DEFAULT_TYPOGRAPHY, ...theme.typography }
  const seeds = {
    '--theme-foreground': c.foreground,
    '--theme-primary': c.primary,
    '--theme-secondary': c.secondary,
    '--theme-accent-soft': c.accent,
    '--theme-midground': midground,
    '--theme-warm': c.primary,
    '--theme-background-seed': c.background,
    '--theme-sidebar-seed': c.sidebarBackground ?? c.background,
    '--theme-card-seed': c.card,
    '--theme-elevated-seed': c.popover,
    '--theme-bubble-seed': c.userBubble ?? c.popover
  }
  const palette = {
    '--dt-primary-foreground': c.primaryForeground,
    '--dt-secondary-foreground': c.secondaryForeground,
    '--dt-accent-foreground': c.accentForeground,
    '--dt-border': c.border,
    '--dt-input': c.input,
    '--dt-ring': c.ring,
    '--dt-muted': c.muted,
    '--dt-midground-foreground': c.midgroundForeground ?? readableInk(midground),
    '--dt-primary-solid': ensureContrast(c.primary, PRIMARY_SOLID_FOREGROUND, 4.5),
    '--dt-primary-solid-foreground': PRIMARY_SOLID_FOREGROUND,
    '--dt-composer-ring': c.composerRing ?? midground,
    '--dt-destructive': c.destructive,
    '--dt-destructive-foreground': c.destructiveForeground,
    '--dt-sidebar-border': c.sidebarBorder ?? c.border,
    '--dt-user-bubble-border': c.userBubbleBorder ?? c.border,
    '--ui-success': harmonize('#10b981', midground, 0.25),
    '--dt-font-sans': typo.fontSans,
    '--dt-font-mono': typo.fontMono,
    '--noise-opacity-mul': isDark ? 'calc(0.04 / 0.21)' : 'calc(0.34 / 0.21)'
  }
  for (const [k, v] of Object.entries({ ...seeds, ...mixesFor(isDark), ...palette })) {
    root.style.setProperty(k, v)
  }

  return { name: theme.name, mode: rendered, dark: isDark }
}
