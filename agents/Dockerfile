# The agents image: one image, one process per agent (the command picks which).
# Build from agents/: docker build -t talk-tracks-agents:dev .
FROM python:3.13-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --extra moq --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev --extra moq
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "-m", "talk_tracks"]
