import contextlib
import importlib.metadata
import json
import os
import sys
import traceback

protocol_output = sys.stdout
pipeline = None


def emit(message):
    protocol_output.write(json.dumps(message, ensure_ascii=False) + "\n")
    protocol_output.flush()


def normalize_page(result, page_number, width, height):
    data = result.get("res", result)
    parsed = data.get("parsing_res_list")
    if not isinstance(parsed, list):
        raise ValueError("PaddleOCR 未返回版面阅读顺序")
    ocr = data.get("overall_ocr_res", {})
    polygons = ocr.get("rec_polys", [])
    scores = ocr.get("rec_scores", [])
    blocks = []
    for index, entry in enumerate(parsed):
        bounds = [float(value) for value in entry["block_bbox"]]
        left, top, right, bottom = bounds
        if right <= left or bottom <= top:
            continue
        label = str(entry.get("block_label", "text"))
        confidence_values = []
        for polygon, score in zip(polygons, scores):
            center_x = sum(float(point[0]) for point in polygon) / len(polygon)
            center_y = sum(float(point[1]) for point in polygon) / len(polygon)
            if left <= center_x <= right and top <= center_y <= bottom:
                confidence_values.append(float(score))
        bounds = [max(0, min(1, left / width)), max(0, min(1, top / height)),
                  max(0, min(1, right / width)), max(0, min(1, bottom / height))]
        blocks.append({
            "id": f"p{page_number}-b{entry.get('block_id', index)}",
            "page": page_number,
            "order": len(blocks) + 1,
            "sourceOrder": entry.get("block_order"),
            "type": label,
            "text": str(entry.get("block_content", "")),
            "bbox": bounds,
            "confidence": sum(confidence_values) / len(confidence_values) if confidence_values else None,
        })
    return {"page": page_number, "width": width, "height": height, "blocks": blocks}


def parse_document(request):
    global pipeline
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import pypdfium2 as pdfium
        from paddleocr import PPStructureV3

        if pipeline is None:
            emit({"event": "loading", "requestId": request["requestId"]})
            pipeline = PPStructureV3(
                device=os.environ.get("HELIOS_OCR_DEVICE", "cpu"),
                cpu_threads=max(1, min(8, int(os.environ.get("HELIOS_OCR_THREADS", "2")))),
                use_doc_orientation_classify=False,
                use_doc_unwarping=False, use_textline_orientation=False,
                use_table_recognition=True, use_formula_recognition=True,
                use_chart_recognition=False,
            )
        document = pdfium.PdfDocument(request["path"])
        try:
            total_pages = len(document)
            if total_pages != request["pageCount"]:
                raise ValueError("PDF 页数与文献库不一致，请重新导入")
            selected = request.get("pages", list(range(1, total_pages + 1)))
            for page_number in selected:
                page = document[page_number - 1]
                bitmap = page.render(scale=2)
                try:
                    image = bitmap.to_pil().convert("RGB")
                    output = list(pipeline.predict(np.array(image, copy=True)))
                    if len(output) != 1:
                        raise ValueError("PaddleOCR 页面输出数量异常")
                    result = output[0].json
                    if isinstance(result, str):
                        result = json.loads(result)
                    normalized = normalize_page(result, page_number, image.width, image.height)
                    emit({"event": "page", "requestId": request["requestId"], "data": normalized})
                finally:
                    bitmap.close()
                    page.close()
        finally:
            document.close()
    emit({"event": "done", "requestId": request["requestId"], "signature": signature()})


def signature():
    return "PP-StructureV3:" + os.environ.get("HELIOS_OCR_DEVICE", "cpu") + ":144dpi:unwarping-off:" + ":".join(
        importlib.metadata.version(package) for package in ("paddleocr", "paddlepaddle", "pypdfium2")
    )


def main():
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if request.get("action") == "health":
                emit({"event": "done", "requestId": request["requestId"], "signature": signature()})
            else:
                parse_document(request)
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({"event": "error", "requestId": request.get("requestId"), "error": str(error)[:500]})


if __name__ == "__main__":
    main()
