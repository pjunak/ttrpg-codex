from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "pdf" / "dm-tools-planning-graph-dashboard-plan.pdf"

PAGE_W, PAGE_H = A4
MARGIN_X = 17 * mm
MARGIN_TOP = 20 * mm
MARGIN_BOTTOM = 16 * mm
CONTENT_W = PAGE_W - 2 * MARGIN_X

INK = colors.HexColor("#172033")
MUTED = colors.HexColor("#5D6675")
NAVY = colors.HexColor("#203653")
BLUE = colors.HexColor("#356B8C")
TEAL = colors.HexColor("#2B7A78")
GOLD = colors.HexColor("#C5983E")
RED = colors.HexColor("#A84B43")
PARCHMENT = colors.HexColor("#F5F0E6")
PALE_BLUE = colors.HexColor("#EAF1F5")
PALE_TEAL = colors.HexColor("#E7F1EF")
PALE_GOLD = colors.HexColor("#F7EFD9")
PALE_RED = colors.HexColor("#F7E8E5")
WHITE = colors.white
RULE = colors.HexColor("#D5D9DE")


def register_fonts():
    candidates = [
        (
            "C:/Windows/Fonts/aptos.ttf",
            "C:/Windows/Fonts/aptosbd.ttf",
            "C:/Windows/Fonts/aptos-i.ttf",
        ),
        (
            "C:/Windows/Fonts/calibri.ttf",
            "C:/Windows/Fonts/calibrib.ttf",
            "C:/Windows/Fonts/calibrii.ttf",
        ),
    ]
    for regular, bold, italic in candidates:
        if all(Path(p).exists() for p in (regular, bold, italic)):
            pdfmetrics.registerFont(TTFont("Body", regular))
            pdfmetrics.registerFont(TTFont("Body-Bold", bold))
            pdfmetrics.registerFont(TTFont("Body-Italic", italic))
            return
    # These aliases preserve the rest of the document code when system fonts
    # are unavailable in a different runtime.
    pdfmetrics.registerFont(TTFont("Body", "C:/Windows/Fonts/arial.ttf"))
    pdfmetrics.registerFont(TTFont("Body-Bold", "C:/Windows/Fonts/arialbd.ttf"))
    pdfmetrics.registerFont(TTFont("Body-Italic", "C:/Windows/Fonts/ariali.ttf"))


register_fonts()

styles = getSampleStyleSheet()
styles.add(
    ParagraphStyle(
        name="TitleCustom",
        fontName="Body-Bold",
        fontSize=28,
        leading=31,
        textColor=WHITE,
        alignment=TA_LEFT,
        spaceAfter=10,
    )
)
styles.add(
    ParagraphStyle(
        name="SubtitleCustom",
        fontName="Body",
        fontSize=13,
        leading=18,
        textColor=colors.HexColor("#DCE6ED"),
        alignment=TA_LEFT,
    )
)
styles.add(
    ParagraphStyle(
        name="H1Custom",
        fontName="Body-Bold",
        fontSize=19,
        leading=22,
        textColor=NAVY,
        spaceAfter=8,
        keepWithNext=True,
    )
)
styles.add(
    ParagraphStyle(
        name="H2Custom",
        fontName="Body-Bold",
        fontSize=12.5,
        leading=15,
        textColor=BLUE,
        spaceBefore=7,
        spaceAfter=4,
        keepWithNext=True,
    )
)
styles.add(
    ParagraphStyle(
        name="BodyCustom",
        fontName="Body",
        fontSize=9.4,
        leading=12.3,
        textColor=INK,
        spaceAfter=5,
    )
)
styles.add(
    ParagraphStyle(
        name="SmallCustom",
        fontName="Body",
        fontSize=7.8,
        leading=10,
        textColor=MUTED,
    )
)
styles.add(
    ParagraphStyle(
        name="CalloutCustom",
        fontName="Body-Bold",
        fontSize=10.4,
        leading=14,
        textColor=NAVY,
    )
)
styles.add(
    ParagraphStyle(
        name="TableHead",
        fontName="Body-Bold",
        fontSize=8.4,
        leading=10,
        textColor=WHITE,
    )
)
styles.add(
    ParagraphStyle(
        name="TableCell",
        fontName="Body",
        fontSize=7.9,
        leading=10,
        textColor=INK,
    )
)
styles.add(
    ParagraphStyle(
        name="TableCellBold",
        fontName="Body-Bold",
        fontSize=7.9,
        leading=10,
        textColor=NAVY,
    )
)
styles.add(
    ParagraphStyle(
        name="Phase",
        fontName="Body-Bold",
        fontSize=10,
        leading=12,
        textColor=WHITE,
        alignment=TA_CENTER,
    )
)
styles.add(
    ParagraphStyle(
        name="CoverTableHead",
        fontName="Body-Bold",
        fontSize=8,
        leading=10,
        textColor=colors.HexColor("#F4F7F9"),
    )
)
styles.add(
    ParagraphStyle(
        name="CoverTableLabel",
        fontName="Body-Bold",
        fontSize=8,
        leading=10,
        textColor=colors.HexColor("#FFFFFF"),
    )
)
styles.add(
    ParagraphStyle(
        name="CoverTableCell",
        fontName="Body",
        fontSize=8,
        leading=10,
        textColor=colors.HexColor("#EDF3F6"),
    )
)


def p(text, style="BodyCustom"):
    return Paragraph(text, styles[style])


