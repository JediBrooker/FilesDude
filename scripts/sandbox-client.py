#!/usr/bin/env python3
"""Hands a media sandbox run to FilesDude's sandbox helper (see sandbox-helper.py).

FilesDude starts this with the file to read as its standard input and where the output goes (a pipe,
or the file being written) as its standard output, and the request as its one argument. It passes
those two open files and the request to the helper, waits, and exits with the run's status. Killing
it stops the run.
"""

import os
import socket
import struct
import sys


def main():
    request = sys.argv[1].encode()
    path = os.environ.get("FILEDUDE_SANDBOX_SOCKET") or "/run/filesdude-sandbox/sandbox.sock"
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.connect(path)
    socket.send_fds(connection, [struct.pack("!I", len(request))], [0, 1])
    connection.sendall(request)
    # The helper has its own copies now; this process lets go of its, so the output ends when the run does.
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    data = b""
    while len(data) < 4:
        chunk = connection.recv(4 - len(data))
        if not chunk:
            sys.exit(1)
        data += chunk
    (code,) = struct.unpack("!i", data)
    sys.exit(code if 0 <= code < 256 else 1)


if __name__ == "__main__":
    main()
