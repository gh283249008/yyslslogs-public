$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Get-GameCaptureInterfaces($Flows) {
 $up=@(Get-NetAdapter -ErrorAction Stop | Where-Object {$_.Status -eq 'Up'})
 $selected=@();$evidence=@()
 foreach($flow in $Flows){
  $indices=@(Find-NetRoute -RemoteIPAddress $flow.serverAddress -LocalIPAddress $flow.clientAddress -ErrorAction SilentlyContinue | ForEach-Object {$_.InterfaceIndex} | Sort-Object -Unique)
  $match=@($up | Where-Object {$_.ifIndex -in $indices})
  $method='bound-flow-route'
  if($match.Count -ne 1){
   $indices=@(Get-NetIPAddress -IPAddress $flow.clientAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {$_.InterfaceIndex} | Sort-Object -Unique)
   $match=@($up | Where-Object {$_.ifIndex -in $indices});$method='unique-local-address'
  }
  if($match.Count -ne 1){throw 'Cannot uniquely select game capture adapter; refusing all-adapter capture'}
  $device='\Device\NPF_{'+$match[0].InterfaceGuid.ToString().Trim('{}')+'}'
  $selected+=$device
  $evidence+=@{interface=$device;interfaceIndex=$match[0].ifIndex;method=$method;flow=$flow}
 }
 return @{interfaces=@($selected | Select-Object -Unique);selection=$evidence}
}
try {
 $game=Get-Process -Name yysls -ErrorAction SilentlyContinue | Select-Object -First 1
 if(-not $game){@{status='waiting-game'}|ConvertTo-Json -Compress;exit}
 $module=$game.MainModule
 if(-not $module){throw 'Game module is inaccessible; administrator launch required'}
 $flows=@(Get-NetTCPConnection -OwningProcess $game.Id -State Established -ErrorAction SilentlyContinue | Where-Object {$_.RemotePort -ne 443 -and $_.RemotePort -ne 80 -and $_.RemoteAddress -ne '127.0.0.1' -and $_.RemoteAddress -notmatch ':'} | ForEach-Object {@{clientAddress=$_.LocalAddress;clientPort=$_.LocalPort;serverAddress=$_.RemoteAddress;serverPort=$_.RemotePort}})
 $capture=Get-GameCaptureInterfaces $flows
 @{status='running';pid=$game.Id;processStartUtc=$game.StartTime.ToUniversalTime().ToString('o');imageBase=('0x'+$module.BaseAddress.ToInt64().ToString('x'));modulePath=$module.FileName;flows=$flows;interfaces=$capture.interfaces;interfaceSelection=$capture.selection} | ConvertTo-Json -Depth 5 -Compress
} catch {@{status='access-error';error=$_.Exception.Message}|ConvertTo-Json -Compress}
