param([int]$GameProcessId=0,[string]$ExpectedStart='', [string]$UdpRemoteAddress='', [int]$UdpRemotePort=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Get-GameCaptureInterfaces($Flows) {
 $selected=@();$evidence=@()
 foreach($flow in $Flows){
  if([Net.IPAddress]::IsLoopback([Net.IPAddress]::Parse($flow.serverAddress))){
   $device='\Device\NPF_Loopback';$selected+=$device
   $evidence+=@{interface=$device;interfaceIndex=$null;method='game-owned-loopback';flow=$flow};continue
  }
  $up=@(Get-NetAdapter -ErrorAction Stop | Where-Object {$_.Status -eq 'Up'})
  if($flow.clientAddress -eq '0.0.0.0'){$routes=@(Find-NetRoute -RemoteIPAddress $flow.serverAddress -ErrorAction SilentlyContinue)}
  else{$routes=@(Find-NetRoute -RemoteIPAddress $flow.serverAddress -LocalIPAddress $flow.clientAddress -ErrorAction SilentlyContinue)}
  $indices=@($routes | ForEach-Object {$_.InterfaceIndex} | Sort-Object -Unique)
  $match=@($up | Where-Object {$_.ifIndex -in $indices})
  $method='bound-flow-route'
  if($match.Count -ne 1 -and $flow.clientAddress -ne '0.0.0.0'){
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
 $game=if($GameProcessId){Get-Process -Id $GameProcessId -ErrorAction SilentlyContinue}else{Get-Process -Name yysls -ErrorAction SilentlyContinue | Select-Object -First 1}
 if(-not $game){@{status='waiting-game'}|ConvertTo-Json -Compress;exit}
 if($game.ProcessName -ne 'yysls' -or ($ExpectedStart -and $game.StartTime.ToUniversalTime().Ticks -ne [DateTime]::Parse($ExpectedStart).ToUniversalTime().Ticks)){throw 'Selected game process changed'}
 $module=$game.MainModule
 if(-not $module){throw 'Game module is inaccessible; administrator launch required'}
 try{$connections=@(Get-NetTCPConnection -OwningProcess $game.Id -ErrorAction Stop)}catch{if($_.CategoryInfo.Category -eq 'ObjectNotFound'){$connections=@()}else{throw}}
 $established=@($connections | Where-Object {[int]$_.State -eq 5})
 # The game's own local accelerator socket remains a candidate, including 80/443.
 # Unique protocol alignment, never the port number, establishes the game stream.
 $flows=@($established | Where-Object {$_.RemoteAddress -notmatch ':' -and $_.LocalAddress -notmatch ':'} | ForEach-Object {@{clientAddress=$_.LocalAddress;clientPort=[int]$_.LocalPort;serverAddress=$_.RemoteAddress;serverPort=[int]$_.RemotePort;loopback=[Net.IPAddress]::IsLoopback([Net.IPAddress]::Parse($_.RemoteAddress))}})
 try{$udp=@(Get-NetUDPEndpoint -OwningProcess $game.Id -ErrorAction Stop | Where-Object {$_.LocalAddress -notmatch ':'} | ForEach-Object {@{clientAddress=$_.LocalAddress;clientPort=[int]$_.LocalPort}})}catch{if($_.CategoryInfo.Category -eq 'ObjectNotFound'){$udp=@()}else{throw}}
 $selection=@();$routeErrors=@();$udpRoutes=@()
 foreach($flow in $flows){try{$selection+=@(Get-GameCaptureInterfaces @($flow)).selection}catch{$routeErrors+=@{flow=$flow;error=$_.Exception.Message}}}
 # Only the validated game connection supplies the UDP remote, never a proxy PID.
 if($UdpRemoteAddress){
  $ip=[Net.IPAddress]::Parse($UdpRemoteAddress)
  if($ip.AddressFamily -ne 'InterNetwork' -or $UdpRemotePort -lt 1 -or $UdpRemotePort -gt 65535 -or -not $GameProcessId -or -not $ExpectedStart){throw 'Invalid bound UDP remote endpoint'}
  foreach($endpoint in $udp){
   $flow=@{clientAddress=$endpoint.clientAddress;clientPort=$endpoint.clientPort;serverAddress=$ip.ToString();serverPort=$UdpRemotePort}
   try{foreach($route in (Get-GameCaptureInterfaces @($flow)).selection){$udpRoutes+=@{interface=$route.interface;method=$route.method;endpoint=$endpoint}}}catch{$routeErrors+=@{flow=$flow;error=$_.Exception.Message}}
  }
 }
 @{status='running';pid=$game.Id;processStartUtc=$game.StartTime.ToUniversalTime().ToString('o');imageBase=('0x'+$module.BaseAddress.ToInt64().ToString('x'));modulePath=$module.FileName;flows=$flows;interfaces=@($selection.interface | Select-Object -Unique);interfaceSelection=$selection;udpEndpoints=$udp;udpRoutes=$udpRoutes;routeErrors=$routeErrors;connectionCounts=@{established=$established.Count;ipv4=$flows.Count;ipv6=$established.Count-$flows.Count;loopback=@($flows | Where-Object {$_.loopback}).Count}} | ConvertTo-Json -Depth 7 -Compress
} catch {@{status='access-error';error=$_.Exception.Message}|ConvertTo-Json -Compress}
