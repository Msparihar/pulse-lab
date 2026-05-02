# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app

# Install uv
RUN pip install --no-cache-dir uv

# Copy dependency manifest only (cache this layer)
COPY pyproject.toml ./

# Sync deps into .venv. open-rppg imports pkg_resources at runtime, so we
# install setuptools explicitly afterwards to guarantee it's in the venv even
# if a transitive resolution skips it.
RUN uv sync --no-dev \
    && /app/.venv/bin/pip install --no-cache-dir setuptools

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH" \
    HOME=/home/appuser \
    MPLCONFIGDIR=/tmp/mpl \
    XDG_CACHE_HOME=/tmp/cache

# Minimum system libs required by opencv-python (headless mode)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the virtual environment from the builder
COPY --from=builder /app/.venv /app/.venv

# Copy application code
COPY main.py ./
COPY pipeline/ ./pipeline/
COPY static/ ./static/

# Create a non-root user WITH a real home dir so matplotlib / JAX / etc. can
# write their config caches without falling back to /tmp warnings.
RUN useradd --system --create-home --shell /bin/false appuser \
    && mkdir -p /app/uploads /tmp/mpl /tmp/cache \
    && chown -R appuser:appuser /app/uploads /tmp/mpl /tmp/cache /home/appuser

USER appuser

# Smoke check: pkg_resources must import. If this fails, the container is
# guaranteed to crash at startup — fail at build time instead so we notice.
RUN python -c "import pkg_resources; print('pkg_resources OK')"

EXPOSE 8000

# Model loads at startup and JAX XLA compile takes 5-10s on the first call.
# Allow 60s before healthcheck fires.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')"

CMD ["python", "main.py"]