def bullets(items, color=INK, size=9.2):
    rows = []
    for item in items:
        rows.append(
            [
                Paragraph(
                    "<font color='#C5983E'><b>-</b></font>",
                    ParagraphStyle("BulletMark", fontName="Body-Bold", fontSize=size, leading=12),
                ),
                Paragraph(
                    item,
                    ParagraphStyle(
                        "BulletBody",
                        fontName="Body",
                        fontSize=size,
                        leading=12,
                        textColor=color,
                        spaceAfter=1,
                    ),
                ),
            ]
        )
    table = Table(rows, colWidths=[4 * mm, CONTENT_W - 4 * mm], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 1),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    return table


class Callout(Flowable):
    def __init__(self, title, text, accent=GOLD, background=PALE_GOLD, height=30 * mm):
        super().__init__()
        self.title = title
        self.text = text
        self.accent = accent
        self.background = background
        self.height = height
        self.width = CONTENT_W

    def wrap(self, avail_width, avail_height):
        self.width = avail_width
        return avail_width, self.height

    def draw(self):
        c = self.canv
        c.setFillColor(self.background)
        c.roundRect(0, 0, self.width, self.height, 3 * mm, fill=1, stroke=0)
        c.setFillColor(self.accent)
        c.roundRect(0, 0, 3 * mm, self.height, 1.5 * mm, fill=1, stroke=0)
        title = Paragraph(self.title, styles["CalloutCustom"])
        body = Paragraph(self.text, styles["BodyCustom"])
        title.wrapOn(c, self.width - 13 * mm, 8 * mm)
        title.drawOn(c, 8 * mm, self.height - 10 * mm)
        body.wrapOn(c, self.width - 13 * mm, self.height - 13 * mm)
        body.drawOn(c, 8 * mm, 5 * mm)


class WorkflowDiagram(Flowable):
    def __init__(self):
        super().__init__()
        self.width = CONTENT_W
        self.height = 61 * mm

    def wrap(self, avail_width, avail_height):
        self.width = avail_width
        return avail_width, self.height

    def draw_arrow(self, c, x1, y, x2):
        c.setStrokeColor(BLUE)
        c.setLineWidth(1.3)
        c.line(x1, y, x2, y)
        c.setFillColor(BLUE)
        c.line(x2, y, x2 - 3.2, y + 2)
        c.line(x2, y, x2 - 3.2, y - 2)

    def box(self, c, x, y, w, h, title, subtitle, fill):
        c.setFillColor(fill)
        c.setStrokeColor(colors.HexColor("#BFC9D2"))
        c.roundRect(x, y, w, h, 2.5 * mm, fill=1, stroke=1)
        t = Paragraph(title, ParagraphStyle("wf", fontName="Body-Bold", fontSize=8.2, leading=10, textColor=NAVY, alignment=TA_CENTER))
        s = Paragraph(subtitle, ParagraphStyle("wfs", fontName="Body", fontSize=6.8, leading=8.1, textColor=MUTED, alignment=TA_CENTER))
        t.wrapOn(c, w - 6 * mm, h)
        t.drawOn(c, x + 3 * mm, y + h - 10 * mm)
        s.wrapOn(c, w - 6 * mm, h)
        s.drawOn(c, x + 3 * mm, y + 5 * mm)

    def draw(self):
        c = self.canv
        gap = 5 * mm
        box_w = (self.width - 4 * gap) / 5
        box_h = 27 * mm
        y = 23 * mm
        items = [
            ("Capture", "Ideas, hooks, encounters, reminders, fragments", PALE_BLUE),
            ("Organize", "Folders, tags, kinds, pinned workspaces", PALE_GOLD),
            ("Connect", "NPCs, factions, places, mysteries, plan links", PALE_TEAL),
            ("Explore", "Scoped graphs, filters, backlinks, search", PALE_RED),
            ("Use and revise", "Reference during play; change only when useful", PALE_BLUE),
        ]
        for idx, item in enumerate(items):
            x = idx * (box_w + gap)
            self.box(c, x, y, box_w, box_h, *item)
            if idx < len(items) - 1:
                self.draw_arrow(c, x + box_w + 1, y + box_h / 2, x + box_w + gap - 1)
        c.setStrokeColor(GOLD)
        c.setLineWidth(1)
        c.line(self.width - box_w / 2, y - 5 * mm, box_w / 2, y - 5 * mm)
        c.line(box_w / 2, y - 5 * mm, box_w / 2, y - 1 * mm)
        c.line(self.width - box_w / 2, y - 5 * mm, self.width - box_w / 2, y - 1 * mm)
        c.setFillColor(GOLD)
        c.line(box_w / 2, y - 1 * mm, box_w / 2 - 2, y - 4)
        c.line(box_w / 2, y - 1 * mm, box_w / 2 + 2, y - 4)
        note = Paragraph(
            "Planning is reusable and non-linear. No item is assigned to an expected session.",
            ParagraphStyle("wf-note", fontName="Body-Italic", fontSize=7.4, leading=9, textColor=MUTED, alignment=TA_CENTER),
        )
        note.wrapOn(c, self.width, 10 * mm)
        note.drawOn(c, 0, 2 * mm)


