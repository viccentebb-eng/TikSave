import unittest

from app.downloader import JobStore, TikSaveDownloader


class JobAndSessionTests(unittest.TestCase):
    def test_douyin_has_firefox_session_fallback(self):
        attempts = TikSaveDownloader._attempts_for("douyin")
        self.assertGreaterEqual(len(attempts), 2)
        self.assertFalse(attempts[0][1])
        self.assertTrue(attempts[-1][1])

    def test_instagram_has_firefox_session_fallback(self):
        self.assertTrue(TikSaveDownloader._attempts_for("instagram")[-1][1])

    def test_youtube_does_not_force_firefox_cookies(self):
        self.assertTrue(all(not uses_session for _, uses_session in TikSaveDownloader._attempts_for("youtube")))

    def test_job_store_cancel_marks_job_and_event(self):
        store = JobStore()
        job = store.create(url="https://example.com", mode="video", platform="web")
        cancelled = store.cancel(job.id)
        self.assertIsNotNone(cancelled)
        self.assertEqual(cancelled["status"], "cancelling")
        self.assertTrue(cancelled["cancel_requested"])
        self.assertTrue(store.is_cancelled(job.id))


if __name__ == "__main__":
    unittest.main()
