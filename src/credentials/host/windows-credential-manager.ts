/**
 * The Windows Credential Manager transport.
 *
 * Reaches `CredReadW` / `CredWriteW` / `CredDeleteW` in `advapi32.dll` through
 * a PowerShell helper that P/Invokes them. The `CREDENTIAL` layout is taken
 * from the marshaller (`Marshal.SizeOf`, `Marshal.Copy`, `Encoding.Unicode`)
 * rather than assumed, and `CredFree` releases every pointer the OS returns.
 *
 * Side effects and lifetime:
 *
 * - Each call spawns `powershell.exe`, which compiles the P/Invoke type on
 *   first use. A round trip takes roughly 0.5–2 s.
 * - The value is written to the helper's stdin as base64 and the answer returns
 *   on stdout, both anonymous pipes. It is not in `argv`, the environment, a
 *   file, or a log. The `-EncodedCommand` argument carries only the fixed
 *   program text.
 * - Base64 is a fidelity measure, not encryption.
 * - The helper runs with a trimmed environment, not the caller's.
 * - `CredEnumerateW` is never called, so nothing here can list another
 *   application's credentials.
 * - Errors carry a `KeyringFailureCode`. No path falls back to a credential
 *   file or a `.env`.
 *
 * This stores the value in the OS credential store and keeps it out of files,
 * argv, environment, and logs. It does not isolate it from other processes
 * running as the same Windows user, which can call Credential Manager
 * directly.
 *
 * @module @one-person-lab/dsh-opl/credentials/windows-credential-manager
 */

import { spawn } from 'node:child_process'
import {
  BAMBOO_STARTLUX_KEYRING_TARGET,
  KeyringError,
  KEYRING_TARGET_PREFIX,
  MAX_KEYRING_BLOB_BYTES,
  MAX_KEYRING_TARGET_LENGTH,
  type KeyringFailureCode,
} from '../contracts/windows-keyring.ts'

/** Prefix the helper prefixes every reply with, so host noise can be skipped. */
const REPLY_MARKER = 'OPLKEYRING|'

/** Reply code: the P/Invoke type did not compile, so no WinCred call is possible. */
const CODE_COMPILE_FAILED = 1001

/** Reply code: the operation name did not match a helper entry point. */
const CODE_UNKNOWN_OPERATION = 1002

/** Reply code: the helper threw somewhere the C# side did not anticipate. */
const CODE_UNEXPECTED = 1003

/** WinCred `ERROR_NOT_FOUND`. */
const WIN32_ERROR_NOT_FOUND = 1168

/** WinCred `ERROR_ACCESS_DENIED`. */
const WIN32_ERROR_ACCESS_DENIED = 5

/** WinCred `ERROR_NO_SUCH_LOGON_SESSION`: this token has no credential set. */
const WIN32_ERROR_NO_SUCH_LOGON_SESSION = 1312

/** Default budget for one helper round trip, including P/Invoke compilation. */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * The helper program, passed verbatim as `-EncodedCommand`.
 *
 * A literal here-string, so PowerShell does not interpolate `$` into the C#
 * source. Built per call because it embeds {@link C_SHARP}, declared below.
 * Contains no secret; the value arrives on stdin.
 */
