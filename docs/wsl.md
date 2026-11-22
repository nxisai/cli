# nxis on Windows, with WSL

On Windows, nxis runs inside WSL (the Windows Subsystem for Linux): it is the Linux build, and it
opens sign-in and payment pages in your Windows browser. This page sets it up and checks each part.
With Node.js 20 or later on Windows itself, `npm i -g @nxisai/cli` works too, without WSL.

## 1. WSL

In **PowerShell**:

```powershell
wsl --install        # once; restart if asked
wsl -l -v            # VERSION should be 2
```

Then open **Ubuntu** from the Start menu and create your Linux user when it asks.

## 2. Install nxis

In the **Ubuntu** terminal:

```bash
sudo apt update && sudo apt install -y curl ca-certificates
curl -fsSL https://github.com/nxisai/cli/releases/latest/download/install.sh | sh
exec $SHELL -l       # or open a new terminal, so the PATH change applies
nxis --version
```

Work in the Linux file system (`~`), not under `/mnt/c`, which is much slower.

## 3. Check it works

Write down what you see for each one; the expected result follows each.

### 3.1 The installer stops in Git Bash

In **Git Bash** (from Git for Windows), not WSL:

```bash
curl -fsSL https://github.com/nxisai/cli/releases/latest/download/install.sh | sh; echo "exit $?"
```

Expected: `nxis install: on Windows, install nxis inside WSL:` with the steps above, exit 1, and
nothing downloaded besides the script.

### 3.2 Sign-in opens the Windows browser

```bash
nxis login --web
```

Expected: the sign-in page opens in your **Windows** default browser, and the terminal says you are
signed in once you finish there. nxis opens links with `wslview` when `wslu` is installed, else
PowerShell's `Start-Process`, else `rundll32`. If none works, it prints the link to open yourself.
`nxis login` (no `--web`) prints a code to enter at a URL instead, which works without a browser.

### 3.3 Where the sign-in is stored

```bash
nxis status
ls -l ~/.config/nxis
```

Expected: signed in. WSL usually has no Linux keyring (`secret-tool`), so the sign-in is in a file
in `~/.config/nxis` readable only by you (mode 600). With `libsecret-tools` and a running keyring,
it goes to the keyring instead.

### 3.4 Your coding agent starts `nxis mcp serve`

Install the agent inside WSL as well, since it has to run `nxis` (Claude Code, for example):

```bash
curl -fsSL https://claude.ai/install.sh | bash
nxis mcp install
nxis mcp install --print       # what it wrote
```

Expected: the entry's command is `~/.local/bin/nxis` (the installer's launcher, which survives
updates), with `mcp serve`. Start the agent and ask it to list your NxisAI sites.

### 3.5 Updating

```bash
nxis update --check
nxis update
```

Expected: `--check` says whether a newer version is out; `nxis update` installs it, or says this is
the latest.

## 4. If something is off

Send what you saw for each step, the output of `nxis --version` and `nxis status --json`, your
Windows version (`winver`) and `wsl --version` from PowerShell, through an issue at
[nxisai/cli](https://github.com/nxisai/cli/issues).

## 5. Uninstall

```bash
nxis logout
rm -rf ~/.nxis ~/.local/bin/nxis ~/.config/nxis
```

and remove the `# nxis` PATH line from `~/.bashrc` (or your shell's startup file).
