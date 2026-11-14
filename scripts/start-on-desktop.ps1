# REQ-D006: starts a command line (Chrome, from launchChrome) on its OWN Windows desktop of the interactive window station, waits for it, then closes the desktop.
# A window on a desktop that is not the input desktop is never shown to the person at the machine and cannot take the keyboard focus.
# Documented mechanism: CreateDesktopW and STARTUPINFO.lpDesktop (Microsoft Learn, Desktops / CreateDesktopW / STARTUPINFOW).
# The caller (launchChrome) ends the whole run by killing this process tree (taskkill /T), which ends the Chrome started here; the desktop is closed by the system when its last process ends.
# Started only with windowsHide true by launchChrome when CC_CHROME_DESKTOP=own. Prints one word: ended, or the failing call and its Win32 error. Logs nothing and holds no secret.
param([Parameter(Mandatory=$true)][string]$B64)
$ErrorActionPreference = 'Stop'
$cmd = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($B64))
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class DeskRun {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktopW(string name, IntPtr dev, IntPtr devmode, uint flags, uint access, IntPtr sa);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Run(string cmdline, string deskName) {
    IntPtr desk = CreateDesktopW(deskName, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
    if (desk == IntPtr.Zero) return "CreateDesktop failed " + Marshal.GetLastWin32Error();
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = "WinSta0\\" + deskName;
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi)) { int e = Marshal.GetLastWin32Error(); CloseDesktop(desk); return "CreateProcess failed " + e; }
    while (WaitForSingleObject(pi.hProcess, 500) == 258) { }
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread); CloseDesktop(desk);
    return "ended";
  }
}
'@
[DeskRun]::Run($cmd, 'ccrun' + $PID)