function helperProgram(): string {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$op = ''
$target = ''
$secret = ''
try {
Add-Type -TypeDefinition @'
${C_SHARP}
'@
} catch {
  [Console]::Out.WriteLine('${REPLY_MARKER}ERR|${CODE_COMPILE_FAILED}')
  [Console]::Out.Flush()
  exit 0
}
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $op = [string]$request.op
  $target = [string]$request.target
  if ($request.PSObject.Properties.Name -contains 'secretB64' -and $request.secretB64) {
    $secret = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String([string]$request.secretB64))
  }
  switch ($op) {
    'read'       { [Console]::Out.WriteLine('${REPLY_MARKER}' + [OplDsh.Wincred.Bridge]::Read($target)) }
    'write'      { [Console]::Out.WriteLine('${REPLY_MARKER}' + [OplDsh.Wincred.Bridge]::Write($target, $secret)) }
    'exists'     { [Console]::Out.WriteLine('${REPLY_MARKER}' + [OplDsh.Wincred.Bridge]::Exists($target)) }
    'delete'     { [Console]::Out.WriteLine('${REPLY_MARKER}' + [OplDsh.Wincred.Bridge]::Delete($target)) }
    'structsize' { [Console]::Out.WriteLine('${REPLY_MARKER}' + [OplDsh.Wincred.Bridge]::StructSize()) }
    'argvscan' {
      # Reports whether the value it was handed on stdin is visible in this
      # process's own command line or environment. It is how a test observes
      # the "never in argv, never in env" rule from inside the helper instead
      # of taking this file's word for it.
      $inArgv = $false
      foreach ($argument in [Environment]::GetCommandLineArgs()) {
        if ($argument.Contains($secret)) { $inArgv = $true }
      }
      $inEnv = $false
      foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        $value = [string]$entry.Value
        if ($value -and $value.Contains($secret)) { $inEnv = $true }
      }
      [Console]::Out.WriteLine('${REPLY_MARKER}OK|' + $(if ($inArgv) { '1' } else { '0' }) + '|' + $(if ($inEnv) { '1' } else { '0' }))
    }
    default      { [Console]::Out.WriteLine('${REPLY_MARKER}ERR|${CODE_UNKNOWN_OPERATION}') }
  }
} catch {
  [Console]::Out.WriteLine('${REPLY_MARKER}ERR|${CODE_UNEXPECTED}')
}
$secret = $null
[Console]::Out.Flush()
exit 0
`
}

/**
 * The P/Invoke surface, in C#.
 *
 * `LayoutKind.Sequential` over the SDK field order makes `Marshal.SizeOf`
 * report 80 on x64 and 52 on x86.
 */
const C_SHARP = `using System;
using System.Runtime.InteropServices;
using System.Text;

