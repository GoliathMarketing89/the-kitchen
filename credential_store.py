"""Protected POSIX verifier storage for the single-process pilot."""
import os
import stat
import secrets
from pathlib import Path


class StoreError(Exception):
    pass


class StoreWriteUncertain(StoreError):
    pass


def _open_parent(path, checkout):
    if not hasattr(os, "getuid") or not hasattr(os, "O_NOFOLLOW"):
        raise StoreError("Protected credential storage is unavailable")
    candidate = Path(path)
    if not candidate.is_absolute() or not candidate.name or ".." in candidate.parts:
        raise StoreError("Invalid credential path")
    try:
        candidate.relative_to(checkout)
        raise StoreError("Credential store is inside the checkout")
    except ValueError:
        pass
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = None
    try:
        fd = os.open("/", flags)
        parts = candidate.parts[1:-1]
        for part in parts:
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            info = os.fstat(fd)
            mode = stat.S_IMODE(info.st_mode)
            if info.st_uid not in (0, os.getuid()):
                raise StoreError("Unsafe credential path")
            if mode & 0o022 and not (info.st_uid == 0 and mode & stat.S_ISVTX):
                raise StoreError("Unsafe credential path")
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise StoreError("Unsafe credential directory")
        return fd, candidate.name
    except Exception as exc:
        if fd is not None:
            os.close(fd)
        if isinstance(exc, StoreError):
            raise
        raise StoreError("Credential directory unavailable") from exc


def _open_file(directory_fd, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 1024):
            os.close(fd)
            raise StoreError("Unsafe credential file")
        return fd
    except OSError as exc:
        raise StoreError("Credential file unavailable") from exc


def read_verifier(path, checkout):
    directory_fd, name = _open_parent(path, checkout)
    try:
        fd = _open_file(directory_fd, name)
        try:
            with os.fdopen(fd, "rb") as handle:
                data = handle.read(1025)
            if len(data) > 1024:
                raise StoreError("Invalid credential file")
            return data.decode("ascii").removesuffix("\n")
        except (UnicodeError, OSError) as exc:
            raise StoreError("Invalid credential file") from exc
    finally:
        os.close(directory_fd)


def replace_verifier(path, checkout, verifier):
    directory_fd, name = _open_parent(path, checkout)
    temp = ".credential-" + secrets.token_hex(16)
    replaced = False
    try:
        old = _open_file(directory_fd, name)
        os.close(old)
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write((verifier + "\n").encode("ascii"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        replaced = True
        os.fsync(directory_fd)
    except Exception as exc:
        if replaced:
            raise StoreWriteUncertain("Credential update could not be confirmed") from exc
        raise StoreError("Credential update failed") from exc
    finally:
        try:
            os.unlink(temp, dir_fd=directory_fd)
        except OSError:
            pass
        finally:
            try:
                os.close(directory_fd)
            except OSError:
                pass
