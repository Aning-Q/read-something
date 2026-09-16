# Design — Read Something

A locked visual system for this reading app. Keep the experience calm, useful, and softly expressive; do not imitate Apple assets or layouts.

## Genre

Playful — friendly and tactile, but restrained enough for long reading sessions.

## Macrostructure family

- App pages: **Workbench**. Library, statistics, learning hub, and settings use framed work surfaces with functional hierarchy.
- Content pages: **Long Document**. The reader remains a quiet, single-column reading surface with minimal chrome.
- Persistent navigation: a compact application tab bar; it is not a marketing-page navbar or footer.

## Theme

- Warm white and a faint lavender surface establish depth.
- Muted sakura-coral is the sole primary action accent; use it in no more than a small portion of a viewport.
- Blue is reserved for keyboard focus. Green and red communicate success and failure only.
- All colour values live in `tokens.css` and must be consumed by named tokens.

## Typography

- Display: Apple/PingFang system stack, normal, 600. It intentionally matches the UI body family so functional views read as one product.
- Body: Apple/PingFang system stack, normal, 400–600.
- Mono: SF Mono stack, captions and technical values only.
- No italic headings. Reading content continues to honour the reader's user-selected font.

## Spacing and surfaces

- 4-point token scale in `tokens.css`.
- 12 px cards, 12 px inputs, pills only for compact status or navigation.
- A surface uses a tint and hairline border, or a soft shadow — never the old inset/outset newmorphic combination.

## Motion and interaction

- `--ease-out`, `--ease-in`, and `--ease-in-out` only; animate opacity and transform only.
- Card hover: at most a 2 px lift on fine pointers. Press: 1 px downward.
- Reduced motion becomes an instant, opacity-only state.
- Focus uses the blue `--color-focus` ring. Buttons, inputs, toggles, and ranges preserve all existing functional states.

## CTA voice

- Primary: coral fill, light label, rounded 12 px rectangle.
- Secondary: quiet tinted surface with hairline border.
- Labels are concise and never wrap.

## What views must share

- The token palette, typography roles, radii, focus ring, interaction timing, and tab bar treatment.
- Content and controls remain content-first; no decorative emoji or artificial device chrome.

## Per-view allowances

- Library: uniform book cards with a restrained cover-forward presentation.
- Statistics: quiet data panels and the existing user-selected theme colour for actual progress data.
- Study hub: denser work surfaces and explicit active-tab treatment.
- Reader: no card grid; keep text measure and controls intentionally calmer.
