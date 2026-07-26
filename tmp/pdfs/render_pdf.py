from pathlib import Path

from pdf2image import convert_from_path


root = Path(__file__).resolve().parents[2]
source = root / "output" / "pdf" / "dm-tools-planning-graph-dashboard-plan.pdf"
destination = root / "tmp" / "pdfs" / "rendered"
poppler = Path(
    "C:/Users/junak/.cache/codex-runtimes/codex-primary-runtime/"
    "dependencies/native/poppler/Library/bin"
)
destination.mkdir(parents=True, exist_ok=True)

pages = convert_from_path(source, dpi=145, poppler_path=poppler)
for index, page in enumerate(pages):
    page.save(destination / f"page-{index + 1:02}.png")

print(f"Rendered {len(pages)} pages")
