# UI/UX — Information Gain Tool

## Design System

Matches existing seoplus.dev tools (entity-gap-analyzer, meta-tag-generator).

### Color Palette

| Token | Light Mode | Dark Mode |
|---|---|---|
| Page background | `bg-cream-200` | `dark:bg-warm-950` |
| Text primary | `text-warm-800` | `dark:text-cream-200` |
| Text secondary | `text-warm-700` | `dark:text-cream-300` |
| Accent / CTAs | `text-amber` / `bg-amber` | `dark:text-amber-bright` / `dark:bg-amber-bright` |
| Form background | `bg-cream-100` | `dark:bg-warm-850` |
| Form border | `border-cream-400` | `dark:border-warm-800` |
| Input background | `bg-cream-100 text-warm-900` | `dark:bg-cream-100 dark:text-warm-900` |
| Input focus ring | `ring-amber` | `dark:ring-amber-bright` |

### Typography

| Usage | Class |
|---|---|
| Body text | `font-body` (sans-serif, system stack) |
| Code, API keys, progress | `font-mono` |
| Headings | `font-bold` |

### Spacing & Layout

- **Max content width**: `max-w-4xl` (896px)
- **Padding**: `px-4 sm:px-6 py-12`
- **Header separator**: `border-b-2 border-amber-300` below tool title
- **Form card**: `rounded-lg p-6 sm:p-10 shadow-sm` with light border
- **Spacious**: Elements given breathing room, not crammed
- Header sticky at top (`sticky top-0 z-10`)

### Component Patterns

- All inputs: `w-full px-4 py-3 border rounded-md text-sm` with focus ring
- Form labels: `block text-sm font-medium` with `mb-2`
- Helper text: `text-xs text-warm-700/60 dark:text-cream-400/60 mt-1`
- Submit button: full-width, `bg-amber`, rounded-md, semibold, `py-3 px-6`, hover + active states, min-h-48px
- Progress area: `bg-cream-200 dark:bg-warm-800 rounded-lg` with `font-mono` text
- API key input: `font-mono`, type="password"

### Styling Framework

- **Tailwind CSS** only. No component library. Custom classes follow existing site conventions.

### Responsive Behavior

- Mobile-first with `sm:` breakpoints
- Form fields stack vertically on mobile, two-column on `sm:` and up where appropriate

### Output Display (New for This Tool)

- Side-by-side or sequential display: **original text** vs **enriched text**
- Source attribution: each injected data point includes a link to the source Markdown file in the `reports/` directory
- Column/row showing source filename alongside each enrichment
