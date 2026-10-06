{ pkgs ? import (builtins.fetchTarball "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.xz") { } }:

let
  # Latest upstream release when this shell was created. Nixpkgs currently lags behind.
  awscli = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "awscli2";
    version = "2.37.9";

    src = pkgs.fetchurl {
      url = "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${version}.zip";
      sha256 = "0mpkckp4ps5vrqflxrf28bran922j5kbixxxy0l7k6dkgcynlfkb";
    };

    nativeBuildInputs = [ pkgs.unzip pkgs.autoPatchelfHook ];
    buildInputs = [ pkgs.zlib pkgs.stdenv.cc.cc.lib ];
    dontStrip = true;

    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/aws-cli" "$out/bin"
      cp -r dist/. "$out/lib/aws-cli/"
      ln -s "$out/lib/aws-cli/aws" "$out/bin/aws"
      ln -s "$out/lib/aws-cli/aws_completer" "$out/bin/aws_completer"
      runHook postInstall
    '';

    meta.platforms = [ "x86_64-linux" ];
  };
in
pkgs.mkShell {
  packages = [ awscli pkgs.groff pkgs.less ];

  shellHook = ''
    complete -C "$(command -v aws_completer)" aws
  '';
}
