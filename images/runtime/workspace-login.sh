# Monoceros (ADR 0022): land interactive SSH/login shells in the dev
# container's workspace instead of $HOME. There is exactly one directory
# under /workspaces (the bind-mounted container dir), so glob to it.
#
# Sourced from /etc/profile.d by login shells. Guards keep it unobtrusive:
#   - only interactive shells ($- contains 'i'), so `ssh host <cmd>` and
#     IDE backend processes (non-interactive) are untouched;
#   - only when the shell starts at $HOME, so a later `cd` is never undone.
case $- in
  *i*)
    if [ "$PWD" = "$HOME" ]; then
      for _ws in /workspaces/*/; do
        if [ -d "$_ws" ]; then
          cd "$_ws" || true
          break
        fi
      done
      unset _ws
    fi
    ;;
esac
