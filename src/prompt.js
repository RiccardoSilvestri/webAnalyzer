import { execFileSync } from 'node:child_process';
import readline from 'node:readline';

const TITLE = 'webAnalyzer';
const MESSAGE = 'Address of the site to analyze:';
const CANCELED = Symbol('canceled');

function askMac(placeholder) {
  const script = `display dialog ${JSON.stringify(MESSAGE)} default answer ${JSON.stringify(placeholder)} \
with title ${JSON.stringify(TITLE)} buttons {"Cancel", "Start"} default button "Start" cancel button "Cancel"`;
  try {
    const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const m = out.match(/text returned:(.*)$/s);
    return m ? m[1].trim() : CANCELED;
  } catch (e) {
    if (/User canceled/i.test(e.stderr ?? '')) return CANCELED;
    throw e;
  }
}

function askLinux(placeholder) {
  const backends = [
    ['zenity', ['--entry', `--title=${TITLE}`, `--text=${MESSAGE}`, `--entry-text=${placeholder}`]],
    ['kdialog', ['--title', TITLE, '--inputbox', MESSAGE, placeholder]],
  ];
  for (const [bin, args] of backends) {
    try {
      return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      if (e.status === 1) return CANCELED;
      continue;
    }
  }
  throw new Error('no graphical dialog available (install zenity or kdialog)');
}

function askWindows(placeholder) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$answer = [Microsoft.VisualBasic.Interaction]::InputBox($env:WA_MESSAGE, $env:WA_TITLE, $env:WA_DEFAULT)
if ([string]::IsNullOrEmpty($answer)) { exit 2 }
[Console]::Out.Write($answer)
`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WA_MESSAGE: MESSAGE, WA_TITLE: TITLE, WA_DEFAULT: placeholder },
    });
    const answer = out.trim();
    return answer || CANCELED;
  } catch (e) {
    if (e.status === 2) return CANCELED;
    throw e;
  }
}

function askDialog(placeholder) {
  if (process.platform === 'darwin') return askMac(placeholder);
  if (process.platform === 'win32') return askWindows(placeholder);
  return askLinux(placeholder);
}

function confirmMac(message, defaultYes) {
  const yes = 'Yes';
  const script = `display dialog ${JSON.stringify(message)} with title ${JSON.stringify(TITLE)} \
buttons {"No", ${JSON.stringify(yes)}} default button ${JSON.stringify(defaultYes ? yes : 'No')}`;
  try {
    const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return /button returned:\s*Y/i.test(out);
  } catch (e) {
    if (/User canceled/i.test(e.stderr ?? '')) return CANCELED;
    throw e;
  }
}

function confirmLinux(message, defaultYes) {
  const backends = [
    ['zenity', ['--question', `--title=${TITLE}`, `--text=${message}`, defaultYes ? '--default-cancel=false' : '--default-cancel']],
    ['kdialog', ['--title', TITLE, '--yesno', message]],
  ];
  for (const [bin, args] of backends) {
    try {
      execFileSync(bin, args.filter((a) => a !== '--default-cancel=false'), { stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch (e) {
      if (e.status === 1) return false;
      continue;
    }
  }
  throw new Error('no graphical dialog available');
}

function confirmWindows(message, defaultYes) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$default = if ($env:WA_DEFAULT -eq '1') { [System.Windows.Forms.MessageBoxDefaultButton]::Button1 } else { [System.Windows.Forms.MessageBoxDefaultButton]::Button2 }
$r = [System.Windows.Forms.MessageBox]::Show(
  $env:WA_MESSAGE, $env:WA_TITLE,
  [System.Windows.Forms.MessageBoxButtons]::YesNo,
  [System.Windows.Forms.MessageBoxIcon]::Question,
  $default)
if ($r -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 } else { exit 3 }
`;
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WA_MESSAGE: message, WA_TITLE: TITLE, WA_DEFAULT: defaultYes ? '1' : '0' },
    });
    return true;
  } catch (e) {
    if (e.status === 3) return false;
    throw e;
  }
}

function confirmDialog(message, defaultYes) {
  if (process.platform === 'darwin') return confirmMac(message, defaultYes);
  if (process.platform === 'win32') return confirmWindows(message, defaultYes);
  return confirmLinux(message, defaultYes);
}

function confirmTerminal(message, defaultYes) {
  if (!process.stdin.isTTY) return Promise.resolve(defaultYes);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [${defaultYes ? 'Y/n' : 'y/N'}] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      resolve(['y', 'yes'].includes(a));
    });
  });
}

export async function askYesNo({ message, defaultYes = true, log } = {}) {
  try {
    const answer = confirmDialog(message, defaultYes);
    if (answer === CANCELED) return null;
    if (typeof answer === 'boolean') return answer;
  } catch (e) {
    log?.debug?.(`confirmation dialog unavailable (${e.message}), falling back to the terminal`);
  }
  return confirmTerminal(message, defaultYes);
}

function askTerminal(placeholder) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${MESSAGE} `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || (placeholder.endsWith('://') ? null : placeholder));
    });
  });
}

export async function askUrl({ placeholder = 'https://', log } = {}) {
  try {
    const answer = askDialog(placeholder);
    if (answer === CANCELED) return null;
    if (typeof answer === 'string' && answer.trim()) return answer.trim();
  } catch (e) {
    log?.debug?.(`graphical dialog unavailable (${e.message}), falling back to the terminal`);
  }
  return askTerminal(placeholder);
}
