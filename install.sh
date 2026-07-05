#!/usr/bin/env bash
#
# The Monoceros installer moved to installer/install.sh (and, for Windows,
# installer/install.ps1). This old entry point stays only to point you at the
# current one - it does not install anything.
#
set -eu

printf '\n'
printf '  Monoceros: the installer has moved.\n'
printf '  -----------------------------------\n\n'
printf '  Reinstall with the current command for your system:\n\n'
printf '  macOS / Linux\n\n'
printf '    curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/install.sh | bash\n\n'
printf '  Windows (PowerShell)\n\n'
printf '    irm https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/install.ps1 | iex\n\n'
printf '  Full guide: https://getmonoceros.build/docs/start/installation/\n\n'

exit 1