class DomainModelDiagram(Flowable):
    def __init__(self):
        super().__init__()
        self.width = CONTENT_W
        self.height = 91 * mm

    def wrap(self, avail_width, avail_height):
        self.width = avail_width
        return avail_width, self.height

    def box(self, c, x, y, w, h, title, text, fill, stroke=RULE):
        c.setFillColor(fill)
        c.setStrokeColor(stroke)
        c.roundRect(x, y, w, h, 2.2 * mm, fill=1, stroke=1)
        title_p = Paragraph(title, ParagraphStyle("dm-t", fontName="Body-Bold", fontSize=8.2, leading=10, textColor=NAVY, alignment=TA_CENTER))
        body_p = Paragraph(text, ParagraphStyle("dm-b", fontName="Body", fontSize=6.8, leading=8, textColor=MUTED, alignment=TA_CENTER))
        title_p.wrapOn(c, w - 5 * mm, h)
        title_p.drawOn(c, x + 2.5 * mm, y + h - 9 * mm)
        body_p.wrapOn(c, w - 5 * mm, h)
        body_p.drawOn(c, x + 2.5 * mm, y + 4 * mm)

    def arrow(self, c, x1, y1, x2, y2, dashed=False):
        c.saveState()
        c.setStrokeColor(BLUE)
        c.setLineWidth(1)
        if dashed:
            c.setDash(3, 2)
        c.line(x1, y1, x2, y2)
        c.restoreState()

    def draw(self):
        c = self.canv
        col_w = 31 * mm
        h = 22 * mm
        x0 = 2 * mm
        gap = 4 * mm
        xs = [x0 + i * (col_w + gap) for i in range(5)]
        y_top = 62 * mm
        self.box(c, xs[0], y_top, col_w, h, "Thread", "Broad plot, conflict, theme, or antagonist plan.", PALE_BLUE)
        self.box(c, xs[1], y_top, col_w, h, "Quest / hook", "Potential or known objective without session assignment.", PALE_GOLD)
        self.box(c, xs[2], y_top, col_w, h, "Scenario", "Situation, challenge, branch, or prepared possibility.", PALE_TEAL)
        self.box(c, xs[3], y_top, col_w, h, "Encounter", "Combat, social, exploration, puzzle, or hazard setup.", PALE_RED)
        self.box(c, xs[4], y_top, col_w, h, "Note", "Free-form idea, reminder, ruling, fragment, or research.", PALE_BLUE)

        mid_y = 31 * mm
        wide = 124 * mm
        mid_x = (self.width - wide) / 2
        self.box(
            c,
            mid_x,
            mid_y,
            wide,
            21 * mm,
            "Planning item",
            "Shared title, body, stable named sections, folder, tags, optional state, core references, and typed named links. Kind-specific fields stay small.",
            PARCHMENT,
            GOLD,
        )
        for x in xs:
            self.arrow(c, x + col_w / 2, y_top, self.width / 2, mid_y + 21 * mm, True)

        bottom_y = 2 * mm
        bottom_w = 50 * mm
        labels = [
            ("Folder tree", "navigation hierarchy only"),
            ("Core references", "NPCs, factions, places, mysteries"),
            ("Derived views", "graph, backlinks, search, dashboard"),
        ]
        for i, (title, text) in enumerate(labels):
            x = 5 * mm + i * 58 * mm
            fill = PALE_BLUE if i in (0, 2) else WHITE
            self.box(c, x, bottom_y, bottom_w, 17 * mm, title, text, fill)
            self.arrow(c, self.width / 2, mid_y, x + bottom_w / 2, bottom_y + 17 * mm, True)


class OwnershipDiagram(Flowable):
    def __init__(self):
        super().__init__()
        self.width = CONTENT_W
        self.height = 56 * mm

    def wrap(self, avail_width, avail_height):
        self.width = avail_width
        return avail_width, self.height

    def draw(self):
        c = self.canv
        w = (self.width - 12 * mm) / 3
        h = 41 * mm
        data = [
            (
                "Core host",
                "Campaign facts<br/>Characters, places, events, mysteries<br/>Auth, storage, backups, SSE",
                PALE_BLUE,
            ),
            (
                "DM Tools",
                "Private planning workspace<br/>Notes, quests, scenarios, encounters<br/>Folders, links, graphs, dashboard",
                PALE_GOLD,
            ),
            (
                "Optional addons",
                "Specialized capabilities<br/>Rules, sheets, combat helpers<br/>Consume versioned APIs only",
                PALE_TEAL,
            ),
        ]
        for i, (title, text, fill) in enumerate(data):
            x = i * (w + 6 * mm)
            c.setFillColor(fill)
            c.setStrokeColor(RULE)
            c.roundRect(x, 9 * mm, w, h, 2.5 * mm, fill=1, stroke=1)
            t = Paragraph(title, ParagraphStyle("own-t", fontName="Body-Bold", fontSize=10, leading=12, textColor=NAVY, alignment=TA_CENTER))
            b = Paragraph(text, ParagraphStyle("own-b", fontName="Body", fontSize=7.4, leading=10, textColor=MUTED, alignment=TA_CENTER))
            t.wrapOn(c, w - 8 * mm, h)
            t.drawOn(c, x + 4 * mm, 38 * mm)
            b.wrapOn(c, w - 8 * mm, h)
            b.drawOn(c, x + 4 * mm, 16 * mm)
        c.setStrokeColor(GOLD)
        c.setLineWidth(1.1)
        c.line(w, 29 * mm, w + 6 * mm, 29 * mm)
        c.line(2 * w + 6 * mm, 29 * mm, 2 * w + 12 * mm, 29 * mm)
        c.setFillColor(GOLD)
        c.drawString(1.5 * mm, 2 * mm, "Ownership is explicit. Integration is optional and contract-based.")


