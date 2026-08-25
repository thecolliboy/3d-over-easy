"""In-memory session store for session objects plus undo/redo snapshots."""
# ColliBoy

import uuid
import time
import copy
from typing import Optional, List, Dict, Any

class SessionStore:
    """Holds per-session state in memory with timeout-based expiry."""

    def __init__(self):
        self._sessions = {}
        self._timeout = 3600
        self._max_history = 20

    def _generate_id(self) -> str:
        return str(uuid.uuid4())[:8]

    def _cleanup(self):
        now = time.time()
        expired = [sid for sid, s in self._sessions.items() if now - s['updated_at'] > self._timeout]
        for sid in expired:
            del self._sessions[sid]

    def get_or_create_session(self, session_id: Optional[str] = None) -> Dict[str, Any]:
        """Return the given session if known, otherwise register a fresh one."""
        self._cleanup()

        if session_id and session_id in self._sessions:
            self._sessions[session_id]['updated_at'] = time.time()
            return self._sessions[session_id]

        new_id = session_id or self._generate_id()
        self._sessions[new_id] = {
            'id': new_id,
            'objects': {},
            'created_at': time.time(),
            'updated_at': time.time(),
            'undo_stack': [],
            'redo_stack': [],
        }
        return self._sessions[new_id]

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        if session_id in self._sessions:
            self._sessions[session_id]['updated_at'] = time.time()
            return self._sessions[session_id]
        return None

    def add_object(self, session_id: str, obj_data: Dict[str, Any]) -> Dict[str, Any]:
        """Insert an object into a session, filling in missing id/name fields."""
        session = self.get_or_create_session(session_id)
        obj_id = obj_data.get('id') or self._generate_id()
        obj_data['id'] = obj_id
        if 'name' not in obj_data:
            obj_data['name'] = f'object_{obj_id}'
        session['objects'][obj_id] = obj_data
        session['updated_at'] = time.time()
        return obj_data

    def get_object(self, session_id: str, obj_id: str) -> Optional[Dict[str, Any]]:
        """Look up one object inside a session by its ID."""
        session = self.get_session(session_id)
        if not session:
            return None
        return session['objects'].get(obj_id)

    def remove_object(self, session_id: str, obj_id: str) -> bool:
        """Delete an object from a session; report whether anything was removed."""
        session = self.get_session(session_id)
        if session and obj_id in session['objects']:
            del session['objects'][obj_id]
            session['updated_at'] = time.time()
            return True
        return False

    def get_all_objects(self, session_id: str) -> List[Dict[str, Any]]:
        """List every object stored in a session."""
        session = self.get_session(session_id)
        if not session:
            return []
        return list(session['objects'].values())

    # ── Undo / redo snapshots ──────────────────────────────────────────────

    def push_undo_snapshot(self, session_id: str, object_ids: List[str], operation_name: str = 'operation') -> Optional[Dict[str, Any]]:
        """Capture a deep copy of the entire session so undo can restore exact pre-op state.

        Snapshots cover every object in the session (not just the named ones) because
        operations replace objects with brand-new ids - restoring only the affected
        objects would leave orphaned results behind and drop everything else.
        """
        session = self.get_or_create_session(session_id)
        if not session:
            return None

        snapshot = {
            'id': str(uuid.uuid4())[:8],
            'timestamp': time.time(),
            'operation': operation_name,
            'objects': copy.deepcopy(session['objects']),
            'post_objects': None,
        }

        session['undo_stack'].append(snapshot)
        session['redo_stack'] = []

        if len(session['undo_stack']) > self._max_history:
            session['undo_stack'].pop(0)

        return snapshot

    def commit_snapshot(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Record the post-operation state on the newest snapshot so redo can re-apply it.

        Called by routes after an operation has finished mutating the session.
        Without this, redo would only have the pre-op state to restore and would
        silently do nothing (the op's result objects were minted with new ids).
        """
        session = self.get_session(session_id)
        if not session or len(session['undo_stack']) == 0:
            return None

        # Always record the latest state - multi-step operations (e.g. cut, which
        # stores one piece per call) commit repeatedly and only the final state matters.
        last = session['undo_stack'][-1]
        last['post_objects'] = copy.deepcopy(session['objects'])
        return last

    def pop_undo(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Restore the most recent snapshot, moving it onto the redo stack."""
        session = self.get_or_create_session(session_id)
        if not session or len(session['undo_stack']) == 0:
            return None

        snapshot = session['undo_stack'].pop()
        session['objects'] = copy.deepcopy(snapshot['objects'])
        session['updated_at'] = time.time()

        session['redo_stack'].append(snapshot)
        return snapshot

    def pop_redo(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Re-apply the most recently undone operation by restoring its post-op state."""
        session = self.get_or_create_session(session_id)
        if not session or len(session['redo_stack']) == 0:
            return None

        snapshot = session['redo_stack'].pop()
        # Redo must restore what the operation produced, not the pre-op state it was
        # taken from - fall back to the pre-op copy when no post-state was recorded.
        if snapshot.get('post_objects') is None:
            restore_from = snapshot['objects']
        else:
            restore_from = snapshot['post_objects']
        session['objects'] = copy.deepcopy(restore_from)
        session['updated_at'] = time.time()

        session['undo_stack'].append(snapshot)
        return snapshot

    def get_history_info(self, session_id: str) -> Dict[str, Any]:
        """Report whether undo/redo are available and how many steps each holds."""
        session = self.get_session(session_id)
        if not session:
            return {'can_undo': False, 'can_redo': False, 'undo_count': 0, 'redo_count': 0}

        return {
            'can_undo': len(session['undo_stack']) > 0,
            'can_redo': len(session['redo_stack']) > 0,
            'undo_count': len(session['undo_stack']),
            'redo_count': len(session['redo_stack']),
        }


store = SessionStore()
