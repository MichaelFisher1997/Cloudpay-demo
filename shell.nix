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

  terraform = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "terraform";
    version = "1.16.5";

    src = pkgs.fetchurl {
      url = "https://releases.hashicorp.com/terraform/${version}/terraform_${version}_linux_amd64.zip";
      # Published in HashiCorp's terraform_1.16.5_SHA256SUMS.
      sha256 = "2bc2fcfff033265c9e02ca0351f01794eb122f62a9b2a49a3294b9e49eaab5e4";
    };

    nativeBuildInputs = [ pkgs.unzip ];
    dontUnpack = true;
    dontStrip = true;

    installPhase = ''
      runHook preInstall
      mkdir -p "$out/bin"
      unzip -j "$src" terraform -d "$out/bin"
      chmod 755 "$out/bin/terraform"
      runHook postInstall
    '';

    meta.platforms = [ "x86_64-linux" ];
  };
in
pkgs.mkShell {
  packages = [ awscli terraform pkgs.actionlint pkgs.shellcheck pkgs.groff pkgs.less ];

  shellHook = ''
    complete -C "$(command -v aws_completer)" aws
  '';
}
