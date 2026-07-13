{
  description = "Development environment for stash-phash-inspector";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system:
        f (import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        })
      );
    in
    {
      # `nix develop` uses a normal shell; no bwrap re-entry loop.
      devShells = forEachSystem (pkgs:
        let
          electron = pkgs.electron;
        in
        {
          default = pkgs.mkShell {
            name = "stash-phash-inspector";

            buildInputs = with pkgs; [
              nodejs
              pnpm
              electron
              ffmpeg
              git
              gdb
              strace
            ];

            shellHook = ''
              export ELECTRON_SKIP_BINARY_DOWNLOAD=1
              export ELECTRON_OVERRIDE_DIST_PATH="${electron}/libexec/electron"
              export FFMPEG_PATH="${pkgs.ffmpeg}/bin/ffmpeg"
              export FFPROBE_PATH="${pkgs.ffmpeg}/bin/ffprobe"

              echo "stash-phash-inspector dev shell"
              echo "Run 'nix run .#fhs' to enter an FHS sandbox for pnpm/electron-builder."
            '';
          };
        }
      );

      # `nix run .#fhs` enters the FHS sandbox only when needed.
      packages = forEachSystem (pkgs:
        let
          electron = pkgs.electron;
        in
        {
          fhs = pkgs.buildFHSEnv {
            name = "stash-phash-inspector-fhs";

            targetPkgs = pkgs: with pkgs; [
              nodejs
              pnpm
              electron
              ffmpeg
              git
              gdb
              strace

              glib
              nss
              nspr
              atk
              at-spi2-atk
              at-spi2-core
              cups
              dbus
              expat
              libdrm
              mesa
              alsa-lib
              cairo
              pango
              gtk3
              gdk-pixbuf
              zlib
              libxkbcommon
              stdenv.cc.cc.lib
              libX11
              libXcomposite
              libXdamage
              libXext
              libXfixes
              libXrandr
              libxcb
            ];

            profile = ''
              export ELECTRON_SKIP_BINARY_DOWNLOAD=1
              export ELECTRON_OVERRIDE_DIST_PATH="${electron}/libexec/electron"
              export FFMPEG_PATH="${pkgs.ffmpeg}/bin/ffmpeg"
              export FFPROBE_PATH="${pkgs.ffmpeg}/bin/ffprobe"

              echo "stash-phash-inspector FHS sandbox"
              echo "Run 'pnpm install' then 'pnpm start' or 'pnpm run dist'."
            '';

            runScript = "bash";
          };
        }
      );
    };
}

