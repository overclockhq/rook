# Serves the rook marketing site (docs/) as a static site on zopcloud, using
# zopdev's GoFr-based static-server. The rook app itself is a Go binary built
# from cmd/rook (see README) — this Dockerfile exists only to deploy the website.
FROM zopdev/static-server:v0.0.9

# static-server runs as the nonroot user, so files must be chowned to it.
COPY --chown=nonroot:nonroot ./docs /static

# Serves /static on HTTP_PORT (default 8000).
CMD ["/main"]
