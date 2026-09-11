"""Console output that cannot crash a request.

Windows consoles may use a legacy code page (cp1252); printing a rupee sign or
any other non-encodable character then raises UnicodeEncodeError inside the
request handler. Diagnostics must never take a request down with them.
"""

import sys


def safe_print(text: str) -> None:
    stream = sys.stdout
    encoding = getattr(stream, "encoding", None) or "utf-8"
    try:
        print(text)
    except UnicodeEncodeError:
        print(text.encode(encoding, errors="replace").decode(encoding, errors="replace"))
