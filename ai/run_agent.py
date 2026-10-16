#!/usr/bin/env python3
"""
run_agent.py - one-shot CAD generation runner.

Invoked by ai.py as a subprocess: either loads a local .gguf model via
llama-cpp-python or talks to an OpenAI-compatible REST API (--api-url +
--model-name, optional --api-key), exposes a single tool (run_build123d) that
executes build123d code in a sandboxed namespace, and loops until the model
produces a finished solid or runs out of iterations. The result is written
to <output-dir>/result.stl and the process exits; as a plain subprocess it
leaves nothing running afterwards - the model is unloaded on exit.

Usage (invoked by ai.py):
    python3 run_agent.py --mode create|edit --model /path/to/model.gguf
        --prompt-template /path/to/{create,edit}-prompt.txt
        --user-request "<request text>"
        --output-dir /path/to/ai/output
        [--input-path /path/to/ai/input/<id>.stl]   # required in edit mode

or for an OpenAI-compatible API (OpenAI itself, llama.cpp's server, etc.):
    python3 run_agent.py --mode create|edit --api-url https://api.openai.com/v1
        --model-name gpt-4o [--api-key sk-...] <same other flags>

The API URL is the base of a chat-completions endpoint: /chat/completions is
appended unless it already ends with one. The api key is sent as a Bearer
token when present and not literally 'none' (the default for blank entries).

Exit code 0 plus a .stl in --output-dir means success; any other exit code
means failure, with details on stderr.

Progress reporting: alongside plain-text log lines (flushed immediately so
the caller sees them as they happen), the script emits machine-readable
lines of the form

    PROGRESS: <stage>|<iteration>|<max_iterations>|<message>

(iteration/max_iterations may be blank) which ai.py parses to drive the
frontend progress bar. Deliberately plain stdout text rather than a socket
or pipe protocol - keep it simple, and it works with any model.

Requires (install in the server's Python environment):
    pip install llama-cpp-python build123d numpy

(llama-cpp-python is only needed for local .gguf mode; API mode uses the
stdlib urllib and adds no dependencies.)

Tool-call protocol: instead of relying on a specific chat template's native
function calling (which varies widely across gguf models and quantizations),
the prompt templates instruct the model to reply with exactly one fenced
```tool_code block per turn containing either
    run_build123d(\"\"\"<python code>\"\"\")
or
    finish()

The block is parsed with a small regex rather than a JSON/function-calling
schema, so it works across most instruction-tuned gguf models without
grammar-constrained decoding. If the chosen model supports llama.cpp's
native tool calling, swapping this loop to create_chat_completion(...,
tools=[...]) will be more robust.
"""
import argparse
import os
import re
import sys
import time
import traceback

# Defaults for the generation loop. ai.py overrides these from .config ([ai_generation])
# when it launches us, so tune them there; --max-tokens/--max-iterations below are the
# fallbacks used when run_agent.py is invoked directly without those flags.
MAX_TOOL_ITERATIONS = 12
MAX_TOKENS_PER_TURN = 4096
CONTEXT_SIZE = 8192

# Per-socket timeout for API requests: bounds how long a hung/unresponsive
# server can keep the job (and its "loading" bar) alive before we report it.
API_REQUEST_TIMEOUT = 300


class ModelConnectionError(RuntimeError):
    """The model endpoint could not be reached at all - connection refused,
    DNS failure, or timeout waiting for the server to answer. Retrying cannot
    fix an unreachable server, so main() aborts on this instead of looping."""


def _describe_network_error(err):
    """Reduce a urllib/socket failure to one short human-readable phrase."""
    import socket as _socket

    # urlopen wraps the underlying socket failure in URLError.reason; bare
    # OSError/TimeoutError can also surface directly.
    reason = getattr(err, 'reason', None) or err
    if isinstance(reason, ConnectionRefusedError):
        return 'connection refused'
    if isinstance(reason, TimeoutError):  # includes socket.timeout (alias since 3.10)
        return f'timed out after {API_REQUEST_TIMEOUT}s with no response'
    if isinstance(reason, _socket.gaierror):
        return f'unresolvable host ({reason})'
    text = str(err).strip() or str(reason).strip()
    return (text[:200] if text else 'network error')

