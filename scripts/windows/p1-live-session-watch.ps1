param([Parameter(Mandatory=$true)][string]$Config,[string]$DiagnosticsDirectory='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$c=Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class P1ProcessIdentity {
 [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessIoCounters(IntPtr h,out Io value);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetSystemTimes(out long idle,out long kernel,out long user);
 public static object ProcessIo(uint pid){IntPtr h=OpenProcess(0x1000,false,pid);if(h==IntPtr.Zero)return null;try{Io v;return GetProcessIoCounters(h,out v)?(object)v:null;}finally{CloseHandle(h);}}
 public static long[] SystemTimes(){long i,k,u;return GetSystemTimes(out i,out k,out u)?new long[]{i,k,u}:null;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint a,bool b,uint p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder b,ref uint n);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("iphlpapi.dll",SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr table,ref int size,bool order,uint family,int tableClass,uint reserved);
 [DllImport("iphlpapi.dll",SetLastError=true)] static extern uint GetExtendedUdpTable(IntPtr table,ref int size,bool order,uint family,int tableClass,uint reserved);
 public static int UdpEndpoints(int pid,string address,int port){
  int size=0;uint rc=GetExtendedUdpTable(IntPtr.Zero,ref size,false,2,1,0);
  if(rc!=122&&rc!=0)throw new System.ComponentModel.Win32Exception((int)rc);
  for(int attempt=0;attempt<3;attempt++){
   IntPtr table=Marshal.AllocHGlobal(size);
   try{rc=GetExtendedUdpTable(table,ref size,false,2,1,0);if(rc==122)continue;if(rc!=0)throw new System.ComponentModel.Win32Exception((int)rc);
    int count=Marshal.ReadInt32(table),matches=0;
    for(int i=0;i<count;i++){IntPtr row=IntPtr.Add(table,4+12*i);if(Marshal.ReadInt32(row,8)==pid&&Address(Marshal.ReadInt32(row))==address&&Port(Marshal.ReadInt32(row,4))==port)matches++;}return matches;
   }finally{Marshal.FreeHGlobal(table);}
  }throw new InvalidOperationException("UDP table changed during bounded read");
 }
 static int Port(int v){return ((v&255)<<8)|((v>>8)&255);}
 static string Address(int v){return new System.Net.IPAddress(BitConverter.GetBytes(v)).ToString();}
 public static int Connections(int pid,string local,int localPort,string remote,int remotePort){
  int size=0;uint rc=GetExtendedTcpTable(IntPtr.Zero,ref size,false,2,5,0);
  if(rc!=122&&rc!=0)throw new System.ComponentModel.Win32Exception((int)rc);
  for(int attempt=0;attempt<3;attempt++){
   IntPtr table=Marshal.AllocHGlobal(size);
   try{rc=GetExtendedTcpTable(table,ref size,false,2,5,0);if(rc==122)continue;if(rc!=0)throw new System.ComponentModel.Win32Exception((int)rc);
    int count=Marshal.ReadInt32(table),matches=0;
    for(int i=0;i<count;i++){IntPtr row=IntPtr.Add(table,4+24*i);
     if(Marshal.ReadInt32(row)==5&&Marshal.ReadInt32(row,20)==pid&&Address(Marshal.ReadInt32(row,4))==local&&Port(Marshal.ReadInt32(row,8))==localPort&&Address(Marshal.ReadInt32(row,12))==remote&&Port(Marshal.ReadInt32(row,16))==remotePort)matches++;
    }return matches;
   }finally{Marshal.FreeHGlobal(table);}
  }throw new InvalidOperationException("TCP table changed during bounded read");
 }
 public static string Image(uint p){IntPtr h=OpenProcess(0x1000,false,p);if(h==IntPtr.Zero)return null;try{var b=new StringBuilder(32768);uint n=32768;return QueryFullProcessImageName(h,0,b,ref n)?b.ToString():null;}finally{CloseHandle(h);}}
}
'@
$networkClock=[Diagnostics.Stopwatch]::StartNew()
$nextNetworkSample=0
$networkState=@{interval=5000}
function Read-NetworkDiagnostics {
 $cost=[Diagnostics.Stopwatch]::StartNew()
 $row=@{kind='network-os';at=[DateTime]::UtcNow.ToString('o');intervalMs=$networkState.interval;captureInterface=$c.captureInterface;logicalProcessors=[Environment]::ProcessorCount;systemTimes100ns=[P1ProcessIdentity]::SystemTimes();adapters=@();processes=@();errors=@();scope='OS counters include other applications; not game packet loss or RTT'}
 try {
  $tcp=[Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetTcpIPv4Statistics()
  $row.systemTcp=@{sent=$tcp.SegmentsSent;received=$tcp.SegmentsReceived;resent=$tcp.SegmentsResent}
  foreach($nic in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
   if($nic.OperationalStatus -ne 'Up'){continue}
   $stat=$nic.GetIPv4Statistics()
   $row.adapters+=@{id=$nic.Id;name=$nic.Name;type=$nic.NetworkInterfaceType.ToString();received=$stat.BytesReceived;sent=$stat.BytesSent;rxDiscard=$stat.IncomingPacketsDiscarded;txDiscard=$stat.OutgoingPacketsDiscarded;rxError=$stat.IncomingPacketsWithErrors;txError=$stat.OutgoingPacketsWithErrors}
  }
 }catch{$row.errors+=('network-counters: '+$_.Exception.Message)}
 $ids=@{game=[int]$c.pid;watcher=$PID}
 try {
  $collector=Get-Content -LiteralPath (Join-Path $DiagnosticsDirectory 'collector.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $ids.pipeline=[int]$collector.pipelinePid;$ids.capture=[int]$collector.pid;$ids.schema=[int]$collector.schemaPid
 }catch{$row.errors+='collector-pids-unavailable'}
 foreach($role in $ids.Keys) {
  $proc=$null
  try {
   $proc=[Diagnostics.Process]::GetProcessById($ids[$role])
   $row.processes+=@{role=$role;pid=$proc.Id;startUtc=$proc.StartTime.ToUniversalTime().ToString('o');cpuMs=$proc.TotalProcessorTime.TotalMilliseconds;workingSetBytes=$proc.WorkingSet64;io=[P1ProcessIdentity]::ProcessIo($proc.Id)}
  }catch{$row.errors+=($role+': unavailable')}finally{if($null -ne $proc){$proc.Dispose()}}
 }
 $row.sampleCostMs=$cost.Elapsed.TotalMilliseconds
 # Read-only telemetry must not hold up the existing identity watcher.
 # Permanently back off for this session after an unexpectedly slow sample.
 if($cost.ElapsedMilliseconds -gt 50){$networkState.interval=30000}
 $row.nextIntervalMs=$networkState.interval
 $row | ConvertTo-Json -Depth 6 -Compress
}
while($true){
 try{
  $game=Get-Process -Id $c.pid -ErrorAction Stop
  $start=$game.StartTime.ToUniversalTime().ToString('o')
  $sameStart=[DateTime]::Parse($start).ToUniversalTime().Ticks -eq [DateTime]::Parse($c.processStartUtc).ToUniversalTime().Ticks
  $samePath=[P1ProcessIdentity]::Image($c.pid) -eq $c.processPath
  if($c.transport -eq 'kcp'){$matches=[P1ProcessIdentity]::UdpEndpoints($c.pid,$c.bindingUdpEndpoint.clientAddress,$c.bindingUdpEndpoint.clientPort)}
  else{$matches=[P1ProcessIdentity]::Connections($c.pid,$c.flow.clientAddress,$c.flow.clientPort,$c.flow.serverAddress,$c.flow.serverPort)}
  $ok=$sameStart -and $samePath -and $matches -eq 1
  @{valid=$ok;at=[DateTime]::UtcNow.ToString('o');reason=$(if($ok){'PID start time, image path and transport binding match'}else{'Process identity or transport endpoint changed'})} | ConvertTo-Json -Compress
  if(-not $ok){break}
  if($DiagnosticsDirectory -and $networkClock.ElapsedMilliseconds -ge $nextNetworkSample){
   try{Read-NetworkDiagnostics}catch{ @{kind='network-os';at=[DateTime]::UtcNow.ToString('o');error=$_.Exception.Message}|ConvertTo-Json -Compress }
   $nextNetworkSample=$networkClock.ElapsedMilliseconds+$networkState.interval
  }
 }catch{@{valid=$false;at=[DateTime]::UtcNow.ToString('o');reason='Bound process/connection no longer verifiable'} | ConvertTo-Json -Compress;break}
 Start-Sleep -Seconds 1
}
