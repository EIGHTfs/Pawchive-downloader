#!/usr/bin/env python3
"""SSH 密码登录助手（等价 sshpass，零依赖：pty 驱动系统 ssh）。

用途：本机没有 sshpass/expect 时，用 pty 把密码喂给 ssh/scp。
用法：
  python3 ssh-pass.py <password> <ssh 参数...>       # 例如 python3 ssh-pass.py 'pw' root@10.10.10.64 'hostname'
  python3 ssh-pass.py --cmd <password> <ssh 参数...>
说明：只把密码送进第一次 password 提示；后续输出原样透传到 stdout/stderr。
"""
import os
import pty
import select
import sys

PASSWORD_PROMPTS = (b"password:", b"Password:", b"password for")


def run(password: str, argv: list) -> int:
    pid, fd = pty.fork()
    if pid == 0:  # 子进程：exec ssh
        os.execvp(argv[0], argv)
        os._exit(127)
    sent = False
    buf = b""
    while True:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        # 只回一次密码：匹配到 password 提示就写入
        if not sent and any(p in buf for p in PASSWORD_PROMPTS):
            os.write(fd, (password + "\n").encode())
            sent = True
            buf = b""
        sys.stdout.write(chunk.decode("utf-8", "replace"))
        sys.stdout.flush()
        if len(buf) > 8192:
            buf = buf[-4096:]
    _, status = os.waitpid(pid, 0)
    return status >> 8


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    args = sys.argv[1:]
    if args[0] == "--cmd":
        args = args[1:]
    pwd = args[0]
    ssh_argv = args[1:]
    sys.exit(run(pwd, ssh_argv))
