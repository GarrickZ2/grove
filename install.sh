#!/bin/sh
# Grove installer script
# Usage: curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh

set -e

REPO="GarrickZ2/grove"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="grove"
GROVE_GUI="${GROVE_GUI:-0}"

# Detect OS and architecture
detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case "$ARCH" in
        x86_64|amd64)
            ARCH="x86_64"
            ;;
        arm64|aarch64)
            ARCH="aarch64"
            ;;
        *)
            echo "Error: Unsupported architecture: $ARCH"
            exit 1
            ;;
    esac

    case "$OS" in
        darwin)
            OS="apple-darwin"
            ;;
        linux)
            if [ "$GROVE_GUI" = "1" ]; then
                if [ "$ARCH" != "x86_64" ]; then
                    echo "Error: Linux GUI binary currently supports x86_64 only"
                    exit 1
                fi
                OS="unknown-linux-gnu-gui"
            else
                OS="unknown-linux-musl"
            fi
            ;;
        *)
            echo "Error: Unsupported OS: $OS"
            exit 1
            ;;
    esac

    PLATFORM="${ARCH}-${OS}"
    echo "Detected platform: $PLATFORM"
}

check_linux_gui_deps() {
    if [ "$GROVE_GUI" != "1" ] || [ "$(uname -s)" != "Linux" ]; then
        return
    fi

    if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4.1.so.0'; then
        echo "Warning: Linux GUI requires WebKitGTK/GTK runtime libraries."
        echo "On Debian/Ubuntu, install:"
        echo "  sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2"
        echo ""
    fi
}

# Get latest release tag
get_latest_version() {
    VERSION=$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    if [ -z "$VERSION" ]; then
        echo "Error: Could not determine latest version"
        exit 1
    fi
    echo "Latest version: $VERSION"
}

# Download and install
install() {
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY_NAME}-${VERSION}-${PLATFORM}.tar.gz"

    echo "Downloading from: $DOWNLOAD_URL"

    TMP_DIR=$(mktemp -d)
    trap "rm -rf $TMP_DIR" EXIT

    curl -sSL "$DOWNLOAD_URL" | tar -xz -C "$TMP_DIR"

    if [ ! -f "$TMP_DIR/$BINARY_NAME" ]; then
        echo "Error: Binary not found in archive"
        exit 1
    fi

    # Install binary
    if [ -w "$INSTALL_DIR" ]; then
        mv "$TMP_DIR/$BINARY_NAME" "$INSTALL_DIR/"
    else
        echo "Installing to $INSTALL_DIR (requires sudo)"
        sudo mv "$TMP_DIR/$BINARY_NAME" "$INSTALL_DIR/"
    fi

    chmod +x "$INSTALL_DIR/$BINARY_NAME"

    echo ""
    echo "Grove installed successfully!"
    echo "Run 'grove' to get started."
}

main() {
    echo "Installing Grove..."
    echo ""

    detect_platform
    check_linux_gui_deps
    get_latest_version
    install
}

main
