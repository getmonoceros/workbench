# Monoceros (issue #71): keep the persisted toolchain bin dirs first on PATH.
#
# A language descriptor can persist the directory a project installs its own
# tools into (Go's GOBIN -> ~/go/bin), so `go install`ed binaries survive an
# `apply`. The Dockerfile puts that dir first via ENV PATH, which covers
# non-login shells - but a LOGIN shell re-runs /etc/profile, which rebuilds
# PATH from scratch and drops it. profile.d is sourced after that, so this is
# where the prepend has to be repeated.
#
# Ahead of the toolchain's own bin dir on purpose: the upstream Go feature
# ships tools in /go/bin (golangci-lint, staticcheck, …), and a project that
# pins its own version of one of them must win. Guarded on existence and on
# not already being first, so the snippet is a no-op for every workbench
# without the language.
for _mono_bin in "$HOME/go/bin"; do
  if [ -d "$_mono_bin" ]; then
    case ":$PATH:" in
      ":$_mono_bin:"*) ;;
      *) PATH="$_mono_bin:$PATH" ;;
    esac
  fi
done
unset _mono_bin
export PATH
