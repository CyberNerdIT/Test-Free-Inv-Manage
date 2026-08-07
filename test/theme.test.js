import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, PRESET_KEYS, DEFAULT_PRESET,
  resolveTheme, buildThemeCss, presetList,
} from '../src/services/theme.js';
import { updateTheme, effective, getRaw } from '../src/settings.js';

// Store theming in this build: six presets, and nothing else.
//
// Overriding individual colours is part of the paid upgrade and none of its
// code is in this repository, so the tests below are not "the feature is
// switched off" — they are "there is nothing here that could do it".

test('ships six presets, each with a complete light and dark palette', () => {
  assert.equal(PRESET_KEYS.length, 6);
  for (const key of PRESET_KEYS) {
    const p = PRESETS[key];
    assert.ok(p.name, `${key} needs a display name`);
    assert.equal(p.swatch.length, 3, `${key} needs a 3-colour swatch`);
    for (const mode of ['light', 'dark']) {
      for (const v of ['bg', 'surface', 'surface2', 'border', 'grid', 'text', 'muted', 'primary', 'primaryDark', 'accent']) {
        assert.ok(p[mode][v], `${key}.${mode} is missing ${v}`);
      }
    }
  }
});

test('an unknown preset falls back to the default rather than breaking the page', () => {
  const r = resolveTheme({ preset: 'neon-hotdog' });
  assert.equal(r.preset, DEFAULT_PRESET);
  assert.equal(r.mode, 'auto');
});

test('this build cannot render a custom colour, because it has no way to', () => {
  // Not "declines to" — there is no sanitiser, no key list and no merge
  // anywhere in this codebase, so an override has nowhere to go.
  const r = resolveTheme({ preset: 'emerald', custom: { primary: '#ff0000' } });
  assert.equal(r.preset, 'emerald');
  assert.deepEqual(Object.keys(r).sort(), ['mode', 'preset'],
    'a resolved theme is a preset and a mode — no custom slot to smuggle colours through');

  const css = buildThemeCss(r);
  assert.ok(!css.includes('#ff0000'), 'this build must not render a custom colour');
  assert.ok(css.includes(PRESETS.emerald.light.primary), 'it renders the preset colour instead');
});

test('mode auto emits both palettes; light and dark pin one', () => {
  const auto = buildThemeCss(resolveTheme({ preset: 'classic', mode: 'auto' }));
  assert.ok(auto.includes('prefers-color-scheme: dark'));
  assert.ok(auto.includes(PRESETS.classic.light.bg));
  assert.ok(auto.includes(PRESETS.classic.dark.bg));

  const light = buildThemeCss(resolveTheme({ preset: 'classic', mode: 'light' }));
  assert.ok(!light.includes('prefers-color-scheme'));
  assert.ok(light.includes(PRESETS.classic.light.bg));
  assert.ok(!light.includes(PRESETS.classic.dark.bg));

  const dark = buildThemeCss(resolveTheme({ preset: 'classic', mode: 'dark' }));
  assert.ok(!dark.includes('prefers-color-scheme'));
  assert.ok(dark.includes(PRESETS.classic.dark.bg));
});

test('every preset produces CSS defining all the variables the UI reads', () => {
  const needed = ['--bg', '--surface', '--surface-2', '--border', '--grid', '--text',
    '--muted', '--primary', '--primary-dark', '--accent', '--pos', '--neg', '--warn'];
  for (const key of PRESET_KEYS) {
    const css = buildThemeCss(resolveTheme({ preset: key }));
    for (const v of needed) assert.ok(css.includes(`${v}:`), `${key} is missing ${v}`);
  }
});

test('semantic colours stay green/red across every preset', () => {
  // Profit must not be red just because the shop picked the Crimson theme.
  for (const key of PRESET_KEYS) {
    const css = buildThemeCss(resolveTheme({ preset: key }));
    assert.ok(css.includes('--pos: #16a34a'), `${key} changed the profit colour`);
    assert.ok(css.includes('--neg: #dc2626'), `${key} changed the loss colour`);
  }
});

test('presetList is safe to send to the browser', () => {
  const list = presetList();
  assert.equal(list.length, 6);
  for (const p of list) assert.deepEqual(Object.keys(p).sort(), ['key', 'name', 'swatch']);
});

test('this build stores no custom colours at all', () => {
  // Storing unvalidated input for a feature that cannot read it keeps a payload
  // around for no benefit — and an unvalidated colour is an unvalidated string.
  updateTheme({ preset: 'crimson', custom: { primary: '#123456' } });
  const e = effective();
  assert.equal(e.theme.preset, 'crimson', 'the preset is honoured');
  assert.equal(e.theme.custom, undefined);
  assert.equal(getRaw('theme_custom'), null, 'nothing was written to the database');
  updateTheme({ preset: DEFAULT_PRESET });
});