def make_table(rows, widths, header=True, font_size=7.9):
    converted = []
    for r_idx, row in enumerate(rows):
        converted.append(
            [
                Paragraph(str(cell), styles["TableHead" if header and r_idx == 0 else "TableCell"])
                for cell in row
            ]
        )
    table = Table(converted, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
    ]
    if header:
        commands.extend(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
            ]
        )
    for i in range(1 if header else 0, len(rows)):
        commands.append(("BACKGROUND", (0, i), (-1, i), WHITE if i % 2 else colors.HexColor("#F7F8F9")))
    table.setStyle(TableStyle(commands))
    return table


class NumberedBox(Flowable):
    def __init__(self, number, title, text, accent=BLUE):
        super().__init__()
        self.number = str(number)
        self.title = title
        self.text = text
        self.accent = accent
        self.width = CONTENT_W
        self.height = 24 * mm

    def wrap(self, avail_width, avail_height):
        self.width = avail_width
        return avail_width, self.height

    def draw(self):
        c = self.canv
        c.setFillColor(colors.HexColor("#F7F8F9"))
        c.setStrokeColor(RULE)
        c.roundRect(0, 0, self.width, self.height, 2 * mm, fill=1, stroke=1)
        c.setFillColor(self.accent)
        c.circle(9 * mm, self.height / 2, 5 * mm, fill=1, stroke=0)
        c.setFillColor(WHITE)
        c.setFont("Body-Bold", 9)
        c.drawCentredString(9 * mm, self.height / 2 - 3, self.number)
        title = Paragraph(self.title, styles["CalloutCustom"])
        body = Paragraph(self.text, styles["SmallCustom"])
        title.wrapOn(c, self.width - 28 * mm, 7 * mm)
        title.drawOn(c, 18 * mm, self.height - 9 * mm)
        body.wrapOn(c, self.width - 28 * mm, 11 * mm)
        body.drawOn(c, 18 * mm, 4 * mm)


def page_background(c: canvas.Canvas, doc):
    c.saveState()
    c.setFillColor(colors.HexColor("#FCFCFB"))
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setStrokeColor(RULE)
    c.setLineWidth(0.5)
    c.line(MARGIN_X, 13 * mm, PAGE_W - MARGIN_X, 13 * mm)
    c.setFillColor(MUTED)
    c.setFont("Body", 7.3)
    c.drawString(MARGIN_X, 8.5 * mm, "DM Tools: Planning, Graph, and Dashboard Plan")
    c.drawRightString(PAGE_W - MARGIN_X, 8.5 * mm, f"{doc.page}")
    c.restoreState()


def cover_background(c: canvas.Canvas, doc):
    c.saveState()
    c.setFillColor(NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(BLUE)
    c.circle(PAGE_W - 15 * mm, PAGE_H - 23 * mm, 44 * mm, fill=1, stroke=0)
    c.setFillColor(TEAL)
    c.circle(PAGE_W - 20 * mm, 18 * mm, 50 * mm, fill=1, stroke=0)
    c.setStrokeColor(colors.Color(1, 1, 1, alpha=0.12))
    c.setLineWidth(1)
    for i in range(6):
        c.circle(PAGE_W - 20 * mm, 18 * mm, (14 + i * 7) * mm, fill=0, stroke=1)
    c.restoreState()


doc = BaseDocTemplate(
    str(OUTPUT),
    pagesize=A4,
    leftMargin=MARGIN_X,
    rightMargin=MARGIN_X,
    topMargin=MARGIN_TOP,
    bottomMargin=MARGIN_BOTTOM,
    title="DM Tools: Planning, Graph, and Dashboard Plan",
    author="Codex architecture review",
    subject="D&D campaign workflow, domain model, and implementation roadmap",
)

cover_frame = Frame(MARGIN_X, 24 * mm, CONTENT_W, PAGE_H - 48 * mm, id="cover", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
body_frame = Frame(MARGIN_X, MARGIN_BOTTOM, CONTENT_W, PAGE_H - MARGIN_TOP - MARGIN_BOTTOM, id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
doc.addPageTemplates(
    [
        PageTemplate(id="Cover", frames=[cover_frame], onPage=cover_background, autoNextPageTemplate="Body"),
        PageTemplate(id="Body", frames=[body_frame], onPage=page_background),
    ]
)

story = []

# Cover
story.append(Spacer(1, 50 * mm))
story.append(p("DM Tools", "SubtitleCustom"))
story.append(p("Planning, Graph, and<br/>Dashboard Plan", "TitleCustom"))
story.append(Spacer(1, 7 * mm))
story.append(
    Paragraph(
        "A structured private planning workspace with strong organization and visual connections, without turning campaign play into administrative work.",
        ParagraphStyle("cover-deck", parent=styles["SubtitleCustom"], fontSize=15, leading=21, textColor=colors.HexColor("#E9F0F4")),
    )
)
story.append(Spacer(1, 48 * mm))
cover_table = Table(
    [
        [p("DECISION", "CoverTableHead"), p("RECOMMENDATION", "CoverTableHead")],
        [p("Core direction", "CoverTableLabel"), p("Build one private planning workspace for threads, quests, scenarios, encounters, and free-form notes, all linked to existing campaign entities.", "CoverTableCell")],
        [p("Structure", "CoverTableLabel"), p("Folders organize navigation; typed links organize meaning; graphs and dashboards are derived views. Sessions never own planning records.", "CoverTableCell")],
        [p("Restraint", "CoverTableLabel"), p("Status and result tracking stay optional and shallow. Homebrew rules and combat calculation belong in later specialized addons.", "CoverTableCell")],
    ],
    colWidths=[35 * mm, CONTENT_W - 35 * mm],
)
cover_table.setStyle(
    TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), colors.Color(1, 1, 1, alpha=0.12)),
            ("BACKGROUND", (0, 1), (-1, -1), colors.Color(1, 1, 1, alpha=0.07)),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.Color(1, 1, 1, alpha=0.28)),
            ("TEXTCOLOR", (0, 0), (-1, -1), WHITE),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]
    )
)
story.append(cover_table)
story.append(Spacer(1, 18 * mm))
story.append(Paragraph("Architecture review and phased implementation plan | 26 July 2026", styles["SubtitleCustom"]))
story.append(PageBreak())

