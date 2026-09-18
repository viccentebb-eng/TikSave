import unittest

from app.url_utils import canonicalize_http_url, extract_http_urls


class UrlUtilsTests(unittest.TestCase):
    def test_extracts_douyin_url_from_shared_text(self):
        text = (
            "1.07 B@T.yT 11/17 :4pm FUy:/ 听见胸膛心在跳 "
            "https://v.douyin.com/2Dq2Z9iH3EY/ "
            "复制此链接，打开Dou音搜索，直接观看视频！"
        )
        self.assertEqual(
            extract_http_urls(text),
            ["https://v.douyin.com/2Dq2Z9iH3EY/"],
        )
        self.assertEqual(
            canonicalize_http_url(text),
            "https://v.douyin.com/2Dq2Z9iH3EY/",
        )

    def test_strips_share_punctuation_and_fragment(self):
        self.assertEqual(
            canonicalize_http_url("Mira esto: https://example.com/a?x=1#preview)。"),
            "https://example.com/a?x=1",
        )

    def test_keeps_multiple_urls_unique(self):
        text = "https://example.com/a https://example.com/a https://example.com/b"
        self.assertEqual(
            extract_http_urls(text),
            ["https://example.com/a", "https://example.com/b"],
        )


if __name__ == "__main__":
    unittest.main()
