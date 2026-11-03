const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { inspectAndStopWindowsProfile } = require('../chrome-session');

// Exercise the actual recovery script with harmless replacement CIM/Stop
// cmdlets. Windows uses its installed PowerShell; Linux can opt into pwsh.
const powershell = process.env.AUTOPOSTER_TEST_PWSH || (process.platform === 'win32' ? 'powershell.exe' : null);
const execute = promisify(execFile);
const profile = 'C:\\Users\\A B\\AppData\\Local\\Gameflip_Ghost_Session';
const chrome = (id, directory, extra = '') => ({ Name: 'chrome.exe', ProcessId: id,
    CommandLine: `chrome.exe "--user-data-dir=${directory}" ${extra}`, CreationDate: '2026-11-01T00:00:00Z' });
const fixtures = `
$script:processes = @(ConvertFrom-Json $env:AUTOPOSTER_TEST_PROCESSES)
$script:allowedStops = @(ConvertFrom-Json $env:AUTOPOSTER_TEST_STOPS)
function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    if ($Filter -like 'ProcessId = *') {
        $wanted = [int]($Filter -replace 'ProcessId = ', '')
        if ($env:AUTOPOSTER_TEST_REUSED -eq 'yes') {
            $script:processes = @($script:processes | ForEach-Object {
                if ($_.ProcessId -eq $wanted) { $_.CreationDate = '2026-11-02T00:00:00Z'; $_.CommandLine = 'chrome.exe --user-data-dir=C:\\RegularChrome' }
                $_
            })
        }
        return @($script:processes | Where-Object { $_.ProcessId -eq $wanted })
    }
    return $script:processes
}
function Stop-Process {
    [CmdletBinding()]
    param([int]$Id)
    if ($script:allowedStops -notcontains $Id) { throw 'TEST: An unrelated Chrome process was selected!' }
    $script:processes = @($script:processes | Where-Object { $_.ProcessId -ne $Id -and $_.ParentProcessId -ne $Id })
}
`;

async function inspect(processes, allowedStops = [], reused = false) {
    return inspectAndStopWindowsProfile(profile, { executeCommand: (file, args, options) => {
        assert.equal(file, 'powershell.exe');
        assert.equal(args.at(-2), '-EncodedCommand');
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        const combined = Buffer.from(fixtures + script, 'utf16le').toString('base64');
        return execute(powershell, [...args.slice(0, -1), combined], {
            ...options, env: { ...options.env, AUTOPOSTER_TEST_PROCESSES: JSON.stringify(processes),
                AUTOPOSTER_TEST_STOPS: JSON.stringify(allowedStops), AUTOPOSTER_TEST_REUSED: reused ? 'yes' : 'no' }
        });
    } });
}

test('PowerShell stops only the verified profile root and leaves normal Chrome and similar profiles alone', { skip: !powershell }, async () => {
    const child = { ...chrome(102, profile, '--type=renderer'), ParentProcessId: 101 };
    const result = await inspect([chrome(101, profile), child, chrome(201, 'C:\\RegularChrome'), chrome(301, profile + '-other')], [101]);
    assert.deepEqual(result, { verified: true, stopped: [101] });
});

test('PowerShell verifies no active profile owner without stopping normal Chrome', { skip: !powershell }, async () => {
    assert.deepEqual(await inspect([chrome(201, 'C:\\RegularChrome')]), { verified: true, stopped: [] });
});

test('PowerShell refuses recovery when a Chrome command line is inaccessible', { skip: !powershell }, async () => {
    await assert.rejects(inspect([chrome(101, profile), { ...chrome(201, 'C:\\RegularChrome'), CommandLine: null }]), /ownership cannot be verified/);
});

test('PowerShell rechecks process identity before stopping a reused PID', { skip: !powershell }, async () => {
    assert.deepEqual(await inspect([chrome(101, profile)], [], true), { verified: true, stopped: [] });
});

test('PowerShell refuses to clear the lock while any Gameflip profile process remains', { skip: !powershell }, async () => {
    await assert.rejects(inspect([chrome(102, profile, '--type=renderer')]), /process still uses the Gameflip profile/);
});
