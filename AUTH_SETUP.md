# Authentication setup (local pilot)

Provision credentials and HTTPS before exposing this release. Credential-bearing runtime files are excluded from the current source tree. The login password and exposed Kitchen tunnel secret were rotated on 12 November 2026; historical copies remain in Git and must not be reused. Do not put new secrets in the repository. See `DEPLOYMENT_RUNBOOK.md` before updating an existing installation: preserve host configuration outside the checkout before any Git update that removes formerly tracked runtime files.

Set these environment variables outside the checkout, in a protected service environment:

- `KITCHEN_USER`: the owner's username, up to 256 characters.
- `KITCHEN_PASSWORD_HASH`: run `python hash_password.py` interactively on a trusted machine and securely provision its output. Do not pass passwords as command-line arguments or commit the verifier. Use a strong unique password.
- `KITCHEN_ORIGIN`: exact browser HTTPS origin, for example `https://manager.example.com` (no trailing slash or path). All state-changing requests require this Origin and JSON content type.

Missing or invalid settings cause API requests to fail closed with 503. Cookies require HTTPS, including local browser checks. The hash uses PBKDF2-HMAC-SHA256 with 600,000 iterations and a random salt. Generate a new verifier to change the password; changing any of these settings invalidates existing sessions.

This is a **single-process pilot**: random server-side sessions expire after eight hours and are lost on restart. A maximum of 256 sessions and 1,024 login-client entries are held in memory; login attempts are limited to five per client per five minutes. These limits are per process, not distributed or durable. Do not run multiple workers without replacing both stores with shared, suitably protected storage. The backend uses the direct client address; it must not trust forwarded headers from clients. `python backend.py` explicitly disables Uvicorn proxy-header handling. If launching Uvicorn separately, use `--no-proxy-headers`. Behind a tunnel, clients may share one direct address and the limit may affect all users; determine a trusted proxy and enforce a suitable limit at the edge before deployment. Never trust a forwarded address without explicit trusted-proxy configuration.

Confirm the actual manager origin, HTTPS termination, routing, access controls and Hermes profile permissions before release. Limit request sizes at the edge as well. The chat agent still needs separate capability isolation and reliability work; authentication does not constrain its tools. Session storage and throttles do not provide multi-process coordination or resistance to a distributed login attack.

For local automated checks, install `requirements-test.txt` in an isolated environment and run `python -m unittest discover -s tests -v`. Tests must mock the agent and use synthetic data and credentials.