# Page 2
story.append(p("1. Executive plan", "H1Custom"))
story.append(
    Callout(
        "Recommended destination",
        "DM Tools should be a private planning knowledge base: structured enough to organize complex plots, encounters, NPC connections, and reusable possibilities, but lightweight enough that the DM never has to maintain a second history of the campaign.",
        accent=GOLD,
        background=PALE_GOLD,
        height=31 * mm,
    )
)
story.append(Spacer(1, 5 * mm))
story.append(p("What is already strong", "H2Custom"))
story.append(
    bullets(
        [
            "<b>The host foundation is sufficient.</b> DM-only collections, atomic multi-collection transactions, reviewed imports, lifecycle cleanup, graph facade, localization, and role-aware synchronization are already present.",
            "<b>Core campaign entities are useful facts.</b> Characters, factions, locations, events, mysteries, maps, and historical records should remain independent of planning tools.",
            "<b>Addon boundaries are sound.</b> DM Tools can work alone; sheets and compendiums can integrate through versioned APIs without becoming hard dependencies.",
        ]
    )
)
story.append(p("What currently blocks a coherent campaign flow", "H2Custom"))
issues = [
    ["Gap", "Why it matters", "Design response"],
    ["One flat scenario list", "Notes, plots, quests, and encounters need different labels but share organization, linking, search, and graph behavior.", "Use one discriminated planning-item model with a small set of kinds."],
    ["Organization and meaning can mix", "A folder tree is useful for browsing but becomes brittle if it also defines story causality.", "Keep folder hierarchy separate from typed semantic links."],
    ["Scenario graph has nodes but no edges", "It is a catalog in graph form, not a planning aid.", "Add explicit links, core-entity references, scoped filters, and backlinks."],
    ["Core facts could be duplicated", "Copying NPC or location details into planning records creates stale parallel data.", "Reference host entities and show live summaries instead of copying them."],
    ["No persisted schema migration path", "The data model is still small, so this is the cheapest moment to establish safe evolution.", "Version records and add additive, tested migrations before new UI."],
]
story.append(make_table(issues, [35 * mm, 69 * mm, CONTENT_W - 104 * mm]))
story.append(Spacer(1, 5 * mm))
story.append(p("Scope guardrails", "H2Custom"))
story.append(
    bullets(
        [
            "No database, framework, or infrastructure rewrite. JSON remains appropriate at this campaign scale.",
            "No session ownership, automatic progress, mandatory result logs, or expected scene order.",
            "No second copies of characters, factions, locations, mysteries, artifacts, maps, or historical events.",
            "No unlimited custom node types or edge semantics. New structure must justify its maintenance cost.",
            "Encounter preparation belongs here; encounter rules, difficulty math, and homebrew mechanics belong in specialized addons.",
            "DM planning stays private. Player-facing publication is explicit and deferred.",
        ]
    )
)
story.append(PageBreak())

# Page 3
story.append(p("2. Planning workflow without session binding", "H1Custom"))
story.append(p("Planning can be extensive without predicting the path of play. The workspace should help capture, organize, connect, and retrieve possibilities; it should not demand that the DM reconcile every plan against every session.", "BodyCustom"))
story.append(Spacer(1, 3 * mm))
story.append(WorkflowDiagram())
story.append(Spacer(1, 3 * mm))
workflow_rows = [
    ["Stage", "DM intent", "Tooling that should support it", "Durable result"],
    ["Capture", "Save an idea before it is lost.", "Fast note creation with body-only input, optional title, current folder, and later classification.", "An inbox item, not a form-filling interruption."],
    ["Organize", "Build a navigable private reference.", "Folders, tags, item kinds, pinning, search, archive, drag-and-drop placement.", "A stable notebook structure."],
    ["Connect", "See how plans touch the campaign.", "Live references to NPCs, factions, places, mysteries, maps, other plan items, and encounters.", "Backlinks and explicit graph edges."],
    ["Explore", "Understand a complicated plan visually.", "Scoped graphs, saved filters, edge legends, list fallback, and focus around one selected node.", "A derived view, never duplicated truth."],
    ["Use and revise", "Consult plans and adjust only what remains useful.", "Quick open, one-click state changes, concise outcome note, optional core event backlink.", "No mandatory session record or reconciliation."],
]
story.append(make_table(workflow_rows, [27 * mm, 43 * mm, 71 * mm, CONTENT_W - 141 * mm]))
story.append(Spacer(1, 5 * mm))
story.append(
    Callout(
        "Maintenance rule",
        "The system may offer useful structure, but it must never nag the DM to complete it. A skipped quest, unused encounter, or radically changed situation remains valid reference material until manually revised, archived, or reused.",
        accent=TEAL,
        background=PALE_TEAL,
        height=27 * mm,
    )
)
story.append(PageBreak())

