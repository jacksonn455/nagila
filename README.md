# Professional Portfolio — Nágila Bernarda Zortéa

Static website (plain HTML + CSS + JS) for the professional portfolio of **Nágila Bernarda Zortéa** — Master's degree holder, Esthetician, Coordinator of the Esthetics and Cosmetics Course and of the Graduate Program in Advanced Esthetics at URI Erechim, and head of NZ Beauty Clinic in Erechim/RS.

---

## Stack

- **HTML / CSS / JavaScript** — no frameworks, no bundlers, no production dependencies
- **Fonts**: Google Fonts — Cormorant Garamond (serif) + DM Sans (sans-serif)
- **Build**: Node.js scripts (`scripts/`)
- **Dev**: local static server (`npm run dev`)
- **Quality**: html-validate + Prettier

---

## How to run locally

```bash
# Install dev dependencies
npm install

# Start the development server at http://localhost:4173
npm run dev
```

The server mirrors GitHub Pages behavior (gzip, custom 404 route).

---

## How to build

```bash
# Generates sitemap.xml from the data
npm run build
```

---

## How to update the data

All data lives in `data/`. Edit the JSON files and the site reflects the changes automatically:

| File                      | Content                                         |
| ------------------------- | ------------------------------------------------ |
| `data/profile.json`      | Nágila's personal and institutional information |
| `data/publications.json` | Scientific publications                         |
| `data/events.json`       | Talks and events                                |
| `data/clinic.json`       | NZ Beauty Clinic data                           |

**Fundamental rule**: only include information that can be confirmed by verified public sources.

---

## How to add a new publication

1. Open `data/publications.json`
2. Add a new object to the array following the existing structure
3. Required fields: `id`, `title`, `authors`, `journal`, `year`, `abstract`
4. Recommended fields: `doi`, `url`, `urlPdf`
5. If the information is not confirmed, add `"dataNote": "TODO: validate"`
6. Add the corresponding card in `index.html` in the `#publicacoes` section

---

## How to add an event or talk

1. Open `data/events.json`
2. Add a new object to the array following the existing structure
3. Required fields: `id`, `title`, `event`, `type`, `date`, `description`, `source`
4. Add the corresponding card in `index.html` in the `#palestras` section

---

## How to update SEO

- **Home title and description**: `index.html` — `<title>` and `<meta name="description">` tags
- **Open Graph**: `index.html` — `og:*` tags
- **JSON-LD**: `index.html` — `<script type="application/ld+json">` block
- **Sitemap**: `sitemap.xml` (or run `npm run build` to generate it automatically)
- **robots.txt**: root file — already configured to allow all crawlers
- **llms.txt**: root file — human/AI-readable summary

---

## How to deploy

### GitHub Pages

1. Push the repository to GitHub
2. In **Settings → Pages**, select the `main` branch and the root folder `/`
3. For a custom domain, add the domain in the `CNAME` file

### Other services

The site is 100% static. Any CDN or static hosting service works:

- **Netlify**: drag and drop the project folder or connect via Git
- **Vercel**: connect the repository, automatic configuration
- **Cloudflare Pages**: connect the Git repository

---

## Pre-deploy checks

```bash
# HTML validation
npm run check:html

# External link check
npm run check:links

# Code formatting
npm run check:format
npm run format   # auto-fix
```

---

## Folder structure

```
nagila/
├── index.html            # Main page (single-page portfolio)
├── 404.html              # Error page (GitHub Pages)
├── robots.txt            # Crawling permissions
├── sitemap.xml           # XML sitemap for SEO
├── llms.txt              # Summary for AI systems (GEO)
├── package.json
├── data/
│   ├── profile.json      # Nágila's data
│   ├── publications.json # Scientific publications
│   ├── events.json       # Talks and events
│   └── clinic.json       # NZ Beauty Clinic
├── assets/
│   ├── css/main.css      # Full design system
│   ├── js/app.js         # Theme, nav, FAQ, animations
│   └── img/              # Images (add WebP/AVIF)
├── scripts/
│   ├── serve.js          # Development server
│   ├── build-sitemap.js  # Sitemap generator
│   └── check-links.js    # External link checker
└── README.md
```

---

## Visual identity

| Variable         | Light Mode              | Dark Mode                |
| ---------------- | ------------------------ | ------------------------- |
| `--bg`           | `#fafaf7` (ivory)        | `#0a0a0a` (black)         |
| `--text`         | `#1a1714` (warm black)   | `#f5f0e8` (ivory)         |
| `--accent`       | `#8b6914` (dark gold)    | `#c9a84c` (gold)          |
| `--accent-vivid` | `#c9a84c` (gold)         | `#d4b55a` (bright gold)   |
