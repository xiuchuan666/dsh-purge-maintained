// Placeholders are filled by official-update.js. Quit the official client, run the downloaded installer, then reopen.
// ASCII only: WSH reads this file as ANSI.
var exe = __EXE_JSON__;
var installer = __INSTALLER_JSON__;
var resources = __RESOURCES_JSON__;
var installDir = __INSTALL_DIR_JSON__;
if (installDir.length > 3) installDir = installDir.replace(/[\\\/]+$/, '');
var logPath = __LOG_JSON__;
var fso = new ActiveXObject('Scripting.FileSystemObject');
var sh = new ActiveXObject('WScript.Shell');
var wmi = GetObject('winmgmts:\\\\.\\root\\cimv2');
function z(n) { return (n < 10 ? '0' : '') + n; }
function stamp() { var d = new Date(); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()); }
function log(m) { var f = fso.OpenTextFile(logPath, 8, true); f.WriteLine(stamp() + ' ' + m); f.Close(); }
function samePath(a, b) { return String(a || '').replace(/\//g, '\\').toLowerCase() === String(b || '').replace(/\//g, '\\').toLowerCase(); }
function pids() { var out = []; var e = new Enumerator(wmi.ExecQuery("SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name = 'DeepSeek Harness.exe'")); for (; !e.atEnd(); e.moveNext()) { var p = e.item(); if (samePath(p.ExecutablePath, exe)) out.push(p.ProcessId); } return out; }
function fileSize(fp) { if (!fso.FileExists(fp)) return -1; return fso.GetFile(fp).Size; }
function fileStamp(fp) { if (!fso.FileExists(fp)) return ''; return String(fso.GetFile(fp).DateLastModified); }
function readAll(fp) { try { var f = fso.OpenTextFile(fp, 1); var t = f.ReadAll(); f.Close(); return t; } catch (e) { return ''; } }
// FSO DeleteFolder(dir, true) walks into reparse points and empties the LINK TARGET.
// This machine lost resources\runtime exactly that way once, so every recursive delete
// below detaches the app\runtime junction with cmd rmdir first (Win32 RemoveDirectory
// does not follow reparse points).
function unlinkJunction(p) {
  if (!fso.FolderExists(p)) return false;
  try { sh.Run('cmd.exe /c rmdir "' + p + '"', 0, true); log('unlinked ' + p); return true; }
  catch (uErr) { log('unlink-fail ' + p + ' ' + (uErr && uErr.message ? uErr.message : uErr)); return false; }
}
function runtimeHealthy() { return fso.FileExists(runtime + '\\primary-runtime\\dependencies\\pnpm\\bin\\pnpm.mjs') && fso.FileExists(runtime + '\\bin\\node.exe'); }
log('update-begin');
WScript.Sleep(800);
var list = pids();
log('pids ' + list.join(','));
for (var i = 0; i < list.length; i++) sh.Run('taskkill.exe /F /PID ' + list[i], 0, true);
var deadline = new Date().getTime() + 20000;
var left = list;
while (new Date().getTime() < deadline) { left = pids(); if (left.length === 0) break; WScript.Sleep(200); }
log('left ' + left.length);
var asar = resources + '\\app.asar';
var bak = asar + '.bak';
var appDir = resources + '\\app';
var runtime = resources + '\\runtime';
var runtimeBak = resources + '\\runtime.dshpurge-bak';
var runtimeBakTmp = resources + '\\runtime.dshpurge-bak-tmp';
// The installer rewrites resources\ and the rollback below only ever restored app + asar,
// so a half-extracted runtime used to survive as "app looks fine, plugin market is dead".
// Keep one copy of the runtime payload for the duration of the update.
var runtimeBacked = false;
if (runtimeHealthy() && !fso.FolderExists(runtimeBak)) {
  try {
    if (fso.FolderExists(runtimeBakTmp)) fso.DeleteFolder(runtimeBakTmp, true);
    log('runtime-backup-start');
    fso.CopyFolder(runtime, runtimeBakTmp, true);
    fso.MoveFolder(runtimeBakTmp, runtimeBak);
    runtimeBacked = true;
    log('runtime-backup');
  } catch (bakErr) { log('runtime-backup ' + (bakErr && bakErr.message ? bakErr.message : bakErr)); }
} else if (fso.FolderExists(runtimeBak)) { runtimeBacked = true; log('runtime-backup-reuse'); }
var movedApp = false;
var prev = '';
if (fso.FolderExists(appDir)) {
  prev = appDir + '.dshpurge-prev';
  if (fso.FolderExists(prev)) prev = appDir + '.dshpurge-prev-' + (new Date().getTime());
  // Never let a live junction travel with the old tree: the copy would keep pointing at
  // resources\runtime and any later cleanup of *prev* would empty it again.
  unlinkJunction(appDir + '\\runtime');
  for (var n = 0; n < 40; n++) {
    try { fso.MoveFolder(appDir, prev); movedApp = true; log('moved-app'); break; }
    catch (moveErr) { log('move-app ' + (moveErr && moveErr.message ? moveErr.message : moveErr)); WScript.Sleep(250); }
  }
}
var copiedAsar = false;
if (!fso.FileExists(asar) && fso.FileExists(bak)) {
  try { fso.CopyFile(bak, asar, true); copiedAsar = true; log('restored-asar'); }
  catch (restoreErr) { log('restore-asar ' + (restoreErr && restoreErr.message ? restoreErr.message : restoreErr)); }
}
var exeBeforeSize = fileSize(exe);
var exeBeforeStamp = fileStamp(exe);
var asarBeforeSize = fileSize(asar);
var versionFile = resources.replace(/[\\\/]+$/, '') + '\\..\\version';
var versionBefore = readAll(versionFile);
function runInstaller(updated) {
  var args = updated ? ' --updated /S /D=' : ' /S /D=';
  return sh.Run('"' + installer + '"' + args + installDir, 0, true);
}
var code = runInstaller(true);
log('installer ' + code);
var exeChanged = fileSize(exe) !== exeBeforeSize || fileStamp(exe) !== exeBeforeStamp;
var asarChanged = fileSize(asar) !== asarBeforeSize;
var versionAfter = readAll(versionFile);
var versionChanged = versionBefore !== '' && versionAfter !== '' && versionAfter !== versionBefore;
var ok = exeChanged || asarChanged || versionChanged;
log('changed exe=' + exeChanged + ' asar=' + asarChanged + ' version=' + versionChanged);
if (!ok) {
  code = runInstaller(false);
  log('installer-plain ' + code);
  exeChanged = fileSize(exe) !== exeBeforeSize || fileStamp(exe) !== exeBeforeStamp;
  asarChanged = fileSize(asar) !== asarBeforeSize;
  versionAfter = readAll(versionFile);
  versionChanged = versionBefore !== '' && versionAfter !== '' && versionAfter !== versionBefore;
  ok = exeChanged || asarChanged || versionChanged;
  log('changed-plain exe=' + exeChanged + ' asar=' + asarChanged + ' version=' + versionChanged);
}
if (!ok) {
  if (copiedAsar && fso.FileExists(asar)) {
    // A truncated copy of the 213 MB archive that stays behind hides the unpacked app
    // and the client never starts again. Only drop it when it matches the backup byte size.
    var sizeOk = false;
    try { sizeOk = fileSize(asar) === fileSize(bak); } catch (sizeErr) { log('asar-size ' + sizeErr); }
    if (sizeOk) { try { fso.DeleteFile(asar, true); log('rehid-asar'); } catch (hideErr) { log('rehid-asar ' + hideErr); } }
    else { log('asar-copy-incomplete'); }
  }
  // A concurrent unpack helper may have recreated resources\app. On failure, move the patched dir back.
  if (movedApp && prev && fso.FolderExists(prev)) {
    if (fso.FolderExists(appDir)) {
      unlinkJunction(appDir + '\\runtime');
      try { fso.DeleteFolder(appDir, true); log('cleared-recreated-app'); } catch (clearErr) { log('cleared-recreated-app ' + clearErr); }
    }
    if (!fso.FolderExists(appDir)) {
      try { fso.MoveFolder(prev, appDir); log('restored-app'); } catch (backErr) { log('restored-app ' + backErr); }
    }
  }
  // Restore the runtime payload if the installer emptied it.
  if (fso.FolderExists(runtimeBak) && !runtimeHealthy()) {
    try {
      if (fso.FolderExists(runtime)) fso.DeleteFolder(runtime, true);
      fso.MoveFolder(runtimeBak, runtime);
      log('runtime-restored');
    } catch (rtErr) { log('runtime-restore ' + (rtErr && rtErr.message ? rtErr.message : rtErr)); }
  }
  try { sh.Environment('PROCESS').Remove('ELECTRON_RUN_AS_NODE'); } catch (ignore) {}
  sh.Run('"' + exe + '"', 1, false);
  log('started-old');
} else {
  if (!movedApp && fso.FolderExists(appDir)) log('move-app-failed');
  // The installer can leave runtime half extracted even when it "succeeded".
  if (fso.FolderExists(runtimeBak) && !runtimeHealthy()) {
    try {
      if (fso.FolderExists(runtime)) fso.DeleteFolder(runtime, true);
      fso.MoveFolder(runtimeBak, runtime);
      log('runtime-restored-after-ok');
    } catch (rtErr2) { log('runtime-restore ' + (rtErr2 && rtErr2.message ? rtErr2.message : rtErr2)); }
  } else if (fso.FolderExists(runtimeBak)) {
    try { fso.DeleteFolder(runtimeBak, true); log('runtime-backup-dropped'); } catch (dropErr) { log('runtime-backup-drop ' + dropErr); }
  }
  try {
    var marker = fso.CreateTextFile(resources + '\\dsh-purge-reapply-asar', true);
    marker.WriteLine('1');
    marker.Close();
    log('marker');
  } catch (markerErr) { log('marker ' + markerErr); }
  try { sh.Environment('PROCESS').Remove('ELECTRON_RUN_AS_NODE'); } catch (ignore2) {}
  sh.Run('"' + exe + '"', 1, false);
  log('started');
}