# Page 4
story.append(p("3. Proposed domain model", "H1Custom"))
story.append(p("Use one common planning-item contract with a small kind discriminator. This keeps editing, search, import, graphing, and lifecycle code shared while allowing a few kind-specific fields where they genuinely help.", "BodyCustom"))
story.append(DomainModelDiagram())
domain_rows = [
    ["Concept", "Owns", "References", "Lifecycle rule"],
    ["Thread", "Premise, stakes, broad plan, optional simple state", "Quests, scenarios, encounters, NPCs, factions, places", "An organizing lens, not a progress engine or mandatory root."],
    ["Quest / hook", "Hook, objective, reward, possibilities, named parts, optional state", "Threads, scenarios, encounters, mysteries, core entities", "May be ignored, combined, changed, resolved unexpectedly, or abandoned."],
    ["Scenario", "Situation, branches, discoveries, contingencies, reusable prose", "Any planning items and core entities", "Never assigned to a session and never requires ordered scenes."],
    ["Encounter", "Kind, setup, participants, location, terrain, tactics, notes", "Scenario, NPCs, locations, optional provider records", "Reusable preparation; no combat or rules calculation inside DM Tools."],
    ["Note", "Free-form body, tags, optional title and pin", "Anything or nothing", "Lowest-friction capture; promote to another kind only when useful."],
    ["Folder", "Title, parent, display order", "Planning items and child folders", "Navigation only. Moving a folder never changes narrative meaning or graph edges."],
]
story.append(make_table(domain_rows, [24 * mm, 49 * mm, 46 * mm, CONTENT_W - 119 * mm]))
story.append(Spacer(1, 5 * mm))
story.append(p("Relationship discipline", "H2Custom"))
story.append(
    bullets(
        [
            "Use typed core references for involvement: character, faction, location, mystery, artifact, event, map, and optional addon record.",
            "Every item may contain optional stable named sections. A link endpoint can target the whole item or one section, so an NPC can connect directly to a specific quest part.",
            "Keep manual relation types small: <b>related</b>, <b>supports</b>, <b>opposes</b>, <b>reveals</b>, and <b>requires</b>. Every edge also carries a user-facing name such as Secret patron, Betrays here, or Knows the password.",
            "<b>Requires</b> means a genuine information or world-state precondition, not an expected session sequence.",
            "Folder placement, tags, timestamps, session numbers, and visual proximity never create semantic graph edges.",
        ]
    )
)
story.append(PageBreak())

# Page 5
story.append(p("4. Tooling surfaces and ownership", "H1Custom"))
story.append(OwnershipDiagram())
surface_rows = [
    ["Surface", "Primary job", "Show by default", "Avoid"],
    ["DM dashboard", "Orient in under 30 seconds.", "Pinned plans/views, current focus, ready encounters, linked entities, recent edits, secondary quick capture.", "A session agenda, all records, or required maintenance."],
    ["Planning workspace", "Build and reorganize extensive plans.", "Folder tree, item list, tags, search, archive, drag-and-drop, keyboard navigation.", "Using folders as story semantics or treating notes as the main product."],
    ["Planning editor", "Edit all kinds consistently.", "Title, body, named sections, kind, folder, tags, state, references, links, kind-specific fields.", "A separate form architecture for every kind."],
    ["Connections / backlinks", "Build and inspect precise relationships.", "Named incoming/outgoing links targeting an item or section, live core summaries, broken-reference diagnostics.", "Automatic inferred causality."],
    ["Planning graph", "Understand complex structure visually.", "Selected scope, item/section expansion, named edges, filters, legend, focus, list fallback.", "Opening the entire campaign or every section by default."],
    ["Encounter editor", "Prepare reusable challenges.", "Participants, place, setup, terrain, tactics, outcomes, optional external records.", "Rules adjudication, encounter balance, initiative, or combat state."],
    ["Import center", "Bring in prepared structures safely.", "Schema diagnostics, exact preview, atomic commit, stable IDs.", "Implicit overwrite or a second editing workflow."],
    ["Optional history", "Offer context when useful.", "Core events and optional backlinks from used plans.", "Mandatory results, progress journals, or DM-written session summaries."],
]
story.append(make_table(surface_rows, [27 * mm, 45 * mm, 63 * mm, CONTENT_W - 135 * mm]))
story.append(Spacer(1, 5 * mm))
story.append(p("Navigation recommendation", "H2Custom"))
story.append(
    bullets(
        [
            "Keep the stable <b>/dm</b> dashboard route as the entry point.",
            "Use one <b>/dm-plans</b> workspace with folder, list, editor, and graph modes; preserve the existing scenario route as a filtered deep link or redirect.",
            "Let every planning item, core entity, backlink list, and saved view deep-link to a focused graph.",
            "Treat the graph as a view mode within a domain page, not a separate source of truth.",
            "Keep core entity navigation in the host; DM Tools links into it using existing routes and collection descriptors.",
        ]
    )
)
story.append(PageBreak())

