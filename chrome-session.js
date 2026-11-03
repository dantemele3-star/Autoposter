const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const isProfileLock = error => /The browser is already running for |Failed to create a ProcessSingleton/i.test(error.message);

// Match a complete --user-data-dir argument, including Chrome's two Windows
// quoting styles. A similarly named profile or a child directory is not ours.
function windowsProfilePattern(profilePath) {
    if (!path.win32.isAbsolute(profilePath)) throw new Error('The Chrome profile path must be absolute.');
    const normalized = path.win32.normalize(profilePath).replace(/[\\/]+$/, '');
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const unquoted = /\s/.test(normalized) ? '' : `|${escaped}`;
    return `(?:^|\\s)(?:"--user-data-dir=${escaped}"|--user-data-dir(?:=|\\s+)(?:"${escaped}"${unquoted}))(?=\\s|$)`;
}

// The profile path is data in an environment variable, never shell source.
// Recheck ownership immediately before stopping a PID to avoid PID reuse.
const recoveryScript = `
$ErrorActionPreference = 'Stop'
try {
    $pattern = $env:AUTOPOSTER_PROFILE_PATTERN
    function ChromeProcesses {
        return @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction Stop)
    }
    function OwnsProfile($process) {
        return $process.Name -ieq 'chrome.exe' -and $process.CommandLine -and ($process.CommandLine -imatch $pattern)
    }
    $processes = @(ChromeProcesses)
    if (@($processes | Where-Object { -not $_.CommandLine }).Count -gt 0) {
        throw 'Windows could not read every Chrome command line; profile ownership cannot be verified.'
    }
    $stopped = @()
    foreach ($candidate in @($processes | Where-Object { (OwnsProfile $_) -and $_.CommandLine -inotmatch '(?:^|\\s)"?--type(?:=|\\s)' })) {
        if (-not $candidate.CreationDate) { throw 'Chrome process identity is incomplete; recovery stopped.' }
        $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $candidate.ProcessId) -ErrorAction Stop
        if ($current -and (OwnsProfile $current) -and $current.CreationDate -eq $candidate.CreationDate) {
            Stop-Process -Id $current.ProcessId -ErrorAction Stop
            $stopped += [int]$current.ProcessId
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $remaining = @(ChromeProcesses)
        if (@($remaining | Where-Object { -not $_.CommandLine }).Count -gt 0) {
            throw 'Chrome process inspection became unavailable; the profile lock was not changed.'
        }
        $owned = @($remaining | Where-Object { OwnsProfile $_ })
        if ($owned.Count -eq 0) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($owned.Count -gt 0) { throw 'A process still uses the Gameflip profile; its lock was not changed.' }
    [pscustomobject]@{ verified = $true; stopped = @($stopped) } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;

async function inspectAndStopWindowsProfile(profilePath, { executeCommand = execute } = {}) {
    try {
        const encoded = Buffer.from(recoveryScript, 'utf16le').toString('base64');
        const result = await executeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
            windowsHide: true, timeout: 20000, maxBuffer: 16384,
            env: { ...process.env, AUTOPOSTER_PROFILE_PATTERN: windowsProfilePattern(profilePath) }
        });
        const evidence = JSON.parse(result.stdout.trim());
        if (evidence.verified !== true || !Array.isArray(evidence.stopped) ||
            evidence.stopped.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid process inspection result.');
        return evidence;
    } catch (error) {
        // Do not include execFile's command text, environment, or process args.
        const detail = error.stderr?.trim().slice(0, 300) || error.code || error.message;
        throw new Error(`Windows could not safely release the Gameflip profile: ${detail}`);
    }
}

async function recoverWindowsProfile(profilePath, { log = () => {}, inspect = inspectAndStopWindowsProfile } = {}) {
    if (path.basename(profilePath) !== 'Gameflip_Ghost_Session') throw new Error('Refusing to recover a different Chrome profile.');
    const folder = fs.lstatSync(profilePath);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('The Gameflip profile must be a real directory.');
    const evidence = await inspect(profilePath);
    if (evidence.verified !== true || !Array.isArray(evidence.stopped)) throw new Error('Profile ownership could not be verified.');
    log(evidence.stopped.length
        ? `Stopped ${evidence.stopped.length} Chrome process(es) using only the Gameflip_Ghost_Session profile.`
        : 'No Chrome process is using the Gameflip_Ghost_Session profile.');
    // Never remove cookies, Local State, Preferences, the profile directory, or
    // posting history. Windows refuses unlink if the lock is still held.
    const lock = path.join(profilePath, 'lockfile');
    try {
        const info = fs.lstatSync(lock);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('The profile lock is not a regular file.');
        fs.unlinkSync(lock);
        log('Removed the stale Gameflip profile lockfile; saved login data is unchanged.');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function launchSession(puppeteer, options, { log = () => {}, platform = process.platform,
    recover = recoverWindowsProfile, stopRequested = () => false } = {}) {
    try { return await puppeteer.launch(options); }
    catch (error) {
        if (!isProfileLock(error)) throw error;
        if (stopRequested()) return null;
        try {
            if (platform !== 'win32') throw new Error('Automatic profile recovery is available on Windows.');
            log('Gameflip profile launch was blocked; checking only this profile for a leftover Chrome process or stale lock...');
            await recover(options.userDataDir, { log });
            if (stopRequested()) return null;
            log('Retrying Chrome once with the same saved Gameflip profile and selected Hidden Mode.');
            return await puppeteer.launch(options);
        } catch (recoveryError) {
            throw new Error(`The Gameflip Chrome profile could not be recovered automatically: ${recoveryError.message} ` +
                'Other Chrome profiles were not stopped. Saved login data and posting history were not reset.', { cause: error });
        }
    }
}

module.exports = { launchSession, recoverWindowsProfile, windowsProfilePattern, inspectAndStopWindowsProfile };
