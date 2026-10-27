"""Compare real OCR blocks against a PDF text layer; this is an audit, not ground truth for formulas.

Usage: python scripts/audit-ocr-quality.py document.pdf state-or-report.json output.json
Requires pdfplumber. The report keeps the raw reference and OCR text for manual review.
"""
import html
import json
import re
import sys
import unicodedata
from pathlib import Path

import pdfplumber


IGNORED = re.compile(r"^(header|footer|page_number|number|formula_number|header_image|footer_image|seal|aside_text)$")
PROSE = {"text", "abstract", "doc_title", "paragraph_title", "figure_title", "table_title", "reference", "reference_content", "footnote"}


def normalized(text):
    text = unicodedata.normalize("NFKC", html.unescape(text)).replace("\u00ad", "")
    text = re.sub(r"(?<=[A-Za-z])-\s*\n\s*(?=[A-Za-z])", "", text)
    return re.sub(r"\s+", "", text)


def word_tokens(text):
    text = unicodedata.normalize("NFKC", html.unescape(text)).replace("\u00ad", "")
    text = re.sub(r"(?<=[A-Za-z])-\s*\n\s*(?=[A-Za-z])", "", text)
    return re.findall(r"\w+|[^\w\s]", text)


def edit_distance(reference, candidate):
    # Myers' bit-vector Levenshtein algorithm, including insertions and deletions.
    if not reference:
        return len(candidate)
    masks = {}
    for index, character in enumerate(reference):
        masks[character] = masks.get(character, 0) | (1 << index)
    positive, negative, distance = ~0, 0, len(reference)
    last = 1 << (len(reference) - 1)
    for character in candidate:
        equal = masks.get(character, 0)
        vertical = equal | negative
        horizontal = (((equal & positive) + positive) ^ positive) | equal
        plus = negative | ~(horizontal | positive)
        minus = positive & horizontal
        distance += bool(plus & last) - bool(minus & last)
        plus = (plus << 1) | 1
        minus <<= 1
        positive = minus | ~(vertical | plus)
        negative = plus & vertical
    return distance


def audit(pdf_path, result_path):
    state = json.loads(Path(result_path).read_text(encoding="utf-8"))
    pages = state["pages"]
    if isinstance(pages, dict):
        pages = list(pages.values())
    pages.sort(key=lambda page: page["page"])
    if any(page.get("features", {}).get("use_doc_unwarping") for page in pages):
        raise ValueError("校正后的坐标不能直接裁剪原 PDF。请用 --reference 指定已经核对的原文段落样本，或人工核对校正页面。")
    rows, page_reports, visible_orders = [], [], []
    display_order = 0
    with pdfplumber.open(pdf_path) as document:
        for parsed in pages:
            page = document.pages[parsed["page"] - 1]
            source_orders = [b.get("sourceOrder") for b in parsed["blocks"] if b.get("sourceOrder") is not None]
            uncovered = []
            for word in page.extract_words(x_tolerance_ratio=.15, y_tolerance=3):
                cx = (word["x0"] + word["x1"]) / (2 * page.width)
                cy = (word["top"] + word["bottom"]) / (2 * page.height)
                if .08 < cy < .95 and not word["text"].isdigit() and not any(
                    b["bbox"][0] - .002 <= cx <= b["bbox"][2] + .002 and
                    b["bbox"][1] - .002 <= cy <= b["bbox"][3] + .002 for b in parsed["blocks"]
                ):
                    uncovered.append({"text": word["text"], "x": round(cx, 4), "y": round(cy, 4)})
            page_reports.append({"page": parsed["page"], "blocks": len(parsed["blocks"]), "sourceOrders": source_orders,
                                 "sourceOrderMonotonic": source_orders == sorted(source_orders),
                                 "uncoveredWordsForReview": uncovered})
            for block in parsed["blocks"]:
                ignored = bool(IGNORED.match(block["type"]))
                if not ignored:
                    display_order += 1
                    visible_orders.append(block.get("order", display_order) if "blocks" in state else display_order)
                x0, top, x1, bottom = block["bbox"]
                x0, x1 = x0 * page.width - 1, x1 * page.width + 1
                top, bottom = top * page.height - 1, bottom * page.height + 1
                bounded = page.filter(lambda obj: obj.get("object_type") == "char" and
                                      x0 <= (obj["x0"] + obj["x1"]) / 2 <= x1 and
                                      top <= (obj["top"] + obj["bottom"]) / 2 <= bottom)
                reference = bounded.extract_text(x_tolerance_ratio=.15, y_tolerance=3) or ""
                expected, observed = normalized(reference), normalized(block["text"])
                distance = edit_distance(expected, observed)
                expected_words = word_tokens(reference)
                word_edits = edit_distance(expected_words, word_tokens(block["text"]))
                eligible = block["type"] in PROSE and len(expected) >= 20
                math_content = bool(re.search(r"[\\$\U0001d400-\U0001d7ff∑∫∥⊗]", reference + block["text"]))
                rows.append({"page": parsed["page"], "id": block["id"], "order": None if ignored else display_order,
                             "sourceOrder": block.get("sourceOrder"), "type": block["type"], "bbox": block["bbox"],
                             "confidence": block.get("confidence"), "proseComparison": eligible,
                             "plainProseComparison": eligible and not math_content,
                             "referenceCharacters": len(expected), "edits": distance,
                             "characterErrorRate": round(distance / max(1, len(expected)), 6),
                             "referenceWordTokens": len(expected_words), "wordEdits": word_edits,
                             "wordTokenErrorRate": round(word_edits / max(1, len(expected_words)), 6),
                             "reference": reference, "ocr": block["text"]})
    prose = [row for row in rows if row["proseComparison"]]
    plain = [row for row in rows if row["plainProseComparison"]]
    total = sum(row["referenceCharacters"] for row in prose)
    plain_total = sum(row["referenceCharacters"] for row in plain)
    return {"pdf": str(Path(pdf_path).resolve()), "source": "PDF text layer bounded by OCR boxes; independently inspect omissions and formulas",
            "normalization": "NFKC, remove whitespace and line-end word hyphens; case and punctuation retained",
            "requestedPageCount": len(document.pages), "recognizedPages": len(pages), "blocks": len(rows),
            "proseBlocks": len(prose), "proseReferenceCharacters": total,
            "proseCharacterErrorRate": sum(row["edits"] for row in prose) / max(1, total),
            "plainProseBlocks": len(plain), "plainProseReferenceCharacters": plain_total,
            "plainProseCharacterErrorRate": sum(row["edits"] for row in plain) / max(1, plain_total),
            "plainProseWordTokenErrorRate": sum(row["wordEdits"] for row in plain) / max(1, sum(row["referenceWordTokens"] for row in plain)),
            "visibleNumberGaps": [[a, b] for a, b in zip(visible_orders, visible_orders[1:]) if b != a + 1],
            "pages": page_reports, "comparisons": rows}


