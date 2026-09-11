"""Cloud-latency experiment (Phase 5, limitation H).

Replays the same sanitized ShirtStore request N times against two backends:
  A: the normal backend (port 8000, provider default thinking)
  B: a backend started with GEMINI_THINKING_BUDGET=0 (port 8001)
and records latency and the chosen target for each. The request body is the
sanitized payload the extension sends (placeholders only). Writes
evaluation/results/cloud-latency.json. No key is read or printed here.

  python evaluation/scripts/cloud-latency.py [runs]
"""

import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 5
HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "results" / "cloud-latency.json"

REQUEST = {
    "task": "Find the cheapest black shirt and click Buy Now",
    "page": {
        "url": "http://localhost:8080/",
        "title": "ShirtStore - Black Shirts",
        "elements": [
            {"id": "el_products", "tag": "a", "text": "Products", "role": "link"},
            {"id": "el_about", "tag": "a", "text": "About", "role": "link"},
            {"id": "el_email", "tag": "input", "text": "[EMAIL_1]", "role": "textbox"},
            {"id": "el_phone", "tag": "input", "text": "[PHONE_1]", "role": "textbox"},
            {"id": "el_password", "tag": "input", "text": "[PASSWORD_1]", "role": "textbox"},
            {"id": "el_card_number", "tag": "input", "text": "[CARD_1]", "role": "textbox"},
            {"id": "el_otp", "tag": "input", "text": "[OTP_1]", "role": "textbox"},
            {"id": "el_buy_a", "tag": "button", "text": "Buy Now A", "role": "button"},
            {"id": "el_buy_b", "tag": "button", "text": "Buy Now B", "role": "button"},
            {"id": "el_buy_c", "tag": "button", "text": "Buy Now C", "role": "button"},
        ],
        "text": "ShirtStore Products About Signed in as Email [EMAIL_1] Phone [PHONE_1] Black Shirts Black Shirt A Price: ₹799 Buy Now A Black Shirt B Price: ₹899 Buy Now B Black Shirt C Price: ₹699 Buy Now C Delivery details Email Phone Password Card number OTP",
    },
    "placeholders": ["[EMAIL_1]", "[PHONE_1]", "[PASSWORD_1]", "[CARD_1]", "[OTP_1]"],
    "visual": {
        "engine": "tesseract.js 7 LSTM (wasm)",
        "observations": [
            {"type": "button", "text": "Buy Now A", "bbox": {"x": 300, "y": 900, "width": 160, "height": 30}, "confidence": 0.9, "target": "el_buy_a"},
            {"type": "button", "text": "Buy Now C", "bbox": {"x": 1880, "y": 900, "width": 160, "height": 30}, "confidence": 0.9, "target": "el_buy_c"},
        ],
        "conflicts": ["Black Shirt A: page text says 799, vision read Price: 7799"],
    },
}


def call(port: int):
    body = json.dumps(REQUEST).encode()
    req = urllib.request.Request(f"http://localhost:{port}/reason", data=body, headers={"Content-Type": "application/json"})
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read().decode())
            return {"ms": round((time.perf_counter() - t) * 1000), "status": r.status, "target": data.get("target"), "action": data.get("action")}
    except urllib.error.HTTPError as e:
        return {"ms": round((time.perf_counter() - t) * 1000), "status": e.code, "error": e.read().decode()[:700]}
    except Exception as e:  # noqa: BLE001
        return {"ms": round((time.perf_counter() - t) * 1000), "status": 0, "error": str(e)[:160]}


def summarize(rows):
    ok = [r for r in rows if r["status"] == 200]
    ms = [r["ms"] for r in ok]
    return {
        "runs": len(rows), "ok": len(ok), "correct_target": sum(1 for r in ok if r.get("target") == "el_buy_c"),
        "ms": {"min": min(ms), "mean": round(statistics.mean(ms)), "median": round(statistics.median(ms)), "max": max(ms)} if ms else None,
        "rows": rows,
    }


result = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "request_bytes": len(json.dumps(REQUEST).encode()), "runs_per_arm": RUNS}
for name, port in (("default_thinking", 8000), ("thinking_budget_0", 8001)):
    rows = []
    for _ in range(RUNS):
        rows.append(call(port))
        print(f"{name}: {rows[-1]}")
    result[name] = summarize(rows)
OUT.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps({k: {"ok": v["ok"], "correct": v["correct_target"], "ms": v["ms"]} for k, v in result.items() if isinstance(v, dict) and "rows" in v}, indent=1))
