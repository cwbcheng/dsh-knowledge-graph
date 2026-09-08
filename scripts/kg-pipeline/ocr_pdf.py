#!/usr/bin/env python3
"""OCR scanned PDFs with per-page durable recovery and original line geometry."""
import argparse
import hashlib
import json
import os
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def atomic_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def render_and_ocr(engine, doc_path, page_no, dpi, out_dir, page_index):
    import fitz
    handle, png_path = tempfile.mkstemp(prefix=f"page-{page_no}-", suffix=".png", dir=out_dir)
    os.close(handle)
    try:
        with fitz.open(doc_path) as doc:
            doc[page_no - 1].get_pixmap(dpi=dpi).save(png_path)
        result, _ = engine(png_path)
    finally:
        Path(png_path).unlink(missing_ok=True)
    lines = []
    for box, text, score in result or []:
        points = [[float(x), float(y)] for x, y in box]
        lines.append({
            "text": text, "box": points, "confidence": float(score),
            "x": sum(point[0] for point in points) / len(points),
            "y": sum(point[1] for point in points) / len(points),
            "x0": min(point[0] for point in points),
            "x1": max(point[0] for point in points),
            "y0": min(point[1] for point in points),
            "y1": max(point[1] for point in points),
        })
    lines.sort(key=lambda line: (line["y"], line["x0"]))
    return page_no, "\n".join(line["text"] for line in lines), lines


def load_progress(path, identity, restart=False):
    if restart or not path.exists():
        return {"version": 2, "identity": identity, "pages": {}, "errors": {}}
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("version") != 2 or state.get("identity") != identity:
        raise ValueError("OCR checkpoint source/configuration mismatch; use a new output directory or --restart")
    pages = state.get("pages")
    if not isinstance(pages, dict) or not isinstance(state.get("errors"), dict):
        raise ValueError("Invalid OCR checkpoint")
    for key, page in pages.items():
        if not key.isdigit() or not 1 <= int(key) <= identity["pageCount"] or not isinstance(page, dict):
            raise ValueError("Invalid OCR checkpoint page")
        if not isinstance(page.get("text"), str) or not isinstance(page.get("lines"), list):
            raise ValueError("OCR checkpoint lost raw lines")
    return state


def persist_progress(progress_path, pages_path, raw_path, state):
    ordered = {key: state["pages"][key] for key in sorted(state["pages"], key=int)}
    missing = [page for page in range(1, state["identity"]["pageCount"] + 1) if str(page) not in ordered]
    state["status"] = "partial" if missing else "completed"
    # The checkpoint is authoritative; projections can be rebuilt after a crash.
    atomic_text(progress_path, json.dumps(state, ensure_ascii=False, indent=2))
    pages_text = json.dumps({key: page["text"] for key, page in ordered.items()}, ensure_ascii=False, indent=2)
    atomic_text(pages_path, pages_text)
    atomic_text(raw_path, "".join(json.dumps({"page": int(key), **page}, ensure_ascii=False) + "\n"
                                 for key, page in ordered.items()))
    metadata = {
        **state["identity"], "status": state["status"], "missingPages": missing,
        "pagesSha256": hashlib.sha256(pages_text.encode("utf-8")).hexdigest(),
        "rawFile": raw_path.name, "rawSha256": file_hash(raw_path),
    }
    atomic_text(str(pages_path) + ".source.json", json.dumps(metadata, ensure_ascii=False, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int, default=0)
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--restart", action="store_true")
    args = parser.parse_args(argv)
    if args.dpi < 1 or args.jobs < 1:
        raise ValueError("dpi and jobs must be positive")
    pdf_path = Path(args.pdf).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    pages_path = out_dir / f"{pdf_path.stem}.pages.json"
    raw_path = out_dir / f"{pdf_path.stem}.raw.jsonl"
    progress_path = out_dir / f"{pdf_path.stem}.progress.json"

    import fitz
    with fitz.open(pdf_path) as doc:
        total_pages = doc.page_count
    end = total_pages if args.end == 0 else args.end
    if not 1 <= args.start <= end <= total_pages:
        raise ValueError("Invalid PDF page range")
    identity = {"pdfSha256": file_hash(pdf_path), "fileName": pdf_path.name,
                "pageCount": total_pages, "dpi": args.dpi, "engine": "rapidocr_onnxruntime"}
    if pages_path.exists() and not progress_path.exists() and not args.restart:
        raise ValueError("Legacy OCR output has no source fingerprint; use a new output directory or --restart")
    state = load_progress(progress_path, identity, args.restart)
    persist_progress(progress_path, pages_path, raw_path, state)
    todo = [page for page in range(args.start, end + 1) if str(page) not in state["pages"]]
    tls = threading.local()

    def task(page):
        if not hasattr(tls, "engine"):
            from rapidocr_onnxruntime import RapidOCR
            tls.engine = RapidOCR()
        return render_and_ocr(tls.engine, str(pdf_path), page, args.dpi, str(out_dir), page)

    failed = False
    with ThreadPoolExecutor(max_workers=args.jobs) as executor:
        futures = {executor.submit(task, page): page for page in todo}
        for future in as_completed(futures):
            page = futures[future]
            try:
                page_no, text, lines = future.result()
                if page_no != page or not isinstance(text, str) or not isinstance(lines, list):
                    raise ValueError("Invalid OCR page result")
                state["pages"][str(page)] = {"text": text, "lines": lines}
                state["errors"].pop(str(page), None)
            except Exception as error:
                failed = True
                state["errors"][str(page)] = str(error)
                print(f"[ocr] page {page} failed: {error}", file=sys.stderr)
            # A write failure must stop the run, not be disguised as OCR progress.
            persist_progress(progress_path, pages_path, raw_path, state)
    print(f"[ocr] {state['status']}: {len(state['pages'])}/{total_pages} pages")
    return 1 if failed else (0 if state["status"] == "completed" else 2)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"[ocr] {error}", file=sys.stderr)
        sys.exit(1)
