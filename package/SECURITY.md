# Security policy

## Supported versions

stet is pre-1.0. Only the latest published version receives security fixes.

## Reporting a vulnerability

Report privately — do not open a public issue, and do not disclose the finding
until a fix is released.

- Email: `<SECURITY-CONTACT — operator to fill before the public flip>`
- Or open a GitHub private vulnerability report on the repository's Security tab.

Include the affected version, a description, reproduction steps, and the impact
you believe it has. Expect an acknowledgement within a week.

## Scope

stet's core runs offline over files a project already trusts: it performs no
network I/O, opens no database connection, and reads no environment variables.
The security surface that matters is therefore the code that carries
credentials and mounts routes — the store adapters, the HTTP mount and its three
credential kinds (mount Bearer, preview signed token, the public forms posture).
Reports against those, against the CLI's file writes, and against any path where
descriptor or snapshot content reaches a render target unescaped are all in
scope.
