#!/usr/bin/env python3
"""
Reconstruct clean source text from raw OCR page text.

RapidOCR returns one entry per visual line. Within a page these lines are joined
with '\n', but many of them are simply wrapped lines of one real paragraph. When
the paragraph splitter later treats each wrapped line as a distinct "line", the
model's [P数字] evidence quotes stop matching the actual source unit (because a
quote often spans an OCR line-wrap), which degrades grounding.

This script:
  1. Splits each page into paragraph candidates. A new paragraph starts when the
     OCR line looks like a heading, a caption ("图N-...", "图N-..."), a list
     marker, or when a line's first character is indented more than the previous
     line's (true of the book's first-line indent) OR the line is a short title.
  2. Joins remaining consecutive lines (the wrapped body of a paragraph) into a
     single paragraph string (CJK: no space; latin runs: single space).
  3. Strips obvious page-header / page-footer noise such as "<page>|<title>",
     "<title>|<page>", "N|学习观：从感觉懂了到真正学会", standalone book info.
  4. Writes a normalized pages JSON used by the extractor.

Usage:
  python assemble_text.py --pages <pages.json> --out <pages.clean.json>
"""

import argparse
import json
import re
from pathlib import Path

# Page header/footer patterns in the scan: "<number>|<title>" or "<title>|<number>"
HEADER_FOOTER = re.compile(r"^\s*\d{1,3}\s*[|/]\s*.{0,40}\s*$")
TITLE_PAGE = re.compile(r"^\s*(学习观|从感觉懂了到真正学会|电子工业出版社|Publishing House|北京·BEIJING|内容简介|版权|图书在版编目|责任编辑|印刷|出版发行|邮编|开本|印张|字数|版次|印次|定价|凡所购买|质量投诉|本书咨询)\s*[:：]?\s*$")
CAPTION = re.compile(r"^图\s*\d+[-－]\s*\d+.*$")
FIGURE_LABEL = re.compile(r"^(Message|doupnins|[A-Za-z][A-Za-z ]{2,20})$")


def looks_like_heading(line, next_line=None):
    """Only a real structural heading starts a new paragraph.

    Fragmenting on *any* short line over-segments the book into thousands of
    tiny units (a scan's diagram labels like "现象X"/"小红脑中" would each become
    a paragraph). We therefore only treat a line as a heading when it carries a
    structural marker (chapter #, "第X部分/章/节", "X、小标题", "图N-M" is handled
    separately as a caption) OR it is plainly a standalone section title whose
    next line begins a prose paragraph (no sentence-ending punctuation AND the
    following line is longer / looks like content). Everything else is joined as
    wrapped body text, letting the downstream paragraph splitter do fine units.
    """
    t = line.strip()
    if not t:
        return False
    # Structural English/CJK chapter markers.
    if re.match(r"^(第[一二三四五六七八九十百0-9]+[章节条款部分]|[一二三四五六七八九十]+[、.．]|\d+(\.\d+)*[、.．]?|Appendix|[A-Z]{1,3}[、.．])\s*", t):
        return True
    # A heading is a short punctuation-free line immediately followed by a long
    # prose line: strong signal of "小标题：正文".
    if len(t) <= 16 and not re.search(r"[，。：；,!?？!]", t):
        nxt = (next_line or "").strip()
        if nxt and len(nxt) > len(t) and not re.search(r"[。！？!?]", nxt[:1]):
            return True
    return False


def is_caption_or_noise(line):
    t = line.strip()
    if not t:
        return True
    if CAPTION.match(t):
        return True
    if HEADER_FOOTER.match(t) or TITLE_PAGE.match(t):
        return True
    if FIGURE_LABEL.match(t):
        return True
    if re.match(r"^\d{1,3}\s*$", t):  # bare page number
        return True
    if t in ("Message", "doupnins", "图", "图1-1", "图6-3", "图6-4", "图6-5"):
        return True
    return False


def assemble_page(line_texts):
    """Convert a page's OCR lines into a list of paragraph strings.

    Join wrapped body lines into one paragraph; split on real structural
    headings and on OCR-recognized blank lines (RapidOCR skips true blank rows,
    but if a line was empty we already split). Caption/header/footer noise is
    dropped entirely. The downstream splitParagraphs does the fine-grained unit
    segmentation, so over-joining here is safe and improves grounding.
    """
    paras = []
    current = []
    for idx, raw in enumerate(line_texts):
        line = raw.strip()
        if not line:
            if current:
                paras.append("".join(current))
                current = []
            continue
        # Skip caption / header / footer / pure noise.
        if is_caption_or_noise(line):
            if current:
                paras.append("".join(current))
                current = []
            continue
        # A real structural heading starts a new paragraph.
        nxt = line_texts[idx + 1].strip() if idx + 1 < len(line_texts) else ""
        if looks_like_heading(line, nxt):
            if current:
                paras.append("".join(current))
                current = []
            # Keep the heading as its own paragraph so it can become a section.
            paras.append(line)
            continue
        current.append(line)
    if current:
        paras.append("".join(current))
    return paras


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    raw = json.loads(Path(args.pages).read_text(encoding="utf-8"))
    out = {}
    for page in sorted(raw, key=lambda k: int(k)):
        # Split the already-'\n'-joined page text back into lines.
        lines = raw[page].split("\n")
        paras = assemble_page(lines)
        # A page's paragraphs are separate blocks; page boundary is a break.
        out[page] = "\n\n".join(paras)

    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    total = sum(len(v) for v in out.values())
    print(f"assembled {len(out)} pages, {total} chars -> {args.out}")


if __name__ == "__main__":
    main()
