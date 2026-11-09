# cleanup_test_credentials.ps1 —— P2-6 (2026-11-09)
#
# 清理测试留在 Windows 凭据管理器里的垃圾:
#   cf-server-user-me-<hash>.aidulc = "me"
#
# 来源: sync_service.rs 的 m3_sync_now_all_pushes_to_enabled_backends_only 用随机端口
# 的 mock worker 调 save_server_user_for_endpoint, 以前没有删除函数/清理步骤, 每跑一次
# cargo test 就多一条。2026-11-09 实测已累积 411 条。
#
# 安全约束:
#   - 只处理目标名以 cf-server-user-me- 开头的条目
#   - 只删除凭据值为 "me" 的条目 (不碰真实用户的 token/其它记录)
#   - 默认只打印"将要删除多少条", 加 -Apply 才真删
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\cleanup_test_credentials.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\cleanup_test_credentials.ps1 -Apply

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

if (-not ('AiduCred' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AiduCred
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr credential);

    /// <summary>读 Generic 凭据的密码; 不存在/读取失败返回 null。</summary>
    public static string ReadPassword(string target)
    {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return null;
        try
        {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            if (c.CredentialBlobSize <= 0) return "";
            byte[] bytes = new byte[c.CredentialBlobSize];
            Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
            return System.Text.Encoding.Unicode.GetString(bytes);
        }
        finally
        {
            CredFree(ptr);
        }
    }
}
'@
}

# cmdkey /list 的 Target 行形如:
#   Target: LegacyGeneric:target=cf-server-user-me-<hash>.aidulc
# 取 target= 后面的真实 TargetName (CredRead/CredDelete 都用它)。
$targets = @()
foreach ($line in (cmdkey /list 2>$null)) {
    if ($line -match 'target=(cf-server-user-me-[^\s]+)') {
        $targets += $Matches[1]
    }
}
$targets = $targets | Sort-Object -Unique

$matched = @()
foreach ($target in $targets) {
    $value = $null
    try { $value = [AiduCred]::ReadPassword($target) } catch { $value = $null }
    if ($value -eq 'me') { $matched += $target }
}

if (-not $Apply) {
    Write-Output "将删除 $($matched.Count) 条 (cf-server-user-me-* 且值为 me); 本次未修改任何凭据。"
    Write-Output "确认后加 -Apply 执行删除。"
    $matched | Select-Object -First 10 | ForEach-Object { Write-Output "  $_" }
    if ($matched.Count -gt 10) { Write-Output "  ... 其余 $($matched.Count - 10) 条从略" }
    exit 0
}

$deleted = 0
$failed = 0
foreach ($target in $matched) {
    & cmdkey.exe "/delete:$target" | Out-Null
    if ($LASTEXITCODE -eq 0) { $deleted++ } else { $failed++ }
}
Write-Output "已删除 $deleted 条; 失败 $failed 条。"
if ($failed -gt 0) { exit 1 }
exit 0
