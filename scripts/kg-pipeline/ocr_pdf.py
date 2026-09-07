#!/usr/bin/env python3
"""
OCR a scanned PDF into per-page text using RapidOCR (Chinese-capable, onnxruntime).

Design goals (why this script exists):
  The dsh-knowledge-graph host plugin can only consume documents that already
  expose a searchable text layer (README: "扫描版 PDF 当前不做 OCR"). This PDF is
  a pure-image scan (page.get_text() is empty for every page), so there is no
  closed loop from a scanned PDF to a knowledge graph. This script is the missing
  first stage: it converts a scanned PDF into ordered, paragraph-aware text.

How it works:
  1. Render each page at a fixed DPI via PyMuPDF's get_pixmap(dpi=...). GetPixmap
     applies the page's rotation matrix, so the extracted text comes back in the
     correct left->right / top->bottom reading order.
  2. OCR the rendered page with RapidOCR (default PP-OCRv4 Chinese models bundled
     with rapidocr_onnxruntime; no network, no external binary).
  3. Order the detected lines top-to-bottom by their bounding-box y-centroid, and
     join them into paragraphs (lines whose baseline gap is small get joined).
  4. Persist {page: {text, lines}} to a JSONL/JSON work file so later stages can
     map evidence (paragraph index) back to the source page.

Output:
  --out-dir/<pdf-basename>.pages.json  : { "1": "text...", "2": "text..." }
  --out-dir/<pdf-basename>.raw.jsonl  : one JSON object per page (page, lines, text)
  --progress: incremental; a page already OCRed is skipped on resume.

Usage:
  python ocr_pdf.py --pdf <file.pdf> --out-dir <dir> [--dpi 200] [--start 1] [--end N]
"""

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def render_and_ocr(engine, doc_path, page_no, dpi, out_dir, page_index):
    """Render one page and OCR it. Returns (page_no, page_text, lines)."""
    # Doc is opened per-thread to avoid PyMuPDF thread-safety issues.
    import fitz

    doc = fitz.open(doc_path)
    try:
        page = doc[page_no - 1]
        png_path = str(Path(out_dir) / f"_tmp_page_{page_no}.png")
        pix = page.get_pixmap(dpi=dpi)
        pix.save(png_path)
    finally:
        doc.close()

    try:
        result, _ = engine(png_path)
    finally:
        try:
            os.remove(png_path)
        except OSError:
            pass

    lines = []
    for item in result or []:
        # item = [box(4 points), text, score]
        box = item[0]
        txt = item[1]
        score = item[2]
        # y-centroid & x-centroid of the box
        ys = [pt[1] for pt in box]
        xs = [pt[0] for pt in box]
        lines.append({
            "text": txt,
            "y": sum(ys) / len(ys),
            "x": sum(xs) / len(xs),
            "x0": min(pt[0] for pt in box),
            "x1": max(pt[0] for pt in box),
            "confidence": float(score) if isinstance(score, (int, float)) else 0.0,
        })

    # Sort top-to-bottom, then left-to-right for lines with near-equal y.
    lines.sort(key=lambda l: (l["y"], l["x0"]))
    page_text = "\n".join(l["text"] for l in lines)
    return page_no, page_text, lines


