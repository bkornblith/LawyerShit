# Davis & Kwong Toolkit

Internal tools for Davis & Kwong LLP. A sign-in page ("front door") for the two
partners leads to a dashboard of tools.

## Tools

### Redact client information (`/tools/redact`)

Enter a client's details (name, other names, date of birth, A-number, address,
anything else) and upload a PDF or Word (.docx) file. The tool finds the
client's details, shows them for review, and produces a copy with them
permanently removed. Other people named in the document are left alone.

- **Everything runs in the browser.** The file never leaves the computer and
  nothing is stored on the server.
- **PDF:** text is located with pdf.js; scanned pages are read with OCR
  (tesseract.js, English and Spanish). Filled-in form fields are checked too.
  Signatures are found as images or ink beside a client signature line
  (preparer, attorney and interpreter lines are skipped). The attorney can
  click boxes to include or skip them and drag to black out anything else.
  The output rebuilds every page as an image with the boxes burned in, so no
  text layer, form data, comments or metadata survive.
- **Word:** matched text is replaced in the file with black blocks, tracked
  changes are accepted (so deleted text can't leak), signature images near a
  client signature line are removed along with their image files, and author
  and title fields are cleared. Older `.doc` files must be re-saved as `.docx`
  or PDF first.

The engine lives in `lib/redaction/`:

| File | What it does |
| --- | --- |
| `types.ts` | `ClientContext` (the client's details) and shared types |
| `rules.ts` | Turns a `ClientContext` into search rules: name orders and initials, date formats (English/Spanish), A-number formats, street abbreviations |
| `pdf.ts` | PDF analysis (text layer, OCR, form fields, signatures) and output |
| `docx.ts` | Word analysis and output |

## Adding a tool

Add an entry to `lib/tools.ts` and a page at `app/tools/<slug>/page.tsx`.
Everything under `/tools` already requires sign-in.

## Setup

Environment variables (set in Vercel under Project Settings > Environment
Variables, or in `.env.local` for local work; see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `AUTH_SECRET` | Random string (32+ characters) that signs sign-in sessions |
| `JULIA_PASSWORD` | Julia's password (username `julia`) |
| `BRENDAN_PASSWORD` | Brendan's password (username `brendan`) |

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # redaction rule and Word tests
```

`npm run dev` and `npm run build` copy the pdf.js and OCR runtime files into
`public/` so the browser loads them from this site, not a CDN.