namespace OplDsh.Wincred
{
    [StructLayout(LayoutKind.Sequential)]
    public struct CREDENTIAL
    {
        public UInt32 Flags;
        public UInt32 Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    public static class Native
    {
        public const UInt32 CRED_TYPE_GENERIC = 1;
        public const UInt32 CRED_PERSIST_LOCAL_MACHINE = 2;

        // CharSet.Unicode marshals managed strings as UTF-16, which is what the W
        // entry points read; without it the OS reads ANSI bytes through a wide
        // call and the operation silently stores nothing findable.
        // ExactSpelling keeps the CLR from appending its own suffix.
        [DllImport("advapi32.dll", EntryPoint = "CredReadW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredReadW(string target, UInt32 type, UInt32 reserved, out IntPtr credential);

        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredWriteW(ref CREDENTIAL credential, UInt32 flags);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredDeleteW(string target, UInt32 type, UInt32 flags);

        [DllImport("advapi32.dll", EntryPoint = "CredFree", ExactSpelling = true, SetLastError = true)]
        public static extern void CredFree(IntPtr buffer);
    }

    public static class Bridge
    {
        public static string Read(string target)
        {
            IntPtr credential;
            if (!Native.CredReadW(target, Native.CRED_TYPE_GENERIC, 0, out credential))
            {
                int code = Marshal.GetLastWin32Error();
                if (code == ${WIN32_ERROR_NOT_FOUND}) { return "OK|"; }
                return "ERR " + code.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            byte[] value = null;
            try
            {
                CREDENTIAL read = (CREDENTIAL)Marshal.PtrToStructure(credential, typeof(CREDENTIAL));
                if (read.CredentialBlobSize > 0 && read.CredentialBlob != IntPtr.Zero)
                {
                    value = new byte[read.CredentialBlobSize];
                    Marshal.Copy(read.CredentialBlob, value, 0, (int)read.CredentialBlobSize);
                }
            }
            finally
            {
                Native.CredFree(credential);
            }
            if (value == null) { return "OK|"; }
            return "OK|" + Convert.ToBase64String(value);
        }

        public static string Write(string target, string secret)
        {
            byte[] blob = Encoding.Unicode.GetBytes(secret);
            IntPtr targetName = IntPtr.Zero;
            IntPtr buffer = IntPtr.Zero;
            try
            {
                targetName = AllocateWide(target);
                buffer = Marshal.AllocHGlobal(blob.Length);
                Marshal.Copy(blob, 0, buffer, blob.Length);
                CREDENTIAL credential = new CREDENTIAL();
                credential.Flags = 0;
                credential.Type = Native.CRED_TYPE_GENERIC;
                credential.TargetName = targetName;
                credential.Comment = IntPtr.Zero;
                credential.LastWritten = new System.Runtime.InteropServices.ComTypes.FILETIME();
                credential.CredentialBlobSize = (UInt32)blob.Length;
                credential.CredentialBlob = buffer;
                credential.Persist = Native.CRED_PERSIST_LOCAL_MACHINE;
                credential.AttributeCount = 0;
                credential.Attributes = IntPtr.Zero;
                credential.TargetAlias = IntPtr.Zero;
                credential.UserName = IntPtr.Zero;
                if (!Native.CredWriteW(ref credential, 0))
                {
                    return "ERR " + Marshal.GetLastWin32Error().ToString(System.Globalization.CultureInfo.InvariantCulture);
                }
                return "OK|";
            }
            finally
            {
                if (buffer != IntPtr.Zero)
                {
                    for (int i = 0; i < blob.Length; i++) { Marshal.WriteByte(buffer, i, 0); }
                    Marshal.FreeHGlobal(buffer);
                }
                if (targetName != IntPtr.Zero) { Marshal.FreeHGlobal(targetName); }
            }
        }

        public static string Exists(string target)
        {
            IntPtr credential;
            if (!Native.CredReadW(target, Native.CRED_TYPE_GENERIC, 0, out credential))
            {
                int code = Marshal.GetLastWin32Error();
                if (code == ${WIN32_ERROR_NOT_FOUND}) { return "OK|0"; }
                return "ERR " + code.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            Native.CredFree(credential);
            return "OK|1";
        }

        public static string Delete(string target)
        {
            if (Native.CredDeleteW(target, Native.CRED_TYPE_GENERIC, 0))
            {
                return "OK|1";
            }
            int code = Marshal.GetLastWin32Error();
            if (code == ${WIN32_ERROR_NOT_FOUND})
            {
                return "OK|0";
            }
            return "ERR " + code.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        public static string StructSize()
        {
            return "OK|" + Marshal.SizeOf(typeof(CREDENTIAL)).ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        private static IntPtr AllocateWide(string value)
        {
            byte[] bytes = Encoding.Unicode.GetBytes(value);
            IntPtr block = Marshal.AllocHGlobal(bytes.Length + 2);
            Marshal.Copy(bytes, 0, block, bytes.Length);
            Marshal.WriteInt16(block, bytes.Length, 0);
            return block;
        }
    }
}`

/** One request to the helper. `secret` is base64 of the UTF-16LE bytes. */
interface BridgeRequest {
  readonly op: 'read' | 'write' | 'exists' | 'delete' | 'structsize' | 'argvscan'
  readonly target: string
  readonly secretB64?: string
}

/**
 * Environment the helper runs with: a trimmed set, not the caller's.
 *
 * It needs a working `SystemRoot` and `PATH`. A variable that holds a secret
 * in the parent is therefore not forwarded into the helper.
 */
function helperEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = [
    'ALLUSERSPROFILE',
    'APPDATA',
    'COMSPEC',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PATH',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'PUBLIC',
    'SystemDrive',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
  ]
  const result: NodeJS.ProcessEnv = {}
  for (const name of keep) {
    const value = env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

/** Base64 UTF-16LE: `-EncodedCommand`'s encoding, and the value's on the pipe. */
function toBase64Wide(text: string): string {
  return Buffer.from(text, 'utf16le').toString('base64')
}

/**
 * Replace any occurrence of the value in a diagnostic, and bound its length.
 *
 * The helper never writes the value to stderr; this keeps that true of the
 * error a caller may go on to log.
 */
function redact(secret: string | undefined, text: string): string {
  const trimmed = text.trim()
  if (secret === undefined || secret === '') return trimmed.slice(0, 400)
  return trimmed.split(secret).join('[redacted]').slice(0, 400)
}

/** What the helper said, once the marker prefix is removed. */
type Reply =
  { readonly ok: true; readonly payload: string } | { readonly ok: false; readonly code: string }

/**
 * Pull the reply out of whatever else reached the pipe.
 *
 * Scans upwards so the last marked line wins over earlier host noise.
 */
function readReply(stdout: string): Reply | undefined {
  const lines = stdout.split(/\r?\n/u)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (line?.startsWith(REPLY_MARKER) !== true) continue
    const body = line.slice(REPLY_MARKER.length)
    // The C# side answers "ERR <code>"; PowerShell's own guards answer
    // "ERR|<code>". Both are failures, so the separator is normalized here
    // rather than being a second thing every caller has to know about.
    return body.startsWith('OK|')
      ? { ok: true, payload: body.slice(3) }
      : { ok: false, code: body.replace(/^ERR[|:\s]*/u, '') }
  }
  return undefined
}

/** Map a WinCred or helper status onto the failure vocabulary. */
function failureFor(code: string): { failure: KeyringFailureCode; message: string } {
  switch (code) {
    case String(CODE_COMPILE_FAILED):
      return {
        failure: 'helper-unavailable',
        message: 'Windows Credential Manager helper could not load advapi32 P/Invoke',
      }
    case String(CODE_UNKNOWN_OPERATION):
    case String(CODE_UNEXPECTED):
      return {
        failure: 'unexpected-response',
        message: 'Windows Credential Manager helper did not answer',
      }
    case String(WIN32_ERROR_ACCESS_DENIED):
      return {
        failure: 'helper-failed',
        message: 'Windows Credential Manager refused access to this credential',
      }
    case String(WIN32_ERROR_NO_SUCH_LOGON_SESSION):
      return {
        failure: 'helper-failed',
        message: 'This logon session has no Windows credential set (WinCred error 1312)',
      }
    default:
      return {
        failure: 'helper-failed',
        message: `Windows Credential Manager refused the operation (WinCred error ${code})`,
      }
  }
}

/** Per-call knobs. Present for tests; production callers need none. */
export interface WincredBridgeOptions {
  /** Budget for one round trip. */
  readonly timeoutMs?: number
  /** Environment the helper inherits its trimmed set from. */
  readonly env?: NodeJS.ProcessEnv
}

/** Refuse a target outside {@link KEYRING_TARGET_PREFIX}. */
function assertTarget(target: string): void {
  if (typeof target !== 'string' || target === '') {
    throw new KeyringError('unavailable-target', 'A keyring target name is required')
  }
  if (target.length > MAX_KEYRING_TARGET_LENGTH) {
    throw new KeyringError(
      'unavailable-target',
      `Keyring target name exceeds ${MAX_KEYRING_TARGET_LENGTH} characters`,
    )
  }
  if (!target.startsWith(KEYRING_TARGET_PREFIX)) {
    throw new KeyringError(
      'unavailable-target',
      'Refusing to touch a credential outside the prefix this suite reserves',
    )
  }
}

/**
 * {@link assertTarget}, exported so the scope guard is testable on a host with
 * no Credential Manager.
 * @throws KeyringError when the name is not one this suite owns.
 */
export function assertKeyringTarget(target: string): void {
  assertTarget(target)
}

/**
 * @throws KeyringError `unsupported-platform` off Windows. There is no branch
 * that answers from `credentials.yml` or a `.env`.
 */
export function assertKeyringPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') {
    throw new KeyringError(
      'unsupported-platform',
      'Windows Credential Manager storage is only available on Windows',
    )
  }
}

/** Whether a host has a Windows Credential Manager at all. */
export function keyringSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/**
 * Run one operation and return the helper's payload.
 *
 * @param request - operation, target, and the base64 secret when writing.
 * @param options - timeout and environment overrides.
 * @returns the payload after `OK|`.
 */
async function invoke(request: BridgeRequest, options: WincredBridgeOptions = {}): Promise<string> {
  assertKeyringPlatform()
  assertTarget(request.target)
  const secretText = request.secretB64 === undefined ? undefined : decodeWide(request.secretB64)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const argv = ['-NoProfile', '-NonInteractive', '-EncodedCommand', toBase64Wide(helperProgram())]
  const payload = JSON.stringify(request)
  const diagnostic = await run(argv, payload, secretText, timeoutMs, options.env)
  const reply = readReply(diagnostic.stdout)
  if (reply === undefined) {
    throw new KeyringError(
      'unexpected-response',
      redact(
        secretText,
        `Windows Credential Manager helper produced no answer: ${diagnostic.stderr}`,
      ),
    )
  }
  if (reply.ok) return reply.payload
  const mapped = failureFor(reply.code)
  throw new KeyringError(
    mapped.failure,
    redact(secretText, `${mapped.message}; detail: ${reply.code}; stderr: ${diagnostic.stderr}`),
  )
}

/**
 * Spawn the helper, write the payload to its stdin, collect its pipes.
 *
 * Does not reject on a non-zero exit: the reply carries the WinCred status.
 */
function run(
  argv: readonly string[],
  payload: string,
  secret: string | undefined,
  timeoutMs: number,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', argv, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: helperEnvironment(env ?? process.env),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (): void => {
      clearTimeout(timer)
      settled = true
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(
        new KeyringError(
          'helper-unavailable',
          redact(secret, `Windows Credential Manager helper did not answer within ${timeoutMs}ms`),
        ),
      )
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (cause) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(
        new KeyringError('helper-unavailable', 'Windows PowerShell could not be started', {
          cause,
        }),
      )
    })
    child.on('close', () => {
      if (settled) return
      finish()
      resolve({ stdout, stderr })
    })
    // stdin is the only channel the secret uses; argv is a fixed program text.
    child.stdin.on('error', () => {
      /* the helper exited first; its reply, or the timeout, decides the outcome */
    })
    child.stdin.end(payload, 'utf8')
  })
}

/** Inverse of {@link toBase64Wide} for the payload side. */
function decodeWide(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf16le')
}

/** Read the credential stored under `target`. */
export async function wincredRead(
  target: string,
  options: WincredBridgeOptions = {},
): Promise<string | undefined> {
  const payload = await invoke({ op: 'read', target }, options)
  if (payload === '') return undefined
  const value = decodeWide(payload)
  return value === '' ? undefined : value
}

/** Store `secret` under `target`, replacing whatever was there. */
export async function wincredWrite(
  target: string,
  secret: string,
  options: WincredBridgeOptions = {},
): Promise<void> {
  if (typeof secret !== 'string') {
    throw new KeyringError('invalid-value', 'A keyring value must be a string')
  }
  if (secret === '') {
    throw new KeyringError(
      'empty-value',
      'An empty value cannot be stored; delete the credential instead',
    )
  }
  if (secret.includes('\0')) {
    throw new KeyringError('invalid-value', 'A keyring value cannot contain a NUL character')
  }
  const bytes = Buffer.byteLength(secret, 'utf16le')
  if (bytes > MAX_KEYRING_BLOB_BYTES) {
    throw new KeyringError(
      'value-too-large',
      `A keyring value of ${bytes} UTF-16 bytes exceeds the WinCred limit of ${MAX_KEYRING_BLOB_BYTES}`,
    )
  }
  await invoke({ op: 'write', target, secretB64: toBase64Wide(secret) }, options)
}

/** Whether a credential exists, without reading its blob. */
export async function wincredExists(
  target: string,
  options: WincredBridgeOptions = {},
): Promise<boolean> {
  const payload = await invoke({ op: 'exists', target }, options)
  return payload === '1'
}

/** Remove a credential. Removing an absent one reports `false` and is a no-op. */
export async function wincredDelete(
  target: string,
  options: WincredBridgeOptions = {},
): Promise<boolean> {
  const payload = await invoke({ op: 'delete', target }, options)
  return payload === '1'
}

/**
 * The marshalled size of `CREDENTIAL` on this host: 80 on x64, 52 on x86.
 */
export async function wincredStructSize(options: WincredBridgeOptions = {}): Promise<number> {
  const payload = await invoke(
    { op: 'structsize', target: BAMBOO_STARTLUX_KEYRING_TARGET },
    options,
  )
  return Number(payload)
}

/**
 * Ask the helper whether a value is visible in its own argv or environment.
 *
 * The value goes in on stdin; the helper reports two booleans and never the
 * value. Lets a test observe the argv/env property from inside the helper.
 * @returns whether the value was found in argv and in the environment.
 */
export async function wincredArgvScan(
  secret: string,
  options: WincredBridgeOptions = {},
): Promise<{ readonly inArgv: boolean; readonly inEnv: boolean }> {
  assertKeyringPlatform()
  const payload = await invoke(
    { op: 'argvscan', target: BAMBOO_STARTLUX_KEYRING_TARGET, secretB64: toBase64Wide(secret) },
    options,
  )
  const [argv, env] = payload.split('|')
  return { inArgv: argv === '1', inEnv: env === '1' }
}
