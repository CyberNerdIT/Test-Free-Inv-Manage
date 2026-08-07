// Storefront/app theming.
//
// The whole UI is driven by CSS custom properties, so a theme is just a small
// palette we emit as a `:root` override stylesheet (served from /api/theme.css
// and linked after style.css on every page). Because it is a real stylesheet in
// <head>, the theme is applied before first paint — no colour flash.
//
// Tiers: this file knows six presets and nothing else. Overriding individual
// colours is part of the paid upgrade, and the code for it — the
// overridable-key list, the hex validator, the sanitiser and the merge — is not
// in this repository at all. This build cannot render a custom colour because
// it has no idea which colours are overridable or how to combine them, not
// because a flag says no.

// Semantic colours (profit green / loss red / warning amber) stay constant
// across presets by design — they encode meaning, not decoration.
const SEMANTIC_LIGHT = { pos: '#16a34a', neg: '#dc2626', warn: '#d97706' };
const SEMANTIC_DARK = { pos: '#22c55e', neg: '#ef4444', warn: '#f59e0b' };

export const PRESETS = {
  classic: {
    name: 'Classic Blue',
    swatch: ['#2563eb', '#7c3aed', '#f4f6fb'],
    light: { bg: '#f4f6fb', surface: '#ffffff', surface2: '#f9fafb', border: '#e5e7eb', grid: '#eceff3',
      text: '#111827', muted: '#6b7280', primary: '#2563eb', primaryDark: '#1d4ed8', accent: '#7c3aed' },
    dark: { bg: '#0f1420', surface: '#171d2b', surface2: '#1e2536', border: '#2a3245', grid: '#232a3b',
      text: '#e5e9f0', muted: '#94a3b8', primary: '#3b82f6', primaryDark: '#2563eb', accent: '#a78bfa' },
  },
  graphite: {
    name: 'Graphite',
    swatch: ['#4b5563', '#0ea5e9', '#f5f5f5'],
    light: { bg: '#f5f5f5', surface: '#ffffff', surface2: '#fafafa', border: '#e4e4e7', grid: '#ededf0',
      text: '#18181b', muted: '#71717a', primary: '#4b5563', primaryDark: '#374151', accent: '#0ea5e9' },
    dark: { bg: '#101012', surface: '#1a1a1d', surface2: '#232327', border: '#2e2e33', grid: '#26262b',
      text: '#e8e8ea', muted: '#a1a1aa', primary: '#9ca3af', primaryDark: '#6b7280', accent: '#38bdf8' },
  },
  emerald: {
    name: 'Emerald',
    swatch: ['#059669', '#0d9488', '#f2f8f5'],
    light: { bg: '#f2f8f5', surface: '#ffffff', surface2: '#f6faf8', border: '#dcece4', grid: '#e8f1ec',
      text: '#0f2119', muted: '#5b7268', primary: '#059669', primaryDark: '#047857', accent: '#0d9488' },
    dark: { bg: '#0b1512', surface: '#13201b', surface2: '#1a2a23', border: '#26382f', grid: '#1f3129',
      text: '#e3f0e9', muted: '#8fa89c', primary: '#10b981', primaryDark: '#059669', accent: '#2dd4bf' },
  },
  sunset: {
    name: 'Sunset',
    swatch: ['#ea580c', '#db2777', '#fdf6f0'],
    light: { bg: '#fdf6f0', surface: '#ffffff', surface2: '#fdf9f5', border: '#f0e2d6', grid: '#f7ebe1',
      text: '#26170e', muted: '#7c6455', primary: '#ea580c', primaryDark: '#c2410c', accent: '#db2777' },
    dark: { bg: '#170f0a', surface: '#221710', surface2: '#2d1f16', border: '#3d2b1f', grid: '#33231a',
      text: '#f5e9df', muted: '#b39784', primary: '#fb923c', primaryDark: '#ea580c', accent: '#f472b6' },
  },
  violet: {
    name: 'Violet',
    swatch: ['#7c3aed', '#c026d3', '#f7f5fd'],
    light: { bg: '#f7f5fd', surface: '#ffffff', surface2: '#faf8fe', border: '#e7e0f7', grid: '#eee9fa',
      text: '#1c1330', muted: '#6b5f86', primary: '#7c3aed', primaryDark: '#6d28d9', accent: '#c026d3' },
    dark: { bg: '#120e1c', surface: '#1b1528', surface2: '#241d34', border: '#332a47', grid: '#2a2340',
      text: '#ebe6f7', muted: '#a396c0', primary: '#a78bfa', primaryDark: '#8b5cf6', accent: '#e879f9' },
  },
  crimson: {
    name: 'Crimson',
    swatch: ['#be123c', '#9333ea', '#fdf4f5'],
    light: { bg: '#fdf4f5', surface: '#ffffff', surface2: '#fdf8f9', border: '#f2dde1', grid: '#f8e7ea',
      text: '#261016', muted: '#7d5a63', primary: '#be123c', primaryDark: '#9f1239', accent: '#9333ea' },
    dark: { bg: '#160b0f', surface: '#211318', surface2: '#2c1a20', border: '#3d252d', grid: '#331e25',
      text: '#f6e6ea', muted: '#b98f9b', primary: '#f43f5e', primaryDark: '#be123c', accent: '#c084fc' },
  },
};

export const PRESET_KEYS = Object.keys(PRESETS);
export const DEFAULT_PRESET = 'classic';

/**
 * Decide the effective theme.
 *
 * A preset and a light/dark preference — that is the whole of theming in this
 * build. Custom colours would need a validator that can tell a hex code from a
 * script tag, and that validator is part of the paid upgrade, so this build
 * neither stores nor renders one.
 */
export function resolveTheme({ preset, mode } = {}) {
  return {
    preset: PRESET_KEYS.includes(preset) ? preset : DEFAULT_PRESET,
    mode: ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto',
  };
}

const varBlock = (p, semantic) => `
  --bg: ${p.bg};
  --surface: ${p.surface};
  --surface-2: ${p.surface2};
  --border: ${p.border};
  --grid: ${p.grid};
  --text: ${p.text};
  --muted: ${p.muted};
  --primary: ${p.primary};
  --primary-dark: ${p.primaryDark};
  --accent: ${p.accent};
  --pos: ${p.pos || semantic.pos};
  --neg: ${p.neg || semantic.neg};
  --warn: ${p.warn || semantic.warn};`;

/**
 * Build the override stylesheet for a resolved theme.
 * `mode` auto keeps the OS light/dark switch; light/dark pin one palette.
 */
export function buildThemeCss(resolved) {
  const preset = PRESETS[resolved.preset] || PRESETS[DEFAULT_PRESET];
  const { light, dark } = preset;

  const header = `/* ${preset.name} — generated, do not edit */`;
  if (resolved.mode === 'light') return `${header}\n:root {${varBlock(light, SEMANTIC_LIGHT)}\n}\n`;
  if (resolved.mode === 'dark') return `${header}\n:root {${varBlock(dark, SEMANTIC_DARK)}\n}\n`;
  return `${header}
:root {${varBlock(light, SEMANTIC_LIGHT)}
}
@media (prefers-color-scheme: dark) {
  :root {${varBlock(dark, SEMANTIC_DARK)}
  }
}
`;
}

/** Client-safe list for the admin theme picker. */
export function presetList() {
  return PRESET_KEYS.map((k) => ({ key: k, name: PRESETS[k].name, swatch: PRESETS[k].swatch }));
}
