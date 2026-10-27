import unittest
from worker import normalize_page, enabled_features, FEATURES
from quality import RecoveringOCR, normalize_math_syntax, fill_empty_table_cells, CapturingPreprocessor, UnmaskedCharts


class NormalizePageTests(unittest.TestCase):
    def test_reading_order_and_types(self):
        result = {"res": {"parsing_res_list": [
            {"block_id": 7, "block_order": 1, "block_label": "paragraph_title", "block_content": "Methods", "block_bbox": [10, 10, 90, 20]},
            {"block_id": 2, "block_order": 2, "block_label": "text", "block_content": "Left column", "block_bbox": [10, 30, 45, 90]},
            {"block_id": 9, "block_order": 3, "block_label": "text", "block_content": "Right column", "block_bbox": [55, 30, 90, 90]},
            {"block_id": 10, "block_order": None, "block_label": "formula", "block_content": "x=2", "block_bbox": [10, 100, 90, 120]},
        ]}}
        page = normalize_page(result, 2, 100, 200)
        self.assertEqual([block["id"] for block in page["blocks"]], ["p2-b7", "p2-b2", "p2-b9", "p2-b10"])
        self.assertEqual([block["order"] for block in page["blocks"]], [1, 2, 3, 4])
        self.assertEqual(page["blocks"][2]["bbox"], [.55, .15, .9, .45])
        self.assertEqual(page["blocks"][3]["type"], "formula")
        self.assertIsNone(page["blocks"][3]["sourceOrder"])

    def test_confidence_and_clamping(self):
        page = normalize_page({"parsing_res_list": [
            {"block_bbox": [-1, -1, 110, 50], "block_content": "Body"},
        ], "overall_ocr_res": {"rec_polys": [[[1, 1], [20, 1], [20, 10], [1, 10]]], "rec_scores": [.92]}}, 1, 100, 100)
        self.assertEqual(page["blocks"][0]["bbox"], [0, 0, 1, .5])
        self.assertEqual(page["blocks"][0]["confidence"], .92)

    def test_missing_structure_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "阅读顺序"):
            normalize_page({}, 1, 100, 100)

    def test_blank_page(self):
        self.assertEqual(normalize_page({"parsing_res_list": []}, 3, 100, 200)["blocks"], [])

    def test_all_modules_must_be_active_in_actual_result(self):
        result = {"model_settings": {**FEATURES, "use_doc_preprocessor": True},
                  "doc_preprocessor_res": {"model_settings": {"use_doc_orientation_classify": True, "use_doc_unwarping": True}},
                  "overall_ocr_res": {"model_settings": {"use_textline_orientation": True}}}
        self.assertTrue(all(enabled_features(result).values()))
        result["model_settings"]["use_chart_recognition"] = False
        with self.assertRaisesRegex(RuntimeError, "use_chart_recognition"):
            enabled_features(result)

    def test_fused_latex_index_keeps_relation_and_index(self):
        self.assertEqual(normalize_math_syntax(r"\substack{j=1\\j\neqi}"), r"\substack{j=1\\j\neq i}")
        self.assertEqual(normalize_math_syntax(r"\infty\leqslant x\geqq y"), r"\infty\leqslant x\geqq y")

    def test_orientation_classifier_stays_enabled_with_confidence_recovery(self):
        class FakeOCR:
            def __call__(self):
                yield {"textline_orientation_angles": [1, 1, 0], "rec_scores": [.2, .76, .3], "rec_texts": ["upside down", "keep", "upright"],
                       "rec_polys": ["first", "second", "third"], "doc_preprocessor_res": {"output_img": "source"}, "model_settings": {"use_textline_orientation": True}}
            def _crop_by_polys(self, image, polygons):
                self.test_image = image
                return polygons
            def text_rec_model(self, crops):
                for text, score in [("Readable text", .96), ("uncertain alternative", .80)]:
                    yield {"rec_text": text, "rec_score": score}
        pipeline = FakeOCR()
        result = list(RecoveringOCR(pipeline)())[0]
        self.assertEqual(result["rec_texts"], ["Readable text", "keep", "upright"])
        self.assertEqual(result["textline_orientation_angles"], [0, 1, 0])
        self.assertEqual(result["rec_polys"], ["first", "second", "third"])
        self.assertTrue(result["model_settings"]["use_textline_orientation"])
        self.assertEqual(len(result["orientation_recoveries"]), 1)

    def test_table_gap_fill_matches_unique_row_and_preserves_existing_cells(self):
        primary = '<table><tr><td>DSF</td><td></td><td>79.01 ± 0.10</td></tr></table>'
        alternate = '<table><tr><td>DSF</td><td>83.10 ± 0.30</td><td>wrong alternative</td></tr></table>'
        repaired, changes = fill_empty_table_cells(primary, alternate)
        self.assertIn('<td>83.10 ± 0.30</td>', repaired)
        self.assertIn('79.01 ± 0.10', repaired)
        self.assertEqual(len(changes), 1)
        merged = alternate.replace('83.10 ± 0.30', '83.10 ± 0.30 82.50 ± 0.01')
        self.assertEqual(fill_empty_table_cells(primary, merged), (primary, []))
        duplicated = alternate.replace('</table>', '<tr><td>DSF</td><td>different</td><td>value</td></tr></table>')
        self.assertEqual(fill_empty_table_cells(primary, duplicated), (primary, []))

    def test_chart_sees_unmasked_source_with_original_colors(self):
        class Pixels:
            def __init__(self, values): self.values = values
            def copy(self): return Pixels(self.values[:])
            def __setitem__(self, key, other): self.values = other.values[:]
        image = Pixels([0, 0, 255])
        class Preprocessor:
            def __call__(self): yield {"output_img": image}
        capture = CapturingPreprocessor(Preprocessor())
        list(capture())
        image.values = [255, 255, 255]
        def model():
            self.assertEqual(image.values, [0, 0, 255])
            yield {"result": "legend retained"}
        self.assertEqual(list(UnmaskedCharts(model, capture)())[0]["result"], "legend retained")


if __name__ == "__main__":
    unittest.main()
