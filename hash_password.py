"""Generate a PBKDF2 password verifier without exposing the password in argv."""
import getpass
import hashlib
import secrets


def main():
    password = getpass.getpass("Password: ")
    if not password or password != getpass.getpass("Repeat password: "):
        raise SystemExit("Passwords are empty or do not match.")
    try:
        if len(password) > 256:
            raise ValueError()
        password_bytes = password.encode("utf-8")
    except (ValueError, UnicodeError):
        raise SystemExit("Password must be valid UTF-8 and at most 256 characters.")
    salt = secrets.token_bytes(16)
    iterations = 600000
    digest = hashlib.pbkdf2_hmac("sha256", password_bytes, salt, iterations)
    print(f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}")


if __name__ == "__main__":
    main()
