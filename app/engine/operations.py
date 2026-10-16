"""Per-session operation journals, shared with the routes layer via the module-level `oplog`."""
# ColliBoy

from typing import Any, Dict, List


class OperationLog:
    """Keeps one ordered entry list per active session; read-only, as no in-repo writer remains."""

    def __init__(self):
        # session_id -> chronological entry list
        self._logs = {}

    def get_log(self, session_id: str) -> List[Dict[str, Any]]:
        """Chronological list of everything logged for a session."""
        return list(self._logs.get(session_id, []))


oplog = OperationLog()