def audit_aligned_samples(pdf_path, result_path, reference_path):
    """Compare complete reference paragraphs with 1–3 consecutive OCR blocks.

    The independent reference is extracted from the original PDF using the old,
    unwarped page coordinates. It is a sample audit, not whole-document accuracy.
    No corrected-image box is ever projected onto the original text layer.
    """
    state = json.loads(Path(result_path).read_text(encoding="utf-8"))
    reference = json.loads(Path(reference_path).read_text(encoding="utf-8"))
    samples = [row for row in reference["comparisons"] if row["plainProseComparison"] and row["referenceCharacters"] >= 80]
    pages = state["pages"] if isinstance(state["pages"], list) else list(state["pages"].values())
    compared = []
    for sample in samples:
        expected = normalized(sample["reference"])
        parsed = next((page for page in pages if page["page"] == sample["page"]), {"blocks": []})
        blocks = [block for block in parsed["blocks"] if block["type"] in PROSE]
        candidates = []
        for index in range(len(blocks)):
            for count in range(1, 4):
                selected = blocks[index:index + count]
                candidate = "\n".join(block["text"] for block in selected)
                observed = normalized(candidate)
                if not .4 * len(expected) <= len(observed) <= 2 * len(expected):
                    continue
                distance = edit_distance(expected, observed)
                candidates.append((distance, selected, candidate))
        if candidates:
            edits, selected, candidate = min(candidates, key=lambda item: item[0])
        else:
            edits, selected, candidate = len(expected), [], ""
        compared.append({"page": sample["page"], "sourceSample": sample["id"],
                         "matchedBlocks": [block["id"] for block in selected],
                         "referenceCharacters": len(expected), "edits": edits,
                         "characterErrorRate": edits / max(1, len(expected)),
                         "needsAlignmentReview": edits > .15 * len(expected),
                         "reference": sample["reference"], "ocr": candidate})
    characters = sum(row["referenceCharacters"] for row in compared)
    return {"pdf": str(Path(pdf_path).resolve()), "source": "Original PDF text-layer prose samples, aligned by complete paragraph text; coordinates from corrected pages are not used",
            "scope": "Sampled plain prose only. Does not measure formulas, tables, charts, omitted unselected paragraphs or whole-document accuracy. Inspect uncertain alignments individually.",
            "referenceReport": str(Path(reference_path).resolve()), "recognizedPages": len(pages),
            "sampledParagraphs": len(compared), "referenceCharacters": characters,
            "edits": sum(row["edits"] for row in compared),
            "sampleCharacterErrorRate": sum(row["edits"] for row in compared) / max(1, characters),
            "uncertainAlignments": [row["sourceSample"] for row in compared if row["needsAlignmentReview"]],
            "comparisons": compared}


if __name__ == "__main__":
    result = audit_aligned_samples(sys.argv[1], sys.argv[2], sys.argv[5]) if len(sys.argv) > 5 and sys.argv[4] == "--reference" else audit(sys.argv[1], sys.argv[2])
    Path(sys.argv[3]).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key not in {"comparisons", "pages"}}, ensure_ascii=False, indent=2))
