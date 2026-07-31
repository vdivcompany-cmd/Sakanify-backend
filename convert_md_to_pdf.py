#!/usr/bin/env python3

import sys
from reportlab.lib.pagesizes import letter, A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Read markdown file
md_file = sys.argv[1] if len(sys.argv) > 1 else "phase-1-auth-report.md"
pdf_file = sys.argv[2] if len(sys.argv) > 2 else "phase-1-auth-report.pdf"

# Read content
with open(md_file, 'r', encoding='utf-8') as f:
    content = f.read()

# Try to register a Unicode-supporting font (fallback to default if not available)
try:
    pdfmetrics.registerFont(TTFont('DejaVuSans', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
    pdfmetrics.registerFont(TTFont('DejaVuSans-Bold', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
    font_name = 'DejaVuSans'
    bold_font_name = 'DejaVuSans-Bold'
except:
    font_name = 'Helvetica'
    bold_font_name = 'Helvetica-Bold'

# Create styles
styles = getSampleStyleSheet()

# Override styles to use Unicode-capable font
title_style = ParagraphStyle(
    'CustomTitle',
    parent=styles['Heading1'],
    fontSize=18,
    textColor=colors.HexColor('#1a1a1a'),
    spaceAfter=12,
    fontName=bold_font_name,
)

heading_style = ParagraphStyle(
    'CustomHeading',
    parent=styles['Heading2'],
    fontSize=14,
    textColor=colors.HexColor('#333333'),
    spaceAfter=10,
    spaceBefore=10,
    fontName=bold_font_name,
)

body_style = ParagraphStyle(
    'CustomBody',
    parent=styles['Normal'],
    fontSize=11,
    fontName=font_name,
    leading=14,
)

# Create PDF
doc = SimpleDocTemplate(pdf_file, pagesize=A4, rightMargin=0.75*inch, leftMargin=0.75*inch)
story = []

# Split content by lines and process
lines = content.split('\n')
i = 0
while i < len(lines):
    line = lines[i].strip()
    
    if not line:
        story.append(Spacer(1, 0.1*inch))
        i += 1
        continue
    
    # H1 (# Title)
    if line.startswith('# ') and not line.startswith('## '):
        text = line[2:].strip()
        story.append(Paragraph(text, title_style))
        story.append(Spacer(1, 0.2*inch))
        i += 1
    
    # H2 (## Subtitle)
    elif line.startswith('## '):
        text = line[3:].strip()
        story.append(Paragraph(text, heading_style))
        story.append(Spacer(1, 0.1*inch))
        i += 1
    
    # Regular text
    else:
        story.append(Paragraph(line, body_style))
        i += 1

# Build PDF
try:
    doc.build(story)
    print(f"✓ PDF created: {pdf_file}")
except Exception as e:
    print(f"✗ Error: {e}")
    sys.exit(1)
