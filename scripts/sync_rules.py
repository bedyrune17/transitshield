"""Copy the canonical rules file into the frontend bundle.

backend/shared/risk_rules.json is the single source of truth; the browser
loads frontend/data/risk_rules.json. tests/unit/test_parity.py fails if the
two ever differ.
"""

import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "backend", "shared", "risk_rules.json")
DST = os.path.join(ROOT, "frontend", "data", "risk_rules.json")

if __name__ == "__main__":
    shutil.copyfile(SRC, DST)
    print("copied", os.path.relpath(SRC, ROOT), "->", os.path.relpath(DST, ROOT))
