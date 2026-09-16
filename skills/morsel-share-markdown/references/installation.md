# Install uv

This guide is based on the [official uv installation documentation](https://docs.astral.sh/uv/getting-started/installation/).

## Check for an existing installation

Run:

```sh
uv --version
```

If the command prints a version, uv is already installed.

## macOS and Linux

The recommended standalone installer uses `curl`:

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Use `wget` instead when `curl` is unavailable:

```sh
wget -qO- https://astral.sh/uv/install.sh | sh
```

Homebrew is also supported:

```sh
brew install uv
```

## Windows

Run the standalone installer in PowerShell:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

WinGet is also supported:

```powershell
winget install --id=astral-sh.uv -e
```

## Install from PyPI

The uv documentation recommends `pipx` for an isolated installation:

```sh
pipx install uv
```

A regular `pip` installation also works:

```sh
pip install uv
```

If no prebuilt wheel is available for the platform, installation from PyPI builds uv from source and requires a Rust toolchain.

## Verify the installation

Open a new terminal after installation and run:

```sh
uv --version
```

If the command is still unavailable, follow the installer's instructions to add the uv installation directory to `PATH`, then open a new terminal and try again.

A standalone installation can update itself with:

```sh
uv self update
```

For package-manager installations, use that package manager's upgrade command instead.