TOOL_CALL_RE = re.compile(
    r"```tool_code\s*(.*?)```", re.DOTALL
)
RUN_BUILD123D_RE = re.compile(
    r'run_build123d\(\s*(?:"""|\'\'\')(.*?)(?:"""|\'\'\')\s*\)', re.DOTALL
)
FINISH_RE = re.compile(r'finish\(\s*\)')


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--mode', required=True, choices=['create', 'edit'])
    # Exactly one backend: a local .gguf file (--model) or an OpenAI-compatible
    # REST API (--api-url + --model-name, optional --api-key).
    p.add_argument('--model', default=None)
    p.add_argument('--api-url', dest='api_url', default=None)
    p.add_argument('--api-key', dest='api_key', default=None)
    p.add_argument('--model-name', dest='model_name', default=None)
    # Generation tuning (ai.py passes these from .config; defaults match the module constants).
    p.add_argument('--max-tokens', dest='max_tokens', type=int, default=MAX_TOKENS_PER_TURN)
    p.add_argument('--max-iterations', dest='max_iterations', type=int, default=MAX_TOOL_ITERATIONS)
    # Optional reasoning level for OpenAI-compatible APIs that support it (e.g. "low").
    # 'none'/blank omits the parameter entirely so strict servers don't reject it.
    p.add_argument('--reasoning-effort', dest='reasoning_effort', default=None)
    p.add_argument('--prompt-template', required=True)
    p.add_argument('--user-request', required=True)
    p.add_argument('--output-dir', required=True)
    p.add_argument('--input-path', default=None)
    return p.parse_args()


class OpenAiClient:
    """Minimal OpenAI-compatible chat client built on the stdlib (urllib), so
    API mode needs no extra dependencies. It exposes the same streaming
    interface as llama_cpp.Llama.create_chat_completion - chunks of the form
    {'choices': [{'delta': {'content': <piece>}}]} - letting the agent loop in
    main() run unchanged against either backend."""

    def __init__(self, base_url, model_name, api_key=None, reasoning_effort=None):
        self.url = (base_url or '').rstrip('/')
        if not self.url.endswith('/chat/completions'):
            self.url += '/chat/completions'
        self.model_name = model_name
        self.api_key = api_key
        # Optional; only sent when set and not the 'none'/blank sentinel. Some
        # OpenAI-compatible models accept low/medium/high to scale their reasoning.
        self.reasoning_effort = reasoning_effort

    def create_chat_completion(self, messages=None, max_tokens=1024, temperature=0.2, stream=False):
        import json as _json
        import urllib.error
        import urllib.request

        payload = {
            'model': self.model_name,
            'messages': messages,
            'max_tokens': max_tokens,
            'temperature': temperature,
            'stream': bool(stream),
        }
        if self.reasoning_effort and self.reasoning_effort != 'none':
            payload['reasoning_effort'] = self.reasoning_effort
        headers = {'Content-Type': 'application/json'}
        # Blank/'none' keys (the app's default for keyless local servers) mean no auth header.
        if self.api_key and self.api_key != 'none':
            headers['Authorization'] = f'Bearer {self.api_key}'

        request = urllib.request.Request(
            self.url,
            data=_json.dumps(payload).encode('utf-8'),
            headers=headers,
        )
        try:
            response = urllib.request.urlopen(request, timeout=API_REQUEST_TIMEOUT)
        except urllib.error.HTTPError as e:
            # The server answered - surface its status and body (bad key, rate limit, ...).
            detail = ''
            try:
                detail = e.read().decode('utf-8', errors='replace')[:500]
            except Exception:
                pass
            raise RuntimeError(f'OpenAI API request failed (HTTP {e.code}): {detail}') from None
        except (urllib.error.URLError, OSError) as e:
            # Never reached the server at all - main() aborts on this with a clear reason.
            raise ModelConnectionError(f'{self.url} - {_describe_network_error(e)}') from None

        # Server-sent events: one JSON chunk per "data:" line, terminated by [DONE].
        try:
            for raw in response:
                line = raw.decode('utf-8', errors='replace').strip()
                if not line.startswith('data:'):
                    continue
                body = line[len('data:'):].strip()
                if body == '[DONE]':
                    break
                try:
                    yield _json.loads(body)
                except ValueError:
                    continue
        finally:
            response.close()


def build_system_prompt(args):
    with open(args.prompt_template, 'r', encoding='utf-8') as f:
        template = f.read()
    substitutions = {
        '{user_request}': args.user_request,
        '{input_path}': args.input_path or '',
    }
    for placeholder, value in substitutions.items():
        template = template.replace(placeholder, value)
    return template


