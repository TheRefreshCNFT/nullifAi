' nullclaw Gateway Hidden Launcher
' Starts the nullclaw gateway (Discord + channels) without a visible terminal window.
' Output is logged to nullclaw-gateway.log in the project directory.

Set objShell = CreateObject("WScript.Shell")
strDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' Build the command: run nullclaw gateway with output redirected to log file
strCmd = "cmd /c ""C:\Tools\nullclaw\2026.3.4\nullclaw.exe"" gateway > """ & strDir & "\nullclaw-gateway.log"" 2>&1"

' Run hidden (0 = hidden, False = don't wait)
objShell.Run strCmd, 0, False
