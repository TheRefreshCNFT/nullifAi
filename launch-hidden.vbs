' nullifAi Hidden Launcher
' Starts the Node.js bridge without a visible terminal window.
' Output is logged to nullifai-bridge.log in the project directory.

Set objShell = CreateObject("WScript.Shell")
strDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' Build the command: run node with output redirected to log file
strCmd = "cmd /c cd /d """ & strDir & """ && node """ & strDir & "\nullifai-bridge.js"" > """ & strDir & "\nullifai-bridge.log"" 2>&1"

' Run hidden (0 = hidden, False = don't wait)
objShell.Run strCmd, 0, False
