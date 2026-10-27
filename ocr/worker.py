import contextlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time
import traceback
from quality import install_quality_adapters, normalize_math_syntax

protocol_output = sys.stdout
pipeline = None
preprocessing_capture = None


FEATURES = {"use_doc_orientation_classify": True, "use_doc_unwarping": True,
            "use_textline_orientation": True, "use_seal_recognition": True,
            "use_table_recognition": True, "use_formula_recognition": True,
            "use_chart_recognition": True, "use_region_detection": True}


def paddle_version():
    for package in ("paddlepaddle-gpu", "paddlepaddle"):
        try:
            return importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            pass
    raise RuntimeError("未安装 PaddlePaddle 运行环境")


def emit(message):
    protocol_output.write(json.dumps(message, ensure_ascii=False) + "\n")
    protocol_output.flush()


def enabled_features(data):
    settings = data.get("model_settings", {})
    preprocessing = data.get("doc_preprocessor_res", {}).get("model_settings", {})
    ocr = data.get("overall_ocr_res", {}).get("model_settings", {})
    actual = {key: settings.get(key) is True for key in FEATURES}
    for key in ("use_doc_orientation_classify", "use_doc_unwarping"):
        actual[key] = settings.get("use_doc_preprocessor") is True and preprocessing.get(key) is True
    actual["use_textline_orientation"] = ocr.get("use_textline_orientation") is True
    missing = [key for key, enabled in actual.items() if not enabled]
    if missing:
        raise RuntimeError("完整识别模块未生效：" + ", ".join(missing))
    return actual


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
        raw_text = str(entry.get("block_content", ""))
        text = normalize_math_syntax(raw_text) if label in ("formula", "equation") or "$" in raw_text else raw_text
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
            "text": text,
            "bbox": bounds,
            "confidence": sum(confidence_values) / len(confidence_values) if confidence_values and label not in ("formula", "equation", "table", "chart") else None,
            "format": "latex" if label in ("formula", "equation") else "html" if label == "table" else "chart" if label == "chart" else "text",
        })
        if text != raw_text:
            blocks[-1]["rawText"] = raw_text
    return {"page": page_number, "width": width, "height": height, "blocks": blocks}


def parse_document(request):
    global pipeline, preprocessing_capture
    if pipeline is None:
        emit({"event": "loading", "requestId": request["requestId"], "device": os.environ.get("HELIOS_OCR_DEVICE", "cpu")})
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        from PIL import Image
        import pypdfium2 as pdfium
        from paddleocr import PPStructureV3

        if pipeline is None:
            # Paddle 3.3.x has a oneDNN/PIR regression on layout models. Windows
            # installs 3.2.2 to retain acceleration; keep a fallback for old installs.
            device = os.environ.get("HELIOS_OCR_DEVICE", "cpu")
            import paddle
            if device.startswith("gpu") and (not paddle.is_compiled_with_cuda() or paddle.device.cuda.device_count() < 1):
                raise RuntimeError("GPU 识别环境不可用，请运行 npm run setup:ocr -- --gpu；不会自动关闭识别功能")
            compatibility = {"enable_mkldnn": False} if device == "cpu" and paddle_version().startswith("3.3.") else {}
            pipeline = PPStructureV3(
                **compatibility,
                **FEATURES,
                device=device,
                cpu_threads=max(1, min(8, int(os.environ.get("HELIOS_OCR_THREADS", "2")))),
                formula_recognition_batch_size=1, chart_recognition_batch_size=1,
                text_recognition_batch_size=8, seal_text_recognition_batch_size=1,
                textline_orientation_batch_size=8, format_block_content=False,
            )
            preprocessing_capture = install_quality_adapters(pipeline.paddlex_pipeline)
        output_directory = Path(request["outputDirectory"]).resolve()
        output_directory.mkdir(parents=True, exist_ok=True)
        document = pdfium.PdfDocument(request["path"])
        try:
            total_pages = len(document)
            if total_pages != request["pageCount"]:
                raise ValueError("PDF 页数与文献库不一致，请重新导入")
            selected = request.get("pages", list(range(1, total_pages + 1)))
            for page_number in selected:
                started = time.monotonic()
                emit({"event": "progress", "requestId": request["requestId"], "page": page_number})
                page = document[page_number - 1]
                bitmap = page.render(scale=2)
                try:
                    image = bitmap.to_pil().convert("RGB")
                    # PaddleX uses BGR arrays. Coordinates refer to the corrected
                    # image, which is saved after formula patches are restored.
                    output = list(pipeline.predict(np.ascontiguousarray(np.array(image, copy=True)[:, :, ::-1])))
                    if len(output) != 1:
                        raise ValueError("PaddleOCR 页面输出数量异常")
                    result = output[0].json
                    if isinstance(result, str):
                        result = json.loads(result)
                    data = result.get("res", result)
                    data["chart_res_list"] = output[0].get("chart_res_list", [])
                    data["quality_corrections"] = {"textlineOrientation": output[0]["overall_ocr_res"].get("orientation_recoveries", [])}
                    data["quality_corrections"]["tables"] = [table.get("quality_repairs", {}) for table in output[0].get("table_res_list", [])]
                    region = output[0].get("region_det_res")
                    if region is not None and hasattr(region, "json"):
                        data["region_det_res"] = region.json.get("res", region.json)
                    corrected = preprocessing_capture.sources[0]["clean"]
                    height, width = corrected.shape[:2]
                    normalized = normalize_page(result, page_number, width, height)
                    source_name = f"page-{page_number}.png"
                    Image.fromarray(corrected[:, :, ::-1]).save(output_directory / source_name)
                    (output_directory / f"page-{page_number}.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
                    normalized["sourceImage"] = source_name
                    normalized["features"] = enabled_features(data)
                    normalized["preprocessing"] = data.get("doc_preprocessor_res", {})
                    normalized["modelSettings"] = data.get("model_settings", {})
                    normalized["qualityCorrections"] = data["quality_corrections"]
                    normalized["runtime"] = {"device": os.environ.get("HELIOS_OCR_DEVICE", "cpu"), "paddle": paddle_version()}
                    normalized["elapsedSeconds"] = round(time.monotonic() - started, 2)
                    emit({"event": "page", "requestId": request["requestId"], "data": normalized})
                finally:
                    bitmap.close()
                    page.close()
        finally:
            document.close()
    emit({"event": "done", "requestId": request["requestId"], "signature": signature()})


def signature():
    return "PP-StructureV3:" + os.environ.get("HELIOS_OCR_DEVICE", "cpu") + ":144dpi:utf8:all-features-quality-v4:" + ":".join(
        [importlib.metadata.version("paddleocr"), paddle_version(), importlib.metadata.version("pypdfium2")])


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
