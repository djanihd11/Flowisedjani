# Base image: Node.js 20 on Debian Bookworm
FROM node:20-bookworm

# Set non-interactive frontend for apt-get and timezone
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Install system dependencies
RUN apt-get update &&     apt-get install -y --no-install-recommends     # Python
    python3     python3-pip     python3-dev     python3-venv     # Build tools
    build-essential     pkg-config     # Libraries for common Python packages
    libssl-dev     gfortran     libffi-dev     libopenblas-dev     # Rust/Cargo (for some Python package builds)
    cargo     # Download/archive tools & certs
    wget     tar     unzip     ca-certificates     # Autotools & libtool (for TA-Lib and other source builds)
    autoconf     automake     libtool     # CMake
    cmake     # LLVM 15 (for llvmlite 0.44.0)
    llvm-15     llvm-15-dev     clang-15     # Chromium (for Puppeteer)
    chromium     # Curl
    curl     # Git (useful for pnpm, some package installs)
    git &&     # Clean up apt cache
    rm -rf /var/lib/apt/lists/*

# Ensure llvm-config-15 is used by things like llvmlite
ENV LLVM_CONFIG=/usr/bin/llvm-config-15

# Install TA-Lib from source
RUN echo "Installing TA-Lib from source..." &&     cd /tmp &&     wget https://github.com/ta-lib/ta-lib/releases/download/v0.6.4/ta-lib-0.6.4-src.tar.gz -O ta-lib-0.6.4-src.tar.gz &&     tar -xzf ta-lib-0.6.4-src.tar.gz &&     cd ta-lib-0.6.4/ &&     ./configure --prefix=/usr &&     make &&     make install &&     cd / &&     rm -rf /tmp/ta-lib-0.6.4 /tmp/ta-lib-0.6.4-src.tar.gz &&     echo "TA-Lib installation complete."

# Install PNPM globally
RUN npm install -g pnpm

# Set up environment for Node.js/Puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# Note: Path might be /usr/bin/chromium-browser on some Debian versions, check if /usr/bin/chromium fails.
ENV NODE_OPTIONS=--max-old-space-size=8192

# Set working directory
WORKDIR /usr/src

# Copy application source code
COPY . .

# Install Node.js dependencies
RUN pnpm install

# Build Flowise (Node.js components)
RUN pnpm build

# Copy vectorbt.pro source code
# User must ensure 'vectorbt.pro-main' directory exists in the build context (project root).
COPY vectorbt.pro-main /usr/src/vectorbt.pro-main

# Install Python dependencies for vectorbt.pro
RUN echo "Upgrading pip and installing prerequisites for vectorbt.pro..." &&     python3 -m pip install --upgrade pip setuptools wheel --no-cache-dir --break-system-packages &&     pip3 install pybind11 --no-cache-dir --break-system-packages &&     pip3 install --ignore-installed llvmlite --no-cache-dir --break-system-packages &&     pip3 install kaleido==0.1.0 --no-cache-dir --break-system-packages &&     echo "Installing vectorbt.pro from source..." &&     cd /usr/src/vectorbt.pro-main &&     pip3 install ".[base]" --no-cache-dir --break-system-packages &&     echo "vectorbt.pro installation complete."
    # Optionally, to save space if /usr/src/vectorbt.pro-main is large and not needed after install:
    # RUN rm -rf /usr/src/vectorbt.pro-main

# Expose port and define default command
EXPOSE 3000
CMD [ "pnpm", "start" ]
