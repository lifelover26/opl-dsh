/** Copy only system environment; credentials enter only the selected adapter. */
export function systemEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'OPL_GIT_BASH_PATH',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TERM',
    'SHELL',
    'USER',
    'LOGNAME',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    // Keep the official MiniMax Code CLI on the same data directory the suite
    // inspected for its own account credential, so login state cannot disagree.
    'MINIMAX_DATA_DIR',
    'MAVIS_DATA_DIR',
  ])
    if (process.env[name]) env[name] = process.env[name]
  return env
}
