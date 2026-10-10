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

### Fill a form (`/tools/forms`)

A library of the firm's blank fillable PDF forms (USCIS forms and the like).
Partners can add a form, rename it, edit its description and standing
instructions ("the client is always the self-petitioner"), replace its PDF, or
delete it.

To fill one, pick it, write notes about the client and attach their documents
(PDF, Word, photos, text). Claude reads the blank form and the documents and
suggests a value for each field, with where it found it, plus a list of what
it couldn't find. The attorney checks and edits every answer on screen, then
downloads the filled PDF (editable, or flattened). Forms can also be filled by
hand without Claude.

- **What's stored:** only the blank forms and their field lists, in a private
  Vercel Blob store. Client notes, documents and answers are never saved: the
  documents go to the Claude API for that one request, and the filled PDF is
  built in the browser.
- **Government PDFs:** USCIS forms are encrypted (empty password) and carry an
  Adobe XFA layer. On upload the form is decrypted, the XFA layer dropped and
  the ordinary form fields kept, with their tooltips as field descriptions.
  Fields the XFA scripts would unlock are kept and unlocked when filled; ink
  signature boxes and barcodes are skipped.
- **Limits:** Vercel accepts request bodies up to 4.5 MB, so a form PDF and
  the client files for one fill must each total under 4 MB. Large photos are
  shrunk in the browser before sending.

| File | What it does |
| --- | --- |
| `lib/forms/pdf.ts` | Opens (decrypts) a form, lists its fields, fills it (browser and server) |
| `lib/forms/store.ts` | Form library storage (Vercel Blob, or `.data/` locally) |
| `lib/forms/fill.ts` | The Claude request that suggests field values |
| `app/api/forms/` | Library and fill API routes (all require sign-in) |

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
| `ANTHROPIC_API_KEY` | Claude API key for the form filler |
| `BLOB_READ_WRITE_TOKEN` | Form library storage; added automatically when a private Vercel Blob store is connected to the project |

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # redaction and form filler tests
```

`npm run dev` and `npm run build` copy the pdf.js and OCR runtime files into
`public/` so the browser loads them from this site, not a CDN.
