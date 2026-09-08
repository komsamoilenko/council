// Owns live ACL success checks; all fixtures stay in the system temp directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import win32 from '../src/platform/win32.js';

const quote = value => "'" + value.replace(/'/g, "''") + "'";
function ps(command) {
  // Let Windows PowerShell discover its own modules when launched from PowerShell 7.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
  return execFileSync(win32.systemBinaries().powershell,
    ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + command],
    {encoding:'utf8', windowsHide:true, timeout:15000, env}).trim();
}

if (process.platform !== 'win32') {
  console.log('SKIP: live ACL test requires Windows');
} else {
  const temp = fs.realpathSync.native(os.tmpdir());
  // Query the actual containing volume, including mounted volumes, without elevation.
  const volume = JSON.parse(ps(`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AclTestVolume {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetVolumePathName(string path, StringBuilder volume, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetVolumeInformation(string root, StringBuilder name, uint nameSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder format, uint formatSize);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern uint GetDriveType(string root);
}
'@
$root=[Text.StringBuilder]::new(1024); $format=[Text.StringBuilder]::new(256);
if(-not [AclTestVolume]::GetVolumePathName(${quote(temp)},$root,1024)){throw 'Volume path query failed'};
[uint32]$serial=0; [uint32]$max=0; [uint32]$flags=0;
if(-not [AclTestVolume]::GetVolumeInformation($root.ToString(),$null,0,[ref]$serial,[ref]$max,[ref]$flags,$format,256)){throw 'Volume format query failed'};
@{format=$format.ToString(); type=[AclTestVolume]::GetDriveType($root.ToString())} | ConvertTo-Json -Compress
`));
  if (volume.format !== 'NTFS' || ![2,3,6].includes(volume.type)) {
    console.log('SKIP: system temp directory is not on a local NTFS volume: ' + JSON.stringify(volume));
  } else {
    const dir = fs.mkdtempSync(path.join(temp, 'council-acl-live-'));
    assert.equal(path.dirname(fs.realpathSync.native(dir)), temp);
    try {
      const result = await win32.restrictToOwner(dir);
      console.log('restrictToOwner: ' + JSON.stringify(result));
      assert.deepEqual(result, {ok:true}, result.error?.stack);
      const acl = JSON.parse(ps(`$a=Get-Acl -LiteralPath ${quote(dir)};
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
@{protected=$a.AreAccessRulesProtected; currentUser=$sid;
sddl=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);
rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
@{sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); rights=[int64]$_.FileSystemRights; inherited=$_.IsInherited}
})} | ConvertTo-Json -Depth 4 -Compress`));
      console.log('DACL readback: ' + JSON.stringify(acl));
      assert.equal(acl.protected, true);
      assert.ok(acl.rules.some(rule => rule.sid === acl.currentUser && rule.type === 'Allow' &&
        (rule.rights & 2032127) === 2032127 && !rule.inherited), 'current user has explicit full control');
    } finally {
      execFileSync(path.join(win32.tokens().SYSTEMROOT, 'System32', 'icacls.exe'),
        [dir, '/reset'], {windowsHide:true, timeout:15000});
      assert.equal(ps(`(Get-Acl -LiteralPath ${quote(dir)}).AreAccessRulesProtected`), 'False');
      assert.deepEqual(fs.readdirSync(dir), []);
      console.log('Restored inheriting ACL; directory readable: true');
      // Nonrecursive removal can only delete the empty fixture created above.
      fs.rmdirSync(dir);
    }
    console.log('win32 live ACL success checks passed');
  }
}
