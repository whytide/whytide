# The browser service, `browser` in ../compose.yaml (core/packages/providers/browser/playwright/README.md):
# Playwright's own image, Chromium and its system libraries at the version of the playwright adapter's
# client, pinned by the digest of its index (../images.md). The playwright package is installed at
# build time, at the same version and without its scripts, so that the build downloads no browser and
# the image's own is used. The server runs as the image's user, pwuser, on 3000, two clients at a time
# and the next waiting; without --unsafe, so that no client chooses the browser's arguments or binary.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
RUN npm install --global --ignore-scripts playwright@1.64.1 && npm cache clean --force
USER pwuser
# The root file system is read-only: Chromium's profile, caches and shared memory go to the /tmp tmpfs.
ENV HOME=/tmp
CMD ["playwright", "run-server", "--port", "3000", "--host", "0.0.0.0", "--max-clients", "2"]
