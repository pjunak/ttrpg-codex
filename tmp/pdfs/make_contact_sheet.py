from pathlib import Path

from PIL import Image, ImageDraw


root = Path(__file__).resolve().parents[2]
source = root / "tmp" / "pdfs" / "rendered"
files = sorted(source.glob("page-*.png"))
thumb_w = 420
gap = 18
label_h = 28

thumbs = []
for file in files:
    image = Image.open(file).convert("RGB")
    ratio = thumb_w / image.width
    thumb = image.resize((thumb_w, int(image.height * ratio)))
    thumbs.append((file.stem, thumb))

rows = 3
cols = 3
cell_h = max(image.height for _, image in thumbs) + label_h
sheet = Image.new("RGB", (cols * thumb_w + (cols + 1) * gap, rows * cell_h + (rows + 1) * gap), "white")
draw = ImageDraw.Draw(sheet)
for index, (label, image) in enumerate(thumbs):
    row, col = divmod(index, cols)
    x = gap + col * (thumb_w + gap)
    y = gap + row * (cell_h + gap)
    draw.text((x, y), label, fill="#172033")
    sheet.paste(image, (x, y + label_h))

destination = root / "tmp" / "pdfs" / "contact-sheet.png"
sheet.save(destination)
print(destination)
