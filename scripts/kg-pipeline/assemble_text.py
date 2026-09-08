#!/usr/bin/env python3
"""Join OCR wraps without silently removing source content.

Optional --drop-line regular expressions are explicit, audited removals. Raw
page/line references are retained for each cleaned paragraph.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
from ocr_pdf import atomic_text

HEADING = re.compile(r"^(?:#{1,6}\s+|第[一二三四五六七八九十百0-9]+[章节条款部分]|[一二三四五六七八九十]+[、.．]|\d+(?:\.\d+)*[、.．]\s*|(?:Chapter|Appendix)\s+|图\s*\d+[-－]\d+)")


def join_lines(lines):
    result = ""
    for line in lines:
        if result and result[-1].isascii() and line[0].isascii():
            result += " "
        result += line
    return result


def assemble_page(line_texts, drop_patterns=(), ledger=None):
    paragraphs = []
    current = []
    current_lines = []
    ledger = ledger if ledger is not None else {"paragraphs": [], "removed": []}

    def flush():
        if current:
            paragraphs.append(join_lines(current))
            ledger["paragraphs"].append({"rawLines": list(current_lines)})
            current.clear()
            current_lines.clear()

    for index, raw in enumerate(line_texts):
        line = raw.strip()
        if not line:
            flush()
            continue
        match = next((pattern for pattern in drop_patterns if pattern.fullmatch(line)), None)
        if match:
            flush()
            ledger["removed"].append({"line": index + 1, "text": raw, "pattern": match.pattern})
            continue
        if HEADING.match(line):
            flush()
            paragraphs.append(line)
            ledger["paragraphs"].append({"rawLines": [index + 1]})
        else:
            current.append(line)
            current_lines.append(index + 1)
    flush()
    position = 0
    for text, entry in zip(paragraphs, ledger["paragraphs"]):
        length = len(text.encode("utf-16-le")) // 2
        entry.update({"start": position, "end": position + length})
        position += length + 2
    return paragraphs


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--pages", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--drop-line", action="append", default=[])
    args = parser.parse_args(argv)
    source_path, output_path = Path(args.pages), Path(args.out)
    if source_path.resolve() == output_path.resolve():
        raise ValueError("Keep raw OCR pages intact; --out must differ from --pages")
    source_bytes = source_path.read_bytes()
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    raw = json.loads(source_bytes)
    if not isinstance(raw, dict) or not raw or any(not re.fullmatch(r"[1-9]\d*", page) or not isinstance(text, str) for page, text in raw.items()):
        raise ValueError("Expected OCR pages keyed by positive page number")
    source_metadata = Path(str(source_path) + ".source.json")
    metadata = json.loads(source_metadata.read_text(encoding="utf-8")) if source_metadata.exists() else {"status": "unverified", "pageCount": len(raw)}
    if metadata.get("cleaning"):
        raise ValueError("Assemble from the raw OCR pages, not an already cleaned projection")
    if metadata.get("pagesSha256") and source_hash != metadata["pagesSha256"]:
        raise ValueError("OCR pages do not match their provenance manifest")
    out, mapping = {}, {}
    patterns = [re.compile(pattern) for pattern in args.drop_line]
    for page in sorted(raw, key=int):
        ledger = {"paragraphs": [], "removed": []}
        out[page] = "\n\n".join(assemble_page(raw[page].split("\n"), patterns, ledger))
        mapping[page] = ledger
    text = json.dumps(out, ensure_ascii=False, indent=2)
    metadata.update({"pagesSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                     "cleaning": {"version": 1, "offsetUnit": "utf16", "inputPagesFile": source_path.name,
                                  "inputPagesSha256": source_hash, "pages": mapping}})
    atomic_text(output_path, text)
    atomic_text(str(output_path) + ".source.json", json.dumps(metadata, ensure_ascii=False, indent=2))
    print(f"[assemble] {len(out)} pages -> {args.out}")


if __name__ == "__main__":
    main()
