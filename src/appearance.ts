/**
 * Turns settings + theme into CSS custom properties on <html>.
 * Pure presentation: nothing here can reach a Markdown file.
 */
import type { FontChoice, Settings, Theme } from './api'

export const SYSTEM_FONTS: { family: string; label: string; generic: FontChoice['generic'] }[] = [
  { family: 'system-ui', label: 'Sistema — SF Pro', generic: 'sans' },
  { family: 'ui-rounded', label: 'Sistema arredondada — SF Pro Rounded', generic: 'sans' },
  { family: 'ui-serif', label: 'Sistema serifada — New York', generic: 'serif' },
  { family: 'ui-monospace', label: 'Sistema mono — SF Mono', generic: 'mono' },
]

const GENERIC_STACK: Record<FontChoice['generic'], string> = {
  sans: '-apple-system, BlinkMacSystemFont, system-ui, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, "New York", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
}

const ALIAS_STACK: Record<string, string> = {
  'system-ui': GENERIC_STACK.sans,
  'ui-rounded': `ui-rounded, ${GENERIC_STACK.sans}`,
  'ui-serif': GENERIC_STACK.serif,
  'ui-monospace': GENERIC_STACK.mono,
}

export function isSystemAlias(family: string) {
  return family in ALIAS_STACK
}

export function fontStack(choice: FontChoice): string {
  if (ALIAS_STACK[choice.family]) return ALIAS_STACK[choice.family]!
  // Family names are validated in Rust to a safe character set.
  return `"${choice.family.replace(/["\\]/g, '')}", ${GENERIC_STACK[choice.generic]}`
}

export function isFontAvailable(choice: FontChoice, installed: string[]) {
  return isSystemAlias(choice.family) || installed.some((f) => f.toLowerCase() === choice.family.toLowerCase())
}

export interface Environment {
  systemDark: boolean
  systemReduceMotion: boolean
  systemHighContrast: boolean
}

export function readEnvironment(): Environment {
  const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches
  return {
    systemDark: mq('(prefers-color-scheme: dark)'),
    systemReduceMotion: mq('(prefers-reduced-motion: reduce)'),
    systemHighContrast: mq('(prefers-contrast: more)'),
  }
}

export function effectiveTheme(settings: Settings, themes: Theme[], env: Environment): Theme | undefined {
  const a = settings.appearance
  const dark = a.mode === 'dark' || (a.mode === 'system' && env.systemDark)
  const hcSetting = settings.accessibility.highContrast
  const highContrast = hcSetting === 'on' || (hcSetting === 'system' && env.systemHighContrast)
  if (highContrast) {
    const hc = themes.find((t) => t.highContrast && t.mode === (dark ? 'dark' : 'light'))
    if (hc) return hc
  }
  const wanted = dark ? a.darkTheme : a.lightTheme
  return themes.find((t) => t.id === wanted) ?? themes.find((t) => t.builtin && t.mode === (dark ? 'dark' : 'light'))
}

const DENSITY = {
  compact: { row: 1.55, pad: 0.75, gap: 0.5 },
  comfortable: { row: 1.85, pad: 1, gap: 0.75 },
  spacious: { row: 2.15, pad: 1.25, gap: 1 },
}

/** Variables for a theme, usable on <html> or a preview container. */
export function themeVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(theme.colors)) vars[`--c-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`] = v
  return vars
}

export function applyAppearance(settings: Settings, themes: Theme[], env: Environment) {
  const root = document.documentElement
  const theme = effectiveTheme(settings, themes, env)
  const t = settings.typography
  const a = settings.accessibility
  const d = DENSITY[settings.appearance.density]
  const vars: Record<string, string> = {
    ...(theme ? themeVars(theme) : {}),
    '--font-ui': fontStack(t.uiFont),
    '--font-content': fontStack(t.contentFont),
    '--font-heading': fontStack(t.headingFont),
    '--font-code': fontStack(t.codeFont),
    '--content-size': `${t.contentSize}px`,
    '--content-weight': String(t.weight),
    '--heading-weight': String(t.headingWeight),
    '--content-line-height': String(t.lineHeight),
    '--paragraph-spacing': `${t.paragraphSpacing}em`,
    '--letter-spacing': `${t.letterSpacing}em`,
    '--content-max-width': t.maxWidth === 0 ? 'none' : `${t.maxWidth}px`,
    '--content-align': t.align,
    '--table-size': `${t.tableSize}px`,
    '--code-size': `${t.codeSize}px`,
    // UI scale works through rem: every interface dimension is in rem.
    '--ui-scale': String(a.uiScale / 100),
    '--row-height': `${d.row}rem`,
    '--pad': `${d.pad}rem`,
    '--gap': `${d.gap}rem`,
    '--sidebar-width': `${settings.appearance.sidebarWidth}px`,
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.style.fontSize = `${(13 * a.uiScale) / 100}px`
  root.dataset.mode = theme?.mode ?? 'light'
  root.dataset.highContrast = String(Boolean(theme?.highContrast))
  const reduce = a.reduceMotion === 'on' || (a.reduceMotion === 'system' && env.systemReduceMotion)
  root.dataset.reduceMotion = String(reduce)
  root.dataset.effects = String(settings.appearance.effects && !reduce)
  root.dataset.strongFocus = String(a.strongFocus || Boolean(theme?.highContrast))
  root.dataset.underlineLinks = String(a.underlineLinks || Boolean(theme?.highContrast))
  root.style.colorScheme = theme?.mode ?? 'light'
}