def make_sandbox_namespace(input_path):
    """Sandbox namespace for generated code. The executed block must assign
    a build123d solid (Shape/Part or Sketch-derived) to `result`; that value
    is what gets exported to STL."""
    import build123d as bd

    namespace = {
        'bd': bd,
        '__builtins__': __builtins__,
    }

    if input_path:
        def load_input():
            """Load the input mesh and return it as a build123d object for editing."""
            from build123d import Mesher
            mesher = Mesher()
            mesher.read(input_path)
            objs = mesher.solids() or mesher.faces()
            if not objs:
                raise RuntimeError(f'Could not read any geometry from {input_path}')
            return objs[0]
        namespace['load_input'] = load_input

    return namespace


def _api_hints(error_text):
    """Append short corrections for common build123d API mistakes.

    The model's training data often reflects older/different build123d APIs;
    the raw traceback alone does not always say what to do instead, so weaker
    models repeat the same mistake every turn and burn the iteration budget."""
    hints = []
    if "'tuple' object has no attribute 'wrapped'" in error_text:
        hints.append('Hint: .move()/.moved()/.located() require a bd.Location object, not a raw tuple - use '
                     'bd.Location((x, y, z)) for translation or bd.Location((x, y, z), (rx, ry, rz)) to also rotate.')
    if re.search(r"has no attribute '(top|bottom|left|right|front|back)'", error_text):
        hints.append('Hint: build123d 0.11 has no .top/.bottom/.left/... attributes on shapes or builders - '
                     "select faces with shape.faces().filter_by_position(bd.Axis.Z, min, max) (same for edges).")
    if "unexpected keyword argument 'faces'" in error_text:
        hints.append('Hint: fillet()/chamfer() take a list of Edges, not Faces - pick them with '
                     'shape.edges().filter_by_position(...).')
    if re.search(r"No module named '(OCP|ocp)", error_text):
        hints.append('Hint: do not import OCP or other low-level OpenCascade modules - use the build123d '
                     'high-level API via bd instead (e.g. bd.import_step, bd.export_step).')
    return ('\n' + '\n'.join(hints)) if hints else ''


def run_build123d_code(code, namespace, output_dir):
    """Run one generated code block in the sandbox; returns a text observation to feed back into the conversation."""
    try:
        exec(code, namespace)
    except Exception:
        tb = traceback.format_exc()[-3000:]
        return 'ERROR:\n' + tb + _api_hints(tb)

    result = namespace.get('result')
    if result is None:
        return ('No `result` variable was set. Assign the final shape to a '
                 'variable named `result` before finishing.')

    try:
        from build123d import export_stl
        # export_stl only accepts a Shape/Part; anything else (e.g. a bare
        # Sketch) raises here, and the traceback is fed back for correction
        # on the next turn.
        preview_path = os.path.join(output_dir, '_preview.stl')
        export_stl(result, preview_path)
    except Exception:
        tb = traceback.format_exc()[-3000:]
        return 'ERROR exporting `result` to STL:\n' + tb + _api_hints(tb)

    bbox = None
    try:
        bb = result.bounding_box()
        bbox = f'{bb.size.X:.2f} x {bb.size.Y:.2f} x {bb.size.Z:.2f} mm'
    except Exception:
        pass

    msg = 'OK: code ran and `result` exported successfully.'
    if bbox:
        msg += f' Bounding box: {bbox}.'
    msg += (' Call finish() now if this is the final shape, or keep '
            'refining `result` with another run_build123d call.')
    return msg


def _progress(stage, message, iteration=None, max_iterations=None):
    """Emit a machine-readable PROGRESS line for ai.py, flushed immediately so
    the caller sees it as soon as it is printed. See Progress reporting above."""
    iter_str = str(iteration) if iteration is not None else ''
    max_str = str(max_iterations) if max_iterations is not None else ''
    print(f'PROGRESS: {stage}|{iter_str}|{max_str}|{message}', flush=True)