# Page 6
story.append(p("5. Storage, contracts, and safe evolution", "H1Custom"))
story.append(p("The main architectural risk is multiplying collections and editors every time a new planning concept appears. A common planning-item model keeps the addon small while discriminated validation prevents it from becoming an untyped document dump.", "BodyCustom"))
data_rows = [
    ["Collection", "Shape", "Access", "Notes"],
    ["planningItems", "Keyed", "DM-only", "Common fields plus stable named sections and kind: thread, quest, scenario, encounter, or note."],
    ["planningFolders", "Keyed", "DM-only", "Parent, title, display order, and cycle checks; navigation only."],
    ["planningLinks", "Keyed", "DM-only", "Named typed edges; endpoints may target an item, its stable section, or a permitted core entity."],
    ["planningViews", "Keyed, later", "DM-only", "Named filter/focus definitions only. Persist graph positions only if local layouts prove insufficient."],
    ["scenarios", "Legacy list", "DM-only", "Migrate once into planningItems with kind scenario; preserve IDs and import compatibility."],
]
story.append(make_table(data_rows, [31 * mm, 23 * mm, 29 * mm, CONTENT_W - 83 * mm]))
story.append(Spacer(1, 5 * mm))
story.append(p("Record evolution", "H2Custom"))
story.append(
    bullets(
        [
            "Add <b>schemaVersion</b> to persisted planning records before introducing new shapes.",
            "Ship additive, deterministic migrations with fixtures for old, mixed, partial, and repeated-startup states.",
            "Keep import schema versioning separate from persisted schema versioning. Imports describe input; migrations protect stored campaign data.",
            "Use host transactions for migrations and edits that create or remove items, folders, and links together.",
            "Centralize kind definitions, section-anchor rules, optional states, relation types, edge names, reference validation, and display metadata so every consumer agrees.",
        ]
    )
)
story.append(p("Visibility and publication", "H2Custom"))
story.append(
    Callout(
        "Private planning is the default boundary",
        "DM Tools should never expose planning items merely because they reference a public character or location. If a future feature publishes a quest card or handout, it creates an explicit public projection containing approved fields only; the source plan and its links remain private.",
        accent=RED,
        background=PALE_RED,
        height=32 * mm,
    )
)
story.append(Spacer(1, 4 * mm))
story.append(p("Integration contract", "H2Custom"))
story.append(
    bullets(
        [
            "DM Tools remains independently useful and has no hard dependency on sheets or the compendium.",
            "External encounter references use provider ID, record kind, record ID, and a fallback label so plans remain readable when the provider is absent.",
            "Expose a small versioned read API only after the model stabilizes: planning item summaries, references, and encounter preparation fields.",
            "Optional consumers may enrich views but must degrade cleanly when absent. Homebrew rules, encounter balance, combat, and sheet calculations stay outside DM Tools.",
        ]
    )
)
story.append(PageBreak())

# Page 7
story.append(p("6. Graph, encounter, and maintenance boundaries", "H1Custom"))
story.append(p("At expected campaign sizes, JSON and browser rendering are sufficient. Readability and maintenance cost will fail before storage scale, so every complex feature needs a narrow scope and an escape hatch.", "BodyCustom"))
scale_rows = [
    ["Concern", "Recommendation", "Reason"],
    ["Graph growth", "Open on a selected folder, thread, item, entity, or saved filter; collapse sections by default, expand them on demand, and keep a list.", "Section nodes provide precision but would quickly overwhelm an unscoped graph."],
    ["Dashboard growth", "Show pinned items/views, recent edits, quick capture, ready encounters, and small core summaries. Link to full pages.", "The dashboard should orient, not become another planner screen."],
    ["Change detection", "Use collection revisions or a deterministic content digest, not counts plus newest timestamp.", "Equivalent counts/timestamps can hide meaningful edits."],
    ["Reference integrity", "Diagnose dangling IDs, duplicate IDs, folder cycles, invalid kinds/states, broken section anchors, links, and providers without blocking unrelated content.", "Planning graphs amplify small reference errors into confusing visual failures."],
    ["External references", "Keep a fallback label and visibly mark unavailable provider records; never delete the plan when an addon disappears.", "Compendium, sheets, and future rules addons remain optional."],
    ["Encounter boundary", "Store setup and intent, not calculated difficulty or runtime combat state.", "Planning is edition-neutral; mechanics belong to a rules-aware addon."],
    ["Graph fallback", "Keep the accessible list usable when Cytoscape is missing, unsupported, or fails.", "Graph availability must not remove core planning functionality."],
]
story.append(make_table(scale_rows, [29 * mm, 83 * mm, CONTENT_W - 112 * mm]))
story.append(Spacer(1, 5 * mm))
story.append(p("Operational invariants", "H2Custom"))
story.append(
    bullets(
        [
            "Every ID is stable across imports, migration, reinstall, backup, and restore.",
            "Moving an item or folder changes navigation only; typed links and core references remain unchanged.",
            "Every cross-record reference is validated on write and reported on read if legacy or external data is inconsistent.",
            "Every multi-record item/folder/link update is atomic: either all selected updates publish or none do.",
            "Every derived graph can be recreated from persisted records; graph layout is presentation state only.",
            "Every optional integration has a usable absent-provider state.",
            "Every optional state transition has an explicit user action; no missing update creates a warning or blocks use.",
        ]
    )
)
story.append(p("Deferred until demanded by real play", "H2Custom"))
story.append(
    bullets(
        [
            "Custom item kinds, unlimited relation types, automatic quest progress, session plans, and predictive analytics.",
            "Encounter balance, initiative, runtime combat state, or homebrew-rule enforcement inside DM Tools.",
            "Player publication, session summaries, and result journals until actual use demonstrates value.",
            "Server-side graph positions and collaborative cursors until local layouts and named filters prove insufficient.",
        ]
    )
)
story.append(PageBreak())

