Output docs/demo/landing.mp4
Output docs/demo/landing.webm
Output docs/demo/landing.gif

Require monoceros
Require docker

Set Shell "zsh"
Set FontSize 23
Set Width 1400
Set Height 780
Set Padding 30
Set WindowBar Colorful
Set WindowBarSize 50
Set BorderRadius 8
Set Theme { "background": "#0e1818", "foreground": "#ecdfc8", "cursor": "#d4853a", "black": "#1c2b29", "red": "#c4543a", "green": "#8ab48a", "yellow": "#d4853a", "blue": "#5fa8b8", "purple": "#b07a98", "cyan": "#6ec8b8", "white": "#ecdfc8", "brightBlack": "#3a4a47", "brightRed": "#e07050", "brightGreen": "#a8c8a8", "brightYellow": "#e89f47", "brightBlue": "#7fc0d0", "brightPurple": "#c89ab8", "brightCyan": "#9ad8c8", "brightWhite": "#f4ede3" }
Set WaitTimeout 180s

Type "monoceros init myApp --with node, claude"
Sleep 600ms
Enter
Wait
Sleep 1s

Type "monoceros apply myApp"
Sleep 600ms
Enter
Wait
Sleep 1s

Type "monoceros run myApp -- node --version"
Sleep 600ms
Enter
Sleep 1s

Hide
Type "monoceros remove myApp --no-backup -y"
Enter
Wait