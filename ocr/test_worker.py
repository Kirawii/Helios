import unittest
from worker import normalize_page


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


if __name__ == "__main__":
    unittest.main()
