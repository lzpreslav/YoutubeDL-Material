{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    # Node.js (includes npm)
    nodejs

    # Media processing
    ffmpeg
    atomicparsley

    # yt-dlp runtime dependencies
    deno
    python3

    # Development tools
    git

    # Build tools
    gcc
    gnumake
    pkg-config
  ];

  shellHook = ''
    echo "🚀 YoutubeDL-Material Development Environment"
    echo "Node version: $(node --version)"
    echo "npm version: $(npm --version)"
    echo "FFmpeg version: $(ffmpeg -version | head -1)"
    echo "Python version: $(python3 --version)"
    echo ""
    echo "Run 'npm install' to install frontend dependencies"
    echo "Run 'npm run build' to build the frontend"
    echo "Run 'cd backend && npm install' to install backend dependencies"
    echo "Run 'cd backend && npm start' to start the server"
    echo ""
  '';
}
