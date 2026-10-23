#!/usr/bin/env python3
"""Run the real Omnara CLI/SDK loopback lab through an owned kernel PTY.

The small TSP peer here supplies hello/ACK only; this is NOT a real Tern host
or a substitute for the lead's native Tern acceptance run. Only an
owned shell-like sentinel is used; no user shell or credentials are accessed.
"""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

OPEN = b"\x1b_tsp;o;"
FRAME = b"\x1b_tsp;f;"
CLOSE = b"\x1b_tsp;x;"
ST = b"\x1b\\"
TRACE = b"Omnara lab SDK POST text: "
APP_EXIT = b"__OMNARA_APP_EXIT__:"
SHELL_READY = b"__OMNARA_NEXT_SHELL_READY__"
SHELL_INPUT = b"__OMNARA_NEXT_SHELL_INPUT__:"
HELLO = {
    "r": "hello",
    "v": 1,
    "term": "tern",
    "kinds": ["col", "editor"],
    "credits": 2,
    "apc": 65536,
}


class OwnedPty:
    def __init__(self, node, tsx, lab, *, assert_pty=True):
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            # The app and a following owned shell sentinel share the SAME tty.
            # A direct-exec PTY closes its slave on app exit and cannot detect
            # delayed APC bytes being accepted as the next shell's command.
            try:
                # Ink 8 suppresses interactive frames and suspend/resume in CI.
                env = {
                    "PATH": os.environ.get("PATH", ""),
                    "TERM": "xterm-256color",
                    "NO_COLOR": "1",
                    "OMNARA_TERN_NATIVE": "1",
                    "OMNARA_TERN_LIVE": "0",
                }
                args = [node, tsx, lab, "--trace-sdk"]
                if assert_pty:
                    args.append("--assert-pty")
                app = subprocess.run(args, env=env, check=False)
                os.write(1, ("\n" + APP_EXIT.decode() + str(app.returncode) + "\n").encode())
                os.write(1, SHELL_READY + b" $ ")
                line = sys.stdin.buffer.readline()
                os.write(
                    1,
                    b"\r\n" + SHELL_INPUT
                    + json.dumps(line.decode("utf-8", errors="backslashreplace")).encode()
                    + b"\n",
                )
                os._exit(app.returncode if app.returncode >= 0 else 1)
            except BaseException as exc:
                os.write(2, ("owned PTY wrapper failed: " + repr(exc) + "\n").encode())
                os._exit(127)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
        self.output = bytearray()
        self.frame_cursor = 0
        self.hold_acks = False
        self.held_acks = []
        self.reaped = False

    def write(self, data):
        view = memoryview(data)
        while len(view):
            written = os.write(self.master, view)
            if written <= 0:
                raise RuntimeError("pty write made no progress")
            view = view[written:]

    def tsp_event(self, payload):
        self.write(b"\x1b_tsp;e;" + json.dumps(payload, separators=(",", ":")).encode() + ST)

    def pump(self, timeout):
        ready, _, _ = select.select([self.master], [], [], timeout)
        if not ready:
            return
        try:
            data = os.read(self.master, 65536)
        except OSError as exc:
            if exc.errno == errno.EIO:
                return  # Linux master reports EIO once its slave has closed.
            raise
        if data:
            self.output.extend(data)
            self.ack_frames()

    def ack_frames(self):
        # Only credit genuinely emitted complete native frames. Never create
        # guessed ACKs or infer any send from a rendered editor's text.
        while True:
            start = self.output.find(FRAME, self.frame_cursor)
            if start < 0:
                self.frame_cursor = max(0, len(self.output) - len(FRAME) + 1)
                return
            end = self.output.find(ST, start + len(FRAME))
            if end < 0:
                self.frame_cursor = start
                return
            encoded = self.output[start + len(FRAME):end]
            self.frame_cursor = end + len(ST)
            try:
                frame = json.loads(encoded)
            except (ValueError, UnicodeDecodeError):
                continue  # A chunked frame is not usable as a complete frame.
            if isinstance(frame, dict) and isinstance(frame.get("s"), int):
                # Store only authentic frame sequences observed on this PTY.
                ack = {"ev": "ack", "sf": frame["sf"], "s": frame["s"]}
                if self.hold_acks:
                    self.held_acks.append(ack)
                else:
                    self.tsp_event(ack)

    def release_held_acks(self):
        for ack in self.held_acks:
            self.tsp_event(ack)
        self.held_acks.clear()

    def assert_next_shell_clean(self):
        # The wrapper deliberately stays attached AFTER the Node app exits.
        # Cooked-line input here reproduces a real subsequent shell prompt.
        self.until(SHELL_READY, timeout=5)
        self.write(b"owned-shell-sentinel\r")
        self.until(SHELL_INPUT, timeout=5)
        start = self.output.rfind(SHELL_INPUT) + len(SHELL_INPUT)
        self.until(b"\n", after=start, timeout=5)
        end = self.output.find(b"\n", start)
        if end < 0:
            raise AssertionError("next-shell sentinel result is incomplete")
        received = json.loads(bytes(self.output[start:end]).strip().decode())
        if received != "owned-shell-sentinel\n":
            raise AssertionError("TSP bytes contaminated next shell input: " + repr(received))

    def until(self, marker, *, after=0, timeout=25):
        deadline = time.monotonic() + timeout
        while marker not in self.output[after:]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("timed out waiting for " + repr(marker))
            self.pump(min(remaining, 0.25))

    def until_count(self, marker, count, timeout=25):
        deadline = time.monotonic() + timeout
        while self.output.count(marker) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    "timed out waiting for marker " + repr(marker) + " count " + str(count)
                )
            self.pump(min(remaining, 0.25))

    def sdk_post(self, text, *, after):
        encoded = json.dumps(text, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.until(TRACE + encoded, after=after)

    def wait_exit(self, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            child, status = os.waitpid(self.pid, os.WNOHANG)
            if child:
                self.reaped = True
                return os.waitstatus_to_exitcode(status)
            self.pump(0.1)
        raise AssertionError("lab did not exit after /quit")

    def close(self):
        if not self.reaped:
            try:
                # pty.fork creates a private session; also stop the app child
                # if the owned Python shell wrapper has not finished.
                os.killpg(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            os.waitpid(self.pid, 0)
            self.reaped = True
        os.close(self.master)


def run(node, tsx, lab):
    session = OwnedPty(node, tsx, lab)
    try:
        # The app probes in the actual tty; a synthetic peer grants the
        # native editor capability only after the CLI asked for it.
        session.until(b"\x1b_tsp;q;", timeout=20)
        session.write(b"\x1b_tsp;r;" + json.dumps(HELLO, separators=(",", ":")).encode() + ST)
        session.until_count(OPEN, 1, timeout=20)

        # Each UTF-8 codepoint is fragmented as physical PTY writes, including
        # writes that contain only a continuation byte. Node's tty decoder,
        # mux, Ink suspension and native keys all execute in the child.
        start = len(session.output)
        opens = session.output.count(OPEN)
        for byte in "hè 🌍 第二行".encode("utf-8"):
            session.write(bytes([byte]))
            time.sleep(0.002)
        session.write(b"\r")
        session.sdk_post("hè 🌍 第二行", after=start)
        session.until_count(OPEN, opens + 1)

        # Many ordinary keys and Enter in one physical write/read.
        start = len(session.output)
        opens = session.output.count(OPEN)
        session.write(b"rapid keys\r")
        session.sdk_post("rapid keys", after=start)
        session.until_count(OPEN, opens + 1)

        # Bracketed paste is one edit with multiline CRLF/CR normalization,
        # then Enter is a separate ordinary key.
        start = len(session.output)
        opens = session.output.count(OPEN)
        session.write(
            b"\x1b[200~line one\r\n" + "世界".encode("utf-8")
            + b"\r" + "第三行".encode("utf-8") + b"\x1b[201~\r"
        )
        session.sdk_post("line one\n世界\n第三行", after=start)
        session.until_count(OPEN, opens + 1)

        # APC events arrive in wire order between pieces of ordinary /ask.
        # The prior regression lost the 'ask' after a delayed React render.
        start = len(session.output)
        session.write(b"/a")
        session.tsp_event({"ev": "theme", "dark": False})
        session.write(b"s")
        session.tsp_event({"ev": "resize", "sf": "omnara:session", "cols": 100, "visible": True})
        session.write(b"k\r")
        session.sdk_post("/ask", after=start)
        session.until(b"Continue the fixture turn?", after=start)
        opens = session.output.count(OPEN)
        session.write(b"\r")  # Ink owns and resolves the question.
        session.until(b"Omnara lab interaction resolved", after=start)
        session.until_count(OPEN, opens + 1)

        # Withhold the ACK of an actual emitted editor frame as /quit starts.
        # The correct lifecycle waits for that ACK BEFORE surface close and
        # before returning the terminal to the following owned shell prompt.
        start = len(session.output)
        frames = session.output.count(FRAME)
        session.hold_acks = True
        session.write(b"/")
        session.until_count(FRAME, frames + 1, timeout=5)
        session.write(b"quit\r")
        if not session.held_acks:
            raise AssertionError("quit did not leave a real in-flight frame to ACK")
        deadline = time.monotonic() + 0.15
        while time.monotonic() < deadline:
            session.pump(min(0.02, deadline - time.monotonic()))
            if CLOSE in session.output[start:] or APP_EXIT in session.output[start:]:
                raise AssertionError("app closed or exited before its real frame ACK")
        session.release_held_acks()
        session.until(CLOSE, after=start, timeout=5)
        session.until(b"Native PTY proof:", after=start)
        session.assert_next_shell_clean()
        code = session.wait_exit()
        if code:
            raise AssertionError("real runChat fixture exited with " + str(code))
        print("Real OS PTY native input and clean next-shell proof passed (not a real Tern host).")
    except BaseException:
        sys.stderr.write(
            "Owned PTY transcript tail (diagnostic only):\n"
            + repr(bytes(session.output[-5000:])) + "\n"
        )
        raise
    finally:
        session.close()


def run_no_ack(node, tsx, lab):
    session = OwnedPty(node, tsx, lab, assert_pty=False)
    try:
        session.until(b"\x1b_tsp;q;", timeout=20)
        session.write(b"\x1b_tsp;r;" + json.dumps(HELLO, separators=(",", ":")).encode() + ST)
        session.until_count(OPEN, 1, timeout=20)
        session.hold_acks = True
        start = time.monotonic()
        frames = session.output.count(FRAME)
        session.write(b"/")
        session.until_count(FRAME, frames + 1, timeout=5)
        session.write(b"quit\r")
        session.until(CLOSE, timeout=5)
        if not session.held_acks:
            raise AssertionError("missing authentic frame for no-ACK deadline")
        # Do not synthesize any ACK. The app must time out its protocol wait,
        # restore the real tty, and leave the following shell input untouched.
        session.assert_next_shell_clean()
        elapsed = time.monotonic() - start
        if elapsed > 3:
            raise AssertionError("native close did not finish within bounded deadline")
        code = session.wait_exit(timeout=5)
        if code:
            raise AssertionError("no-ACK fixture exited with " + str(code))
        print("Real OS PTY missing-ACK deadline and clean next-shell proof passed.")
    except BaseException:
        sys.stderr.write(
            "Owned PTY no-ACK transcript tail:\n" + repr(bytes(session.output[-5000:])) + "\n"
        )
        raise
    finally:
        session.close()


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5) or (len(sys.argv) == 5 and sys.argv[4] != "--no-ack"):
        raise SystemExit("usage: pty-regression.py NODE TSX_CLI LAB_TS [--no-ack]")
    if len(sys.argv) == 5:
        run_no_ack(*sys.argv[1:4])
    else:
        run(*sys.argv[1:4])
