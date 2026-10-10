"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Box, Finding } from "@/lib/redaction/types";

type Page = { index: number; width: number; height: number; ocr: boolean };
type Props = {
  doc: PDFDocumentProxy;
  pages: Page[];
  findings: Finding[];
  onToggle: (id: string) => void;
  onAddBox: (page: number, box: Box) => void;
};

const PREVIEW_SCALE = 1.6;

export default function PdfReview({ doc, pages, findings, onToggle, onAddBox }: Props) {
  return (
    <div className="pdf-pages">
      {pages.map((p) => (
        <PageView key={p.index} doc={doc} page={p} findings={findings.filter((f) => f.page === p.index)} onToggle={onToggle} onAddBox={onAddBox} />
      ))}
    </div>
  );
}

function PageView({ doc, page, findings, onToggle, onAddBox }: { doc: PDFDocumentProxy; page: Page; findings: Finding[]; onToggle: (id: string) => void; onAddBox: (page: number, box: Box) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || rendered || !canvas.current) return;
    let cancelled = false;
    import("@/lib/redaction/pdf").then(({ renderPage }) =>
      renderPage(doc, page.index, PREVIEW_SCALE * (window.devicePixelRatio > 1 ? 1.25 : 1), canvas.current!).then(() => !cancelled && setRendered(true)),
    );
    return () => {
      cancelled = true;
    };
  }, [visible, rendered, doc, page.index]);

  function toPagePoint(e: React.PointerEvent): { x: number; y: number } {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * page.width, y: ((e.clientY - r.top) / r.height) * page.height };
  }

  function onPointerDown(e: React.PointerEvent) {
    if ((e.target as Element).getAttribute("data-finding")) return;
    const p = toPagePoint(e);
    svg.current!.setPointerCapture(e.pointerId);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const p = toPagePoint(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  }
  function onPointerUp() {
    if (!drag) return;
    const box = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
    setDrag(null);
    if (box.w > 3 && box.h > 3) onAddBox(page.index, box);
  }

  return (
    <div className="pdf-page" id={`page-${page.index + 1}`} ref={wrap}>
      <div className="pdf-page-label muted small">
        Page {page.index + 1}
        {page.ocr && " · read with OCR"}
      </div>
      <div className="pdf-page-inner" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
        <canvas ref={canvas} />
        {!rendered && <div className="pdf-loading muted small">Loading page…</div>}
        <svg
          ref={svg}
          viewBox={`0 0 ${page.width} ${page.height}`}
          preserveAspectRatio="none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {findings.flatMap((f) =>
            (f.boxes ?? []).map((b, i) => (
              <rect
                key={`${f.id}-${i}`}
                data-finding={f.id}
                className={f.selected ? "box on" : "box off"}
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                onClick={() => onToggle(f.id)}
              >
                <title>
                  {f.label}: {f.text} ({f.selected ? "will be blacked out, click to skip" : "skipped, click to black out"})
                </title>
              </rect>
            )),
          )}
          {drag && <rect className="box drawing" x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} />}
        </svg>
      </div>
    </div>
  );
}
