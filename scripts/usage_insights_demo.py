"""Run an isolated prototype with synthetic traffic through the real proxy executors.

Build first with scripts/Build-Windows.ps1. No production config or credentials are used.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class MockProvider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if body.get("messages", [{}])[-1].get("content") == "fail-demo":
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"Synthetic failure","type":"invalid_request_error"}}')
            return
        n = int(self.headers.get("X-Demo-Sequence", "1"))
        usage = {"prompt_tokens": 1000 + n * 37, "completion_tokens": 200 + n * 11,
                 "prompt_tokens_details": {"cached_tokens": 0 if n % 3 == 0 else 700},
                 "completion_tokens_details": {"reasoning_tokens": 50}}
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
        model = body["model"] + "-reported"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
        self.end_headers()
        if body.get("stream"):
            chunks = [dict(id="demo-stream", object="chat.completion.chunk", model=model,
                           choices=[dict(index=0, delta={"role": "assistant", "content": "Synthetic response"}, finish_reason=None)]),
                      dict(id="demo-stream", object="chat.completion.chunk", model=model,
                           choices=[dict(index=0, delta={}, finish_reason="stop")], usage=usage)]
            for chunk in chunks:
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            result = dict(id="demo-completion", object="chat.completion", model=model,
                          choices=[dict(index=0, message={"role": "assistant", "content": "Synthetic response"}, finish_reason="stop")], usage=usage)
            self.wfile.write(json.dumps(result).encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18319)
    parser.add_argument("--upstream-port", type=int, default=18320)
    parser.add_argument("--seed", type=int, default=36)
    parser.add_argument("--console-asset", type=Path, help="Optional existing management.html to copy for console integration testing")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    directory = root / "artifacts" / "usage-insights-demo"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "auths").mkdir(exist_ok=True)
    # Dummy keys work only against this loopback mock. They are not credentials.
    config = f'''host: 127.0.0.1
port: {args.port}
auth-dir: {json.dumps(str(directory / "auths"))}
api-keys: [prototype-client]
remote-management:
  secret-key: prototype-local-only
  allow-remote: false
  disable-auto-update-panel: true
usage-statistics-enabled: true
request-retry: 0
disable-cooling: true
openai-compatibility:
'''
    for provider, model in [("demo-codex", "gpt-demo"), ("demo-claude", "claude-demo")]:
        config += f'''  - name: {provider}
    base-url: http://127.0.0.1:{args.upstream_port}/{provider}/v1
    api-key-entries:
      - api-key: mock-only
    headers:
      X-Demo-Sequence: "$X-Demo-Sequence"
    models:
      - name: {model}
        alias: demo-favorite
      - name: {model}-mini
        alias: demo-quick
'''
    path = directory / "config.yaml"
    path.write_text(config, encoding="utf-8")
    mock = ThreadingHTTPServer(("127.0.0.1", args.upstream_port), MockProvider)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = os.environ.copy()
    # Do not inherit a real management password into the isolated demonstration.
    env.pop("MANAGEMENT_PASSWORD", None)
    static = directory / "static"
    static.mkdir(exist_ok=True)
    env["MANAGEMENT_STATIC_PATH"] = str(static)
    if args.console_asset:
        shutil.copyfile(args.console_asset, static / "management.html")
    stdout = (directory / "proxy.log").open("a", encoding="utf-8")
    proc = subprocess.Popen([str(root / "artifacts" / "cli-proxy-api.exe"), "--config", str(path), "--local-model"], cwd=directory, env=env, stdout=stdout, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{args.port}"
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        deadline = time.monotonic() + 30
        while True:
            if proc.poll() is not None:
                raise RuntimeError("Prototype exited; inspect " + str(directory / "proxy.log"))
            try:
                with urlopen(base + "/healthz") as response:
                    if response.status == 200:
                        break
            except URLError:
                if time.monotonic() > deadline:
                    raise RuntimeError("Prototype did not start")
                time.sleep(0.1)
        for n in range(args.seed):
            body = dict(model="demo-quick" if n % 4 == 0 else "demo-favorite", stream=n % 2 == 0,
                        messages=[{"role": "user", "content": "fail-demo" if n % 11 == 0 else "Synthetic prototype request"}])
            headers = {"Authorization": "Bearer prototype-client", "Content-Type": "application/json", "X-Demo-Sequence": str(n)}
            try:
                with urlopen(Request(base + "/v1/chat/completions", json.dumps(body).encode(), headers)) as response:
                    response.read()
            except HTTPError as error:
                if n % 11 != 0:
                    raise
                error.close()
        print(f"Prototype: {base}/usage-insights/", flush=True)
        print("Management key: prototype-local-only (dummy, loopback demo only)", flush=True)
        print("Synthetic traffic only. Production is untouched. Ctrl+C stops this prototype.", flush=True)
        proc.wait()
    except KeyboardInterrupt:
        pass
    finally:
        proc.terminate()
        proc.wait()
        mock.shutdown()
        mock.server_close()
        stdout.close()


if __name__ == "__main__":
    main()
