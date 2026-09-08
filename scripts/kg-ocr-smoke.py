import hashlib
import json
import re
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent / "kg-pipeline"))
import assemble_text
import ocr_pdf


class FakeDoc:
    page_count = 2

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def __getitem__(self, index):
        return types.SimpleNamespace(get_pixmap=lambda **_: types.SimpleNamespace(save=lambda path: Path(path).write_bytes(b"fake-png")))


class OcrRegression(unittest.TestCase):
    def test_lossless_cleaning_and_explicit_removal(self):
        lines = ["Machine Learning", "This is a fact", "from examples."]
        ledger = {"paragraphs": [], "removed": []}
        self.assertEqual(assemble_text.assemble_page(lines, ledger=ledger), ["Machine Learning This is a fact from examples."])
        self.assertEqual(ledger["paragraphs"][0]["rawLines"], [1, 2, 3])
        self.assertFalse(ledger["removed"])
        text = "\n".join(assemble_text.assemble_page(["123", "图6-3 重要事实", "Publishing House"]))
        for value in ["123", "图6-3 重要事实", "Publishing House"]:
            self.assertIn(value, text)
        ledger = {"paragraphs": [], "removed": []}
        self.assertEqual(assemble_text.assemble_page(["Alpha", "noise", "Beta"], [re.compile("noise")], ledger), ["Alpha", "Beta"])
        self.assertEqual(ledger["removed"], [{"line": 2, "text": "noise", "pattern": "noise"}])
        ledger = {"paragraphs": [], "removed": []}
        self.assertEqual(assemble_text.assemble_page(["A\U0001f600B", "", "Beta"], ledger=ledger), ["A\U0001f600B", "Beta"])
        self.assertEqual([(item["start"], item["end"]) for item in ledger["paragraphs"]], [(0, 4), (6, 10)])

    def test_geometry_and_temporary_cleanup(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, {"fitz": types.SimpleNamespace(open=lambda _: FakeDoc())}):
            engine = lambda _: ([[[[0, 0], [10, 0], [10, 5], [0, 5]], "Alpha", 0.9]], None)
            page, text, lines = ocr_pdf.render_and_ocr(engine, "fake.pdf", 1, 200, directory, 1)
            self.assertEqual((page, text), (1, "Alpha"))
            self.assertEqual(lines[0]["box"], [[0, 0], [10, 0], [10, 5], [0, 5]])
            self.assertEqual(lines[0]["confidence"], 0.9)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_interrupt_resume_fingerprint_and_projection_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "scan.pdf"
            pdf.write_bytes(b"synthetic-pdf")
            out = root / "out"
            args = ["--pdf", str(pdf), "--out-dir", str(out), "--jobs", "1"]
            progress = out / "scan.progress.json"
            calls = []
            interrupt = True

            def fake_ocr(engine, doc_path, page, dpi, out_dir, index):
                calls.append(page)
                if page == 2 and interrupt:
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if progress.exists() and "1" in json.loads(progress.read_text())["pages"]:
                            raise KeyboardInterrupt("synthetic process interruption")
                        time.sleep(0.005)
                    raise AssertionError("Page one was not persisted before page two finished")
                return page, "Alpha\nBeta", [{"text": "Alpha", "box": [[0, 0]], "confidence": 0.9}, {"text": "Beta", "box": [[0, 10]], "confidence": 0.8}]

            modules = {"fitz": types.SimpleNamespace(open=lambda _: FakeDoc()), "rapidocr_onnxruntime": types.SimpleNamespace(RapidOCR=lambda: object())}
            with patch.dict(sys.modules, modules), patch.object(ocr_pdf, "render_and_ocr", side_effect=fake_ocr):
                with self.assertRaises(KeyboardInterrupt):
                    ocr_pdf.main(args)
                self.assertEqual(list(json.loads(progress.read_text())["pages"]), ["1"])
                interrupt = False
                calls.clear()
                self.assertEqual(ocr_pdf.main(args), 0)
                self.assertEqual(calls, [2])
                pages = out / "scan.pages.json"
                manifest = json.loads(Path(str(pages) + ".source.json").read_text())
                self.assertEqual(manifest["status"], "completed")
                self.assertEqual(manifest["pagesSha256"], hashlib.sha256(pages.read_bytes()).hexdigest())
                raw = [json.loads(line) for line in (out / "scan.raw.jsonl").read_text().splitlines()]
                self.assertEqual(raw[0]["lines"][0]["confidence"], 0.9)
                original = pages.read_bytes()
                clean = out / "clean.json"
                assemble_text.main(["--pages", str(pages), "--out", str(clean)])
                clean_meta = json.loads(Path(str(clean) + ".source.json").read_text())
                self.assertEqual(clean_meta["pdfSha256"], manifest["pdfSha256"])
                self.assertEqual(clean_meta["cleaning"]["inputPagesSha256"], manifest["pagesSha256"])
                self.assertEqual(clean_meta["cleaning"]["pages"]["1"]["paragraphs"][0]["rawLines"], [1, 2])
                self.assertEqual(pages.read_bytes(), original)
                with self.assertRaises(ValueError):
                    assemble_text.main(["--pages", str(pages), "--out", str(pages)])
                with self.assertRaises(ValueError):
                    assemble_text.main(["--pages", str(clean), "--out", str(out / "clean-again.json")])
                pages.write_text("torn projection")
                calls.clear()
                self.assertEqual(ocr_pdf.main(args), 0)
                self.assertEqual(calls, [])
                self.assertEqual(pages.read_bytes(), original)
                with self.assertRaises(ValueError):
                    ocr_pdf.main(args + ["--dpi", "300"])
                pdf.write_bytes(b"a different PDF with the same filename")
                with self.assertRaises(ValueError):
                    ocr_pdf.main(args)

    def test_failed_pages_and_atomic_checkpoint_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "scan.pdf"
            pdf.write_bytes(b"synthetic-pdf")
            modules = {"fitz": types.SimpleNamespace(open=lambda _: FakeDoc()), "rapidocr_onnxruntime": types.SimpleNamespace(RapidOCR=lambda: object())}
            with patch.dict(sys.modules, modules), patch.object(ocr_pdf, "render_and_ocr", side_effect=RuntimeError("synthetic OCR error")):
                self.assertEqual(ocr_pdf.main(["--pdf", str(pdf), "--out-dir", str(root / "out"), "--jobs", "1"]), 1)
            state = json.loads((root / "out/scan.progress.json").read_text())
            self.assertEqual(state["status"], "partial")
            self.assertEqual(set(state["errors"]), {"1", "2"})
            target = root / "atomic.json"
            target.write_text("previous contents")
            with patch.object(ocr_pdf.os, "replace", side_effect=OSError("synthetic disk failure")):
                with self.assertRaises(OSError):
                    ocr_pdf.atomic_text(target, "new contents")
            self.assertEqual(target.read_text(), "previous contents")
            self.assertFalse(list(root.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
