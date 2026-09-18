import unittest
from urllib.parse import urlsplit

import app.dezoom as dezoom


class DezoomRegressionTests(unittest.TestCase):
    def test_regex_module_is_available_for_progress_parser(self):
        self.assertIsNotNone(dezoom.re.search(r"\d+%", "42%"))

    def test_google_arts_asset_can_be_stripped_to_canonical_path(self):
        value = (
            "https://artsandculture.google.com/asset/example/abc123"
            "?ms=%7B%22x%22%3A0.5%2C%22z%22%3A10%7D"
        )
        parsed = urlsplit(value)
        canonical = parsed._replace(query="", fragment="").geturl()
        self.assertEqual(
            canonical,
            "https://artsandculture.google.com/asset/example/abc123",
        )


if __name__ == "__main__":
    unittest.main()
