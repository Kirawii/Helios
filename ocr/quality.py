"""Recover low-confidence text after an incorrect 180-degree line prediction.

The orientation classifier stays enabled. We re-read only uncertain rotated
lines in their original direction and accept a replacement only when its OCR
confidence is substantially higher. Source coordinates never change.
"""
import re
import copy
import html


def normalize_math_syntax(text):
    # A fused index after a relation is an invalid control sequence, e.g.
    # \neqi from the recognizer should be \neq i. Preserve valid longer macros.
    return re.sub(r"\\(neq|leq|geq)([ijkn])\b", r"\\\1 \2", text)


class RecoveringOCR:
    def __init__(self, pipeline):
        self.pipeline = pipeline

    def __getattr__(self, name):
        return getattr(self.pipeline, name)

    def __call__(self, *args, **kwargs):
        for result in self.pipeline(*args, **kwargs):
            angles = result.get("textline_orientation_angles", [])
            scores = result.get("rec_scores", [])
            if len(angles) != len(scores):
                yield result
                continue
            indices = [index for index, (angle, score) in enumerate(zip(angles, scores)) if angle == 1 and float(score) < .85]
            if indices:
                image = result["doc_preprocessor_res"]["output_img"]
                crops = list(self.pipeline._crop_by_polys(image, [result["rec_polys"][index] for index in indices]))
                recoveries = []
                for index, candidate in zip(indices, self.pipeline.text_rec_model(crops)):
                    previous = float(scores[index])
                    if float(candidate["rec_score"]) >= max(.65, previous + .10):
                        recoveries.append({"line": index, "from": 180, "to": 0, "before": result["rec_texts"][index], "after": candidate["rec_text"], "beforeScore": previous, "afterScore": float(candidate["rec_score"])})
                        result["rec_texts"][index] = candidate["rec_text"]
                        scores[index] = candidate["rec_score"]
                        angles[index] = 0
                result["orientation_recoveries"] = recoveries
            yield result

    predict = __call__


def install_orientation_recovery(pipeline):
    # PaddleX wraps each single-device pipeline. Replace its OCR child, keeping
    # model objects and all other modules intact; never modify installed files.
    internal = vars(pipeline).get("_pipeline", pipeline)
    for name in ("general_ocr_pipeline", "ocr_pipeline"):
        child = vars(internal).get(name)
        if child is not None and not isinstance(child, RecoveringOCR) and getattr(child, "text_type", None) == "general":
            setattr(internal, name, RecoveringOCR(child))
    for name in ("table_recognition_pipeline", "seal_recognition_pipeline"):
        child = vars(internal).get(name)
        if child is not None:
            install_orientation_recovery(child)


def fill_empty_table_cells(primary, alternate):
    """Fill only unambiguous gaps from the other official table algorithm.

    Rows must have a unique identical label and column count, with no spanning
    cells. Existing primary values are never overwritten. Each fill is recorded.
    """
    row_pattern = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.I | re.S)
    cell_pattern = re.compile(r"<(td|th)\b([^>]*)>(.*?)</\1>", re.I | re.S)
    plain = lambda value: re.sub(r"\s+", "", html.unescape(re.sub(r"<[^>]+>", "", value)))
    rows = list(row_pattern.finditer(primary))
    if re.search(r"(?:rowspan|colspan)\s*=\s*['\"]?(?:[2-9]|[1-9][0-9])", primary, re.I):
        return primary, []
    alternatives = {}
    for row in row_pattern.finditer(alternate):
        cells = list(cell_pattern.finditer(row[1]))
        if cells:
            alternatives.setdefault(plain(cells[0][3]), []).append(cells)
    replacements, repairs = [], []
    for row in rows:
        cells = list(cell_pattern.finditer(row[1]))
        if not cells:
            continue
        label = plain(cells[0][3])
        matches = alternatives.get(label, [])
        if not label or len(matches) != 1 or len(cells) != len(matches[0]):
            continue
        for index, (cell, other) in enumerate(zip(cells, matches[0])):
            if index == 0 or plain(cell[3]) or not plain(other[3]):
                continue
            value = plain(other[3])
            if len(value) > 120 or len(re.findall(r"\d+(?:\.\d+)?(?:±|\\pm)", value)) > 1:
                continue
            start = row.start(1) + cell.start(3)
            replacements.append((start, row.start(1) + cell.end(3), other[3]))
            repairs.append({"row": label, "column": index + 1, "text": html.unescape(re.sub(r"<[^>]+>", "", other[3]))})
    for start, end, value in sorted(replacements, reverse=True):
        primary = primary[:start] + value + primary[end:]
    return primary, repairs


class RecoveringTables:
    def __init__(self, pipeline):
        self.pipeline = pipeline

    def __getattr__(self, name):
        return getattr(self.pipeline, name)

    def __call__(self, *args, **kwargs):
        alternate_kwargs = copy.deepcopy(kwargs)
        primary_kwargs = {**kwargs, "use_e2e_wired_table_rec_model": False, "use_e2e_wireless_table_rec_model": False}
        primary = list(self.pipeline(*args, **primary_kwargs))
        if any(result.get("table_res_list") for result in primary):
            alternate = list(self.pipeline(*args, **{**alternate_kwargs, "use_e2e_wired_table_rec_model": True, "use_e2e_wireless_table_rec_model": True}))
            for result, other in zip(primary, alternate):
                for table, other_table in zip(result["table_res_list"], other["table_res_list"]):
                    original = table["pred_html"]
                    repaired, changes = fill_empty_table_cells(original, other_table["pred_html"])
                    table["pred_html"] = repaired
                    table["quality_repairs"] = {"filledCells": changes, "primaryHtml": original, "alternateHtml": other_table["pred_html"]}
        yield from primary

    predict = __call__


class CapturingPreprocessor:
    def __init__(self, pipeline):
        self.pipeline, self.sources = pipeline, []

    def __getattr__(self, name):
        return getattr(self.pipeline, name)

    def __call__(self, *args, **kwargs):
        self.sources = []
        for result in self.pipeline(*args, **kwargs):
            live = result["output_img"]
            self.sources.append({"live": live, "clean": live.copy()})
            yield result

    predict = __call__


class UnmaskedCharts:
    def __init__(self, model, capture):
        self.model, self.capture = model, capture

    def __getattr__(self, name):
        return getattr(self.model, name)

    def __call__(self, *args, **kwargs):
        # Formula masks are needed for general OCR. The chart model needs the
        # original legends and axes, which can themselves be detected as formulas.
        for source in self.capture.sources:
            source["live"][...] = source["clean"]
        yield from self.model(*args, **kwargs)

    predict = __call__


def install_quality_adapters(pipeline):
    internal = vars(pipeline).get("_pipeline", pipeline)
    install_orientation_recovery(pipeline)
    capture = CapturingPreprocessor(internal.doc_preprocessor_pipeline)
    internal.doc_preprocessor_pipeline = capture
    internal.chart_recognition_model = UnmaskedCharts(internal.chart_recognition_model, capture)
    internal.table_recognition_pipeline = RecoveringTables(internal.table_recognition_pipeline)
    return capture