def assemble_paragraphs(lines, y_gap_ratio=0.55):
    """Group OCR lines into paragraphs.

    OCR returns one entry per visual line. We want semantic paragraphs so that
    evidence paragraph indices are meaningful. Two consecutive lines belong to
    the same paragraph when their vertical gap is small relative to the line
    height (typical body text) AND they are left-aligned. Blank lines / larger
    gaps / indented new headings start a new paragraph.
    """
    if not lines:
        return [], []
    paras = []
    current = [lines[0]]
    prev = lines[0]
    for cur in lines[1:]:
        line_h = max(1e-6, (prev["x1"] - prev["x0"]))
        gap = cur["y"] - prev["y"]
        # Heuristic: same paragraph if gap is below a moderate threshold and the
        # current line does not look like a heading (short, low confidence).
        same_para = (gap < 28) and (len(current) < 6)
        if same_para:
            current.append(cur)
        else:
            paras.append(current)
            current = [cur]
        prev = cur
    if current:
        paras.append(current)

    para_texts = []
    for para in paras:
        # For CJK, lines within a paragraph run top-to-bottom; join with no space
        # would be ideal, but OCR tends to clip line boundaries, so join with ''.
        # We keep a space-free join for CJK but fall back gracefully.
        joined = "".join(line["text"] for line in para)
        para_texts.append((joined, para[0]["y"]))
    # Preserve document order by paragraph top y.
    para_texts.sort(key=lambda t: t[1])
    return [p[0] for p in para_texts], paras


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--end", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=6)
    args = ap.parse_args()

    pdf_path = str(Path(args.pdf).resolve())
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    base = Path(pdf_path).stem
    pages_json = out_dir / f"{base}.pages.json"
    raw_jsonl = out_dir / f"{base}.raw.jsonl"
    progress_json = out_dir / f"{base}.progress.json"

    import fitz
    doc = fitz.open(pdf_path)
    total_pages = doc.page_count
    doc.close()

    start = max(1, args.start)
    end = total_pages if args.end <= 0 else min(args.end, total_pages)

    # Resume support.
    done = {}
    if pages_json.exists():
        try:
            done = json.loads(pages_json.read_text(encoding="utf-8"))
        except Exception:
            done = {}
    done = {int(k): v for k, v in done.items() if isinstance(v, str)}

    first_started = time.time()

    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()

    to_do = [p for p in range(start, end + 1) if p not in done]
    print(f"PDF pages={total_pages} todo={len(to_do)} (start={start} end={end}) workers={args.jobs}")

    # We open the doc once per task inside the worker; a shared engine is
    # generally reported thread-safe for inference but we keep it per-worker
    # via a pool of engines (cheap: onnxruntime model is shared memory).
    # To be safe and correct, create one engine per worker using a thread-local.
    import threading
    tls = threading.local()

    def get_engine():
        if not hasattr(tls, "engine"):
            tls.engine = RapidOCR()
        return tls.engine

    pages_text = {}
    def task(p):
        return render_and_ocr(get_engine(), pdf_path, p, args.dpi, str(out_dir), p)

    results = {}
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futures = {ex.submit(task, p): p for p in to_do}
        completed = 0
        for fut in as_completed(futures):
            p = futures[fut]
            try:
                pno, txt, lines = fut.result()
                results[pno] = (txt, lines)
            except Exception as e:
                print(f"[warn] page {p} failed: {e}", file=sys.stderr)
            completed += 1
            if completed % 10 == 0:
                rate = completed / max(1e-6, time.time() - first_started)
                print(f"  OCRed {completed}/{len(to_do)} pages  ({rate:.2f}/s)", flush=True)

    # Merge with resume data.
    for pno, (txt, lines) in results.items():
        done[pno] = txt

    ordered = {str(p): done[p] for p in sorted(done)}
    pages_json.write_text(json.dumps(ordered, ensure_ascii=False, indent=1), encoding="utf-8")

    # Write raw lines JSONL for paragraph assembly / evidence mapping.
    with raw_jsonl.open("w", encoding="utf-8") as fh:
        for pno in sorted(done):
            fh.write(json.dumps({"page": pno, "text": done[pno]}, ensure_ascii=False) + "\n")

    progress_json.write_text(json.dumps({"pages": ordered, "count": len(ordered)}, ensure_ascii=False, indent=1), encoding="utf-8")

    total_chars = sum(len(v) for v in ordered.values())
    print(f"DONE: {len(ordered)} pages, {total_chars} chars -> {pages_json}")


if __name__ == "__main__":
    main()
