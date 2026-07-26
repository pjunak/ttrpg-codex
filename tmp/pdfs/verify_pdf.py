from pathlib import Path

import pdfplumber
from pypdf import PdfReader


root = Path(__file__).resolve().parents[2]
source = root / "output" / "pdf" / "dm-tools-planning-graph-dashboard-plan.pdf"
reader = PdfReader(source)
assert len(reader.pages) == 9
assert reader.metadata.title == "DM Tools: Planning, Graph, and Dashboard Plan"

with pdfplumber.open(source) as document:
    assert len(document.pages) == 9
    for index, page in enumerate(document.pages, start=1):
        text = page.extract_text() or ""
        assert len(text.strip()) > 100, f"Page {index} has too little extractable text"
        assert "\ufffd" not in text, f"Page {index} contains a replacement character"
        for char in page.chars:
            assert -1 <= char["x0"] <= page.width + 1, f"Page {index} has text outside horizontal bounds"
            assert -1 <= char["top"] <= page.height + 1, f"Page {index} has text outside vertical bounds"

print(f"Verified {len(reader.pages)} pages, metadata, text extraction, and text bounds")