def main():
    args = parse_args()
    # Rebind the loop constants from the CLI so ai.py (via .config) can tune them;
    # these locals shadow the module defaults for every reference below.
    MAX_TOOL_ITERATIONS = args.max_iterations
    MAX_TOKENS_PER_TURN = args.max_tokens
    os.makedirs(args.output_dir, exist_ok=True)

    use_api = bool(args.api_url)
    if not use_api and not args.model:
        print('Either --model (local .gguf) or --api-url + --model-name '
              '(OpenAI-compatible API) is required.', file=sys.stderr, flush=True)
        return 1
    if use_api and not args.model_name:
        print('--api-url requires --model-name.', file=sys.stderr, flush=True)
        return 1

    system_prompt = build_system_prompt(args)
    namespace = make_sandbox_namespace(args.input_path)

    if use_api:
        # No local model to load - the first API call happens on demand below.
        llm = OpenAiClient(args.api_url, args.model_name, api_key=args.api_key,
                           reasoning_effort=args.reasoning_effort)
        print(f'Using OpenAI-compatible API at {llm.url} (model: {args.model_name}).', flush=True)
    else:
        try:
            from llama_cpp import Llama
        except ImportError:
            print('llama-cpp-python is not installed (`pip install llama-cpp-python`).',
                  file=sys.stderr, flush=True)
            return 1

        model_label = os.path.basename(args.model)
        _progress('loading_model', f'Loading model {model_label} - this can take a while',
                   max_iterations=MAX_TOOL_ITERATIONS)
        print(f'Loading model from {args.model} (n_ctx={CONTEXT_SIZE})…', flush=True)

        # verbose=True keeps llama.cpp's load/inference logging (load time,
        # tokens/sec) visible in the terminal - on slow hardware it is the only
        # sign of life during a long completion.
        # n_threads=os.cpu_count(): the library default uses roughly half the
        # cores; on CPU-only boxes that can double wall-clock time for no reason.
        llm = Llama(
            model_path=args.model,
            n_ctx=CONTEXT_SIZE,
            n_threads=os.cpu_count(),
            verbose=True,
        )

    print('Starting generation loop.', flush=True)
    _progress('ready', 'Model ready, starting generation', max_iterations=MAX_TOOL_ITERATIONS)

    messages = [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': args.user_request},
    ]

    produced_result = False

    for step in range(1, MAX_TOOL_ITERATIONS + 1):
        print(f'--- Iteration {step}/{MAX_TOOL_ITERATIONS}: requesting completion from model ---',
              flush=True)
        _progress('thinking', f'Waiting for the model to respond (step {step} of {MAX_TOOL_ITERATIONS})',
                   iteration=step, max_iterations=MAX_TOOL_ITERATIONS)

        # Streamed rather than a single blocking call: on CPU-only hardware
        # a completion can take many minutes with no signal in the meantime.
        # Streaming reports token counts and elapsed time as they happen,
        # and lets SIGTERM land mid-stream instead of only between completions.
        t_start = time.time()
        last_report = t_start
        token_count = 0
        reply_parts = []
        try:
            chunks = llm.create_chat_completion(
                messages=messages,
                max_tokens=MAX_TOKENS_PER_TURN,
                temperature=0.2,
                stream=True,
            )
            for chunk in chunks:
                delta = chunk['choices'][0].get('delta', {}) or {}
                piece = delta.get('content') or ''
                if piece:
                    reply_parts.append(piece)
                    token_count += 1
                now = time.time()
                if now - last_report >= 3:
                    elapsed = now - t_start
                    status_msg = (f'Model is responding - {token_count} tokens so far, '
                                  f'{elapsed:.0f}s elapsed (step {step} of {MAX_TOOL_ITERATIONS})')
                    print(f'…still generating: {token_count} tokens, {elapsed:.0f}s elapsed', flush=True)
                    _progress('thinking', status_msg, iteration=step, max_iterations=MAX_TOOL_ITERATIONS)
                    last_report = now
        except ModelConnectionError as e:
            # The endpoint never answered (refused / DNS / timeout) - retrying an
            # unreachable server cannot help, so stop now with a clear reason.
            print(f'Cannot reach the model API: {e}', flush=True)
            _progress('error', f'Cannot reach the model API at {args.api_url} - {_describe_network_error(e)}')
            return 1
        except Exception as e:
            if use_api and isinstance(e, OSError):
                # The connection dropped mid-stream (server died while responding).
                print(f'Model connection lost: {_describe_network_error(e)}', flush=True)
                _progress('error', f'Lost the model API connection at {args.api_url} - {_describe_network_error(e)}')
                return 1
            # Other failures (HTTP errors, bad replies): report one concise line
            # and let the loop retry as before.
            reason = str(e).splitlines()[0][:300] or repr(e)
            print(f'Model completion call failed: {reason}', flush=True)
            _progress('retry', f'Model call errored - retrying (step {step} of {MAX_TOOL_ITERATIONS})',
                       iteration=step, max_iterations=MAX_TOOL_ITERATIONS)
            messages.append({
                'role': 'user',
                'content': 'The previous request errored out before finishing; please try again.',
            })
            continue

        reply = ''.join(reply_parts)
        elapsed_total = time.time() - t_start
        print(f'Model replied ({len(reply)} chars, {token_count} tokens, {elapsed_total:.1f}s).', flush=True)
        messages.append({'role': 'assistant', 'content': reply})

        match = TOOL_CALL_RE.search(reply)
        if not match:
            print('No ```tool_code block found in reply; asking model to retry.', flush=True)
            _progress('retry', f'Model reply had no tool call - asking it to try again (step {step} of {MAX_TOOL_ITERATIONS})',
                       iteration=step, max_iterations=MAX_TOOL_ITERATIONS)
            messages.append({
                'role': 'user',
                'content': ('No ```tool_code block found. Reply with exactly one '
                             '```tool_code block containing run_build123d(...) or finish().'),
            })
            continue

        call_body = match.group(1).strip()

        if FINISH_RE.search(call_body):
            if not produced_result:
                print('Model called finish() before producing a valid result.', flush=True)
                _progress('retry', f'Model tried to finish early - asking it to build the shape first (step {step} of {MAX_TOOL_ITERATIONS})',
                           iteration=step, max_iterations=MAX_TOOL_ITERATIONS)
                messages.append({
                    'role': 'user',
                    'content': ('You called finish() before any run_build123d call '
                                 'succeeded. Produce a valid `result` first.'),
                })
                continue
            print('Model called finish(). Wrapping up.', flush=True)
            _progress('finishing', 'Model signaled it is done - finalizing result',
                       iteration=step, max_iterations=MAX_TOOL_ITERATIONS)
            break

        run_match = RUN_BUILD123D_RE.search(call_body)
        if not run_match:
            print('Could not parse a run_build123d(...) call from reply.', flush=True)
            _progress('retry', f'Could not parse the model\'s tool call - asking it to retry (step {step} of {MAX_TOOL_ITERATIONS})',
                       iteration=step, max_iterations=MAX_TOOL_ITERATIONS)
            messages.append({
                'role': 'user',
                'content': 'Could not parse a run_build123d("""...""") call. Try again.',
            })
            continue

        code = run_match.group(1)
        print(f'Executing generated build123d code (step {step}/{MAX_TOOL_ITERATIONS})…', flush=True)
        _progress('running_code', f'Running generated build123d code (step {step} of {MAX_TOOL_ITERATIONS})',
                   iteration=step, max_iterations=MAX_TOOL_ITERATIONS)

        observation = run_build123d_code(code, namespace, args.output_dir)

        if observation.startswith('OK'):
            print(observation, flush=True)
            produced_result = True
            _progress('exported', f'Shape exported successfully (step {step} of {MAX_TOOL_ITERATIONS})',
                       iteration=step, max_iterations=MAX_TOOL_ITERATIONS)
        else:
            # Surface the actual failure in the log (not just "ERROR:") - show a
            # bounded tail so the real exception line is always visible. The full
            # text is also fed back to the model for self-correction below.
            for line in observation.splitlines()[-15:]:
                print(line, flush=True)
            _progress('code_error', f'Generated code raised an error - asking the model to fix it (step {step} of {MAX_TOOL_ITERATIONS})',
                       iteration=step, max_iterations=MAX_TOOL_ITERATIONS)
        messages.append({'role': 'user', 'content': observation})

    preview_path = os.path.join(args.output_dir, '_preview.stl')
    final_path = os.path.join(args.output_dir, 'result.stl')

    if not produced_result or not os.path.isfile(preview_path):
        print('Model did not produce a valid shape within the iteration budget.',
              file=sys.stderr, flush=True)
        return 1

    os.replace(preview_path, final_path)
    print(f'Wrote final result to {final_path}', flush=True)
    _progress('done', 'Done')
    return 0


if __name__ == '__main__':
    sys.exit(main())
