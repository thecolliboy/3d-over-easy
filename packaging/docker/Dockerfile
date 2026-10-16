# Build image for the Linux package: Python 3.13 + compilers (for llama-cpp / build123d)
# + all app dependencies baked in so repeated builds are fast.
FROM python:3.13

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# App dependencies (compiles llama-cpp-python + build123d/OCCT for this platform)
RUN pip install --no-cache-dir \
        "Flask==3.1.0" "Flask-CORS==5.0.1" "gunicorn==23.0.0" "waitress==3.0.2" \
        "numpy>=2.0.0" "manifold3d>=3.5.0" "llama-cpp-python>=0.3.0" \
        "build123d>=0.8.0" "Pillow==11.1.0" "structlog==25.4.0" \
    && pip install --no-cache-dir pyinstaller

WORKDIR /src
