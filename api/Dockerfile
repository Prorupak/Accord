# syntax=docker/dockerfile:1
ARG PYTHON_IMAGE=python:3.13.16-slim

FROM ${PYTHON_IMAGE} AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.18 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/app/.venv/bin:$PATH
RUN useradd --system --uid 10001 --no-create-home accord
WORKDIR /app
COPY --from=build /app/.venv ./.venv
COPY app ./app
USER accord
EXPOSE 8000
# Not `python -m app`: that entrypoint binds API_HOST (localhost) and enables reload.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
