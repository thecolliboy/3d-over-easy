# Deployment image for web-3d-builder: runs run.py directly (no PyInstaller).
# Build from the project root:  docker build -f packaging/docker/deploy.Dockerfile -t web3dbuilder .
# Run:  docker run --rm -p 8181:8181 web3dbuilder
FROM python:3.13

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Build-time compilers for llama-cpp-python and build123d (OCCT)
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Runtime dependencies only (no test tooling)
RUN pip install \
        "Flask==3.1.0" "Flask-CORS==5.0.1" "gunicorn==23.0.0" \
        "numpy>=2.0.0" "manifold3d>=3.5.0" "llama-cpp-python>=0.3.0" \
        "build123d>=0.8.0" "Pillow==11.1.0" "structlog==25.4.0"

# Only the files the program uses (no .git, tests, caches)
COPY run.py .
COPY app ./app
COPY static ./static
COPY templates ./templates
COPY ai/run_agent.py ./ai/
COPY ai/prompts ./ai/prompts
COPY ai/models ./ai/models
COPY .config .

# Container defaults: bind all interfaces for port mapping, disable in-container browser; mount your own .config to override.
RUN sed -i 's/^host = "localhost"/host = "0.0.0.0"/' .config \
    && sed -i 's/^open_browser = true/open_browser = false/' .config \
    && mkdir -p ai/input ai/output

EXPOSE 8181
CMD ["python", "run.py"]
