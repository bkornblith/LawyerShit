// Copies the pdf.js and OCR (tesseract.js) runtime files into public/ so the
// browser loads them from this site rather than a third-party CDN. Runs before
// `next dev` and `next build`; the copies are not committed.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = (name) => dirname(require.resolve(`${name}/package.json`));
const pub = join(process.cwd(), "public");

// pdf.js: legacy build, for browsers without the newest JavaScript features.
const pdfjs = pkg("pdfjs-dist");
mkdirSync(join(pub, "pdfjs"), { recursive: true });
cpSync(join(pdfjs, "legacy", "build", "pdf.worker.min.mjs"), join(pub, "pdfjs", "pdf.worker.min.mjs"));
cpSync(join(pdfjs, "cmaps"), join(pub, "pdfjs", "cmaps"), { recursive: true });
cpSync(join(pdfjs, "standard_fonts"), join(pub, "pdfjs", "standard_fonts"), { recursive: true });

// tesseract.js: worker, the LSTM engine builds, and English + Spanish language data.
const tess = join(pub, "tesseract");
mkdirSync(join(tess, "core"), { recursive: true });
mkdirSync(join(tess, "lang"), { recursive: true });
cpSync(join(pkg("tesseract.js"), "dist", "worker.min.js"), join(tess, "worker.min.js"));
const core = pkg("tesseract.js-core");
for (const f of readdirSync(core).filter((f) => f.endsWith("lstm.wasm.js"))) cpSync(join(core, f), join(tess, "core", f));
for (const lang of ["eng", "spa"]) {
  cpSync(join(pkg(`@tesseract.js-data/${lang}`), "4.0.0_best_int", `${lang}.traineddata.gz`), join(tess, "lang", `${lang}.traineddata.gz`));
}
console.log("Copied pdf.js and tesseract.js assets to public/");
