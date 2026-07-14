# Security policy

## Supported versions

Until v1, only the latest commit on `main` receives security fixes. After v1, the latest released minor line and `main` will be supported.

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting on the repository’s Security tab. If it is unavailable, contact the repository owner privately through the contact method on their GitHub profile.

Include the affected version/commit, browser and operating system, reproduction steps, impact, and any suggested mitigation. Expect an acknowledgment within seven days. No bounty is promised, but responsible reporters will be credited with permission.

Especially relevant reports include document-parser injection, cross-origin model/cache confusion, unexpected network transmission of document data, service-worker cache leakage, unsafe OPFS path handling, and malicious model artifact behavior.