# Page 8
story.append(p("7. Phased implementation plan", "H1Custom"))
story.append(p("The order is intentionally dependency-driven: define and protect the model before building screens that would freeze accidental semantics.", "BodyCustom"))
phases = [
    (
        1,
        "Domain foundation and migration",
            "Canonical kind, stable-section, reference, and named-link contracts; schemaVersion; three collections; migrate scenarios with stable IDs; diagnostics.",
        "Old data survives restart and backup/restore; invalid references are reported; no UI behavior regresses.",
        BLUE,
    ),
    (
        2,
        "Planning workspace",
        "Quick capture, folder tree, shared editor, stable named sections, kinds, tags, pin/archive, search, drag-and-drop, draft protection, import update.",
        "The DM can organize a substantial real plan without raw JSON, duplicate entities, or mandatory fields.",
        TEAL,
    ),
    (
        3,
        "Connections and graph",
        "Core references, item/section link endpoints, named edges, backlinks, collapsed/expanded graph nodes, focus, filters, legend, list fallback.",
        "A complex plot can be understood visually without opening a whole-campaign hairball.",
        GOLD,
    ),
    (
        4,
        "Encounter planning",
        "Encounter-specific fields, NPC/location references, optional provider records with fallback labels, reusable templates, graph participation.",
        "Combat, social, exploration, puzzle, and hazard setups work without importing rules logic into DM Tools.",
        RED,
    ),
    (
        5,
        "Dashboard and saved focus",
        "Quick capture, pinned items/views, recent edits, ready encounters, unresolved-mystery summary, shortcuts, optional named graph filters.",
        "The dashboard is useful every time it opens but never demands campaign bookkeeping.",
        BLUE,
    ),
    (
        6,
        "Optional history and integrations",
        "Event backlinks, derived player session history if wanted, versioned planning API, optional provider enrichment, future explicit publication.",
        "Removing any optional addon leaves plans readable; no retrospective workflow becomes mandatory.",
        TEAL,
    ),
]
for number, title, scope, gate, accent in phases:
    story.append(NumberedBox(number, title, f"<b>Build:</b> {scope}<br/><b>Gate:</b> {gate}", accent))
    story.append(Spacer(1, 3 * mm))
story.append(PageBreak())

# Page 9
story.append(p("8. Decisions, tradeoffs, and acceptance criteria", "H1Custom"))
decision_rows = [
    ["Decision", "Recommendation", "Tradeoff accepted"],
    ["Planning model", "One discriminated planning-item collection with five kinds and optional stable named sections.", "Kinds share infrastructure; strict validation is required to avoid a loose catch-all schema."],
    ["Organization", "Folders define navigation; typed links and references define meaning; graphs derive from links.", "Users maintain two distinct concepts, but moving notes never corrupts story relationships."],
    ["Session relationship", "No plan belongs to a session and no retrospective update is required.", "There is no dedicated DM run sheet or automatic campaign-progress report."],
    ["State tracking", "Optional shallow states only, with no percentages, clocks, or automatic transitions.", "Less automation, but almost no bookkeeping and no false precision."],
    ["Encounter boundary", "Store reusable setup and intent; delegate rule calculations and live combat to specialized addons.", "Some encounter enrichment is unavailable without a rules provider."],
    ["Integration", "Soft, versioned, capability-based APIs and fallback labels for external records.", "Providers can disappear without data loss, at the cost of visibly degraded enrichment."],
]
story.append(make_table(decision_rows, [33 * mm, 69 * mm, CONTENT_W - 102 * mm]))
story.append(Spacer(1, 6 * mm))
story.append(p("Release acceptance criteria", "H2Custom"))
story.append(
    bullets(
        [
            "<b>Understandable:</b> a new maintainer can explain planning kinds, folders, typed links, core references, and derived views without reading implementation code.",
            "<b>Recoverable:</b> migration, transaction failure, addon disable/re-enable, restart, backup, and restore preserve campaign data and stable IDs.",
            "<b>Fast to capture:</b> a body-only note can be saved in one action and organized later.",
            "<b>Organizable:</b> hundreds of notes can be navigated through folders, tags, search, pinning, backlinks, and archive without a new schema.",
            "<b>Agency-safe:</b> skipping, combining, unexpectedly resolving, or abandoning plans never invalidates data or forces record reorganization.",
            "<b>Graphable:</b> an NPC can have a named link to a whole quest or one named quest part; collapsed and expanded graphs preserve that meaning.",
            "<b>Optional:</b> DM Tools works without sheets, compendium, or future combat tooling; integrations fail closed and degrade visibly.",
        ]
    )
)
story.append(Spacer(1, 5 * mm))
story.append(
    Callout(
        "Recommended immediate next batch",
        "Implement Phase 1 only. Establish planning items, stable named sections, folders, named item/section links, references, migrations, and integrity contracts before UI work. Preserve scenario data; add no session ownership, automatic progress, or homebrew-rule fields.",
        accent=GOLD,
        background=PALE_GOLD,
        height=31 * mm,
    )
)
story.append(Spacer(1, 6 * mm))
story.append(p("Review basis", "H2Custom"))
story.append(
    p(
        "This plan is based on a source-level audit of the host and DM Tools contracts, current planning/import/graph/dashboard implementations, reference documentation, and the local campaign data shape. It does not sample either remote production campaign. No campaign names, prose, record IDs, or personal data are included.",
        "SmallCustom",
    )
)

doc.build(story)
print(OUTPUT)
