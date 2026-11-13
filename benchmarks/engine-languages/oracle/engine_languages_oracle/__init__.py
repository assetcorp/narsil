import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CONFORMANCE_TEXT_ORACLE = REPOSITORY_ROOT / "packages" / "conformance" / "oracle"

if str(CONFORMANCE_TEXT_ORACLE) not in sys.path:
    sys.path.insert(0, str(CONFORMANCE_TEXT_ORACLE))
