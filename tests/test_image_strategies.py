import unittest

from app.analyzer import _classify_generic
from app.native_image import generate_candidates


class ImageStrategyTests(unittest.TestCase):
    def urls_for(self, url):
        return {item.url: item.rule for item in generate_candidates(url)}

    def test_googleusercontent_generates_unlimited_candidate(self):
        candidates = self.urls_for(
            "https://lh3.googleusercontent.com/example=w483-h706"
        )
        self.assertTrue(
            any(rule == "google:s0" for rule in candidates.values()),
            candidates,
        )

    def test_meta_cdn_strips_stp_resize_recipe(self):
        candidates = generate_candidates(
            "https://scontent.cdninstagram.com/v/t51.2885-15/example.jpg"
            "?stp=dst-jpg_s640x640&_nc_cat=100&_nc_sid=abc"
        )
        self.assertTrue(
            any(item.rule == "meta:strip-stp-size" for item in candidates),
            [item.rule for item in candidates],
        )

    def test_bytedance_tplv_candidate_is_generated(self):
        candidates = generate_candidates(
            "https://p19-sign.douyinpic.com/tos-cn-i-0813/example~tplv-obj.image"
        )
        self.assertTrue(
            any(item.rule.startswith("bytedance:strip-tplv") for item in candidates),
            [item.rule for item in candidates],
        )

    def test_google_arts_asset_prefers_dezoom_for_maximum(self):
        url = "https://artsandculture.google.com/asset/guadalupana/iwFgVDce0qPTxw"
        html = b"""
            <html>
              <head><title>Guadalupana</title></head>
              <body><img src="https://lh3.googleusercontent.com/example=w483-h706"></body>
            </html>
        """
        result = _classify_generic(url, url, "text/html", html, "utf-8")

        self.assertEqual(result["kind"], "artwork")
        self.assertTrue(
            any(
                item.get("kind") == "Google Arts & Culture"
                and item.get("url") == url
                for item in result["zoom_sources"]
            )
        )
        maximum = next(
            item for item in result["capabilities"] if item["id"] == "image_max"
        )
        self.assertEqual(maximum.get("strategy"), "dezoom")
        self.assertEqual(maximum.get("source_url"), url)


if __name__ == "__main__":
    unittest.main()
