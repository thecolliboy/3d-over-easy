"""Time budget guard for mesh processing calls.

Keeps long-running mesh processing from blocking Flask workers; work that outlives
the limit returns an error response instead of hanging the request. A threading-based
scheme is used because SIGALRM only fires on the main thread, while the threaded dev
server runs each request in its own thread.
"""
# ColliBoy

import functools
import threading
try:
    from flask import has_request_context, copy_current_request_context
except ImportError:
    def has_request_context():
        return False
    def copy_current_request_context(func):
        return func


class MeshProcessingTimeout(TimeoutError):
    """Raised once a mesh operation outlives its allotted time budget."""
    pass


def timeout_operation(seconds: int = 30):
    """Wrap a function so it aborts with MeshProcessingTimeout when it runs long.

    A daemon thread watches the call; Python cannot kill a running thread, so on
    expiry the wrapper raises instead of waiting for the work to finish.

    Applied above a definition with that budget, it yields a wrapper that passes
    results through unchanged and raises MeshProcessingTimeout once the budget
    elapses.
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            result = [None]
            exception = [None]
            finished = threading.Event()

            target_func = func
            if has_request_context():
                target_func = copy_current_request_context(func)

            def target():
                try:
                    result[0] = target_func(*args, **kwargs)
                except Exception as e:
                    exception[0] = e
                finally:
                    finished.set()

            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            finished.wait(timeout=seconds)

            # The worker thread keeps running in the background; we only stop waiting on it (ColliBoy)
            if not finished.is_set():
                raise MeshProcessingTimeout(
                    f'Mesh processing timed out after {seconds}s - '
                    f'try simplifying the model first'
                )

            if exception[0]:
                raise exception[0]

            return result[0]

        return wrapper
    return decorator
