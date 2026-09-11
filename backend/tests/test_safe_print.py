"""The debug and reasoning prints must survive a console that cannot encode the text."""

import io

from app.safe_print import safe_print


class LegacyConsole(io.StringIO):
    """A stream that behaves like a cp1252 Windows console: non-Latin-1 text raises."""

    encoding = "cp1252"

    def write(self, text: str) -> int:
        text.encode("cp1252")  # raises UnicodeEncodeError for the rupee sign
        return super().write(text)


def test_safe_print_replaces_unencodable_characters_instead_of_raising(monkeypatch):
    console = LegacyConsole()
    monkeypatch.setattr("sys.stdout", console)
    safe_print("Black Shirt C is the cheapest at ₹699")
    assert "Black Shirt C is the cheapest at ?699" in console.getvalue()


def test_safe_print_passes_plain_text_through(monkeypatch):
    console = LegacyConsole()
    monkeypatch.setattr("sys.stdout", console)
    safe_print("[reason] provider=gemini action=click")
    assert console.getvalue() == "[reason] provider=gemini action=click\n"
