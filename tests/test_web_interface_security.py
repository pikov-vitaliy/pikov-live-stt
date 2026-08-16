from pathlib import Path

from scripts.sync_extension import sync_extension_files
from whisperlivekit.web.web_interface import get_inline_ui_html


def test_inline_ui_embeds_text_safety_before_transcript_renderer():
    html = get_inline_ui_html()

    assert '<script src="text_safety.js"></script>' not in html
    assert "function installTextSafety" in html
    assert "const { escapeHtml } = globalThis.WhisperLiveKitTextSafety;" in html
    assert html.index("function installTextSafety") < html.index("const { escapeHtml }")


def test_extension_sync_copies_the_text_safety_helper(tmp_path):
    web_dir = Path(__file__).parents[1] / "whisperlivekit" / "web"

    sync_extension_files(web_dir=web_dir, extension_dir=tmp_path)

    assert (tmp_path / "text_safety.js").read_bytes() == (web_dir / "text_safety.js").read_bytes()
    html = (tmp_path / "live_transcription.html").read_text(encoding="utf-8")
    assert html.index('src="text_safety.js"') < html.index('src="live_transcription.js"')
