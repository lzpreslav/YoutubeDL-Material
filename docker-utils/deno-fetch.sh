#!/bin/sh

case $(uname -m) in
  x86_64)
    ARCH=x86_64;;
  aarch64)
    ARCH=aarch64;;
  *)
    echo "Unsupported architecture: $(uname -m)"
    exit 1
esac

echo "(INFO) Architecture detected: $ARCH"
echo "(1/4) READY - Acquire temp dependencies for Deno obtain layer"
apt-get update && apt-get -y install curl unzip
echo "(2/4) DOWNLOAD - Acquire latest Deno release from GitHub releases"
curl -o deno.zip \
    --connect-timeout 5 \
    --max-time 120 \
    --retry 5 \
    --retry-delay 0 \
    --retry-max-time 40 \
    "https://github.com/denoland/deno/releases/latest/download/deno-${ARCH}-unknown-linux-gnu.zip"
mkdir /tmp/deno
unzip -d /tmp/deno deno.zip
echo "(3/4) CLEANUP - Remove temp dependencies from Deno obtain layer"
apt-get -y remove curl unzip
apt-get -y autoremove
echo "(4/4) PROVISION - Provide deno binary from Deno obtain layer"
cp /tmp/deno/deno /usr/local/bin/deno
chmod +x /usr/local/bin/deno
rm -rf /tmp/deno deno.zip
