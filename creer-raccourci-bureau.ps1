$edgePath  = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$indexPath = "$PSScriptRoot\index.html"

$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\Eau Vivante Plasma.lnk")
$Shortcut.TargetPath       = $edgePath
$Shortcut.Arguments        = "`"$indexPath`""
$Shortcut.WorkingDirectory = $PSScriptRoot
$Shortcut.Description      = "Axis Lumen - Protocole Eau Vivante Plasma"
$Shortcut.IconLocation     = "$edgePath,0"
$Shortcut.Save()
Write-Host "Raccourci cree sur le bureau : Eau Vivante Plasma"
