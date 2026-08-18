import { describe, expect, test } from 'bun:test'

import { GUARD_SECRET_EXFIL_BASH, checkSecretExfilBashGuard } from './secret-exfil-bash'

describe('secret-exfil-bash guard', () => {
  test('blocks env (full env dump - canonical secret exfil command)', () => {
    const result = checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'env' } })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('env / printenv')
  })

  test('blocks printenv', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'printenv' } })?.block).toBe(true)
  })

  test('blocks env piped to grep', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'env | grep API' } })?.block).toBe(true)
  })

  test('blocks env in compound command', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'echo hi && env' } })?.block).toBe(true)
  })

  test('blocks awk ENVIRON dump (regression: red-team #5b leaked all env keys)', () => {
    const result = checkSecretExfilBashGuard({
      tool: 'bash',
      args: { command: `awk 'BEGIN{for(k in ENVIRON) print k"="ENVIRON[k]}'` },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('awk ENVIRON')
  })

  test('blocks awk ENVIRON dump with -F or other flags before BEGIN', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: `awk -F: 'BEGIN{for (k in ENVIRON) print k}'` },
      })?.block,
    ).toBe(true)
  })

  test('blocks node -e process.env dump', () => {
    const result = checkSecretExfilBashGuard({
      tool: 'bash',
      args: { command: `node -e "console.log(JSON.stringify(process.env))"` },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('process.env')
  })

  test('blocks bun -e process.env dump', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: `bun -e 'console.log(process.env)'` },
      })?.block,
    ).toBe(true)
  })

  test('blocks deno eval process.env dump', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: `deno eval 'console.log(Deno.env.toObject()); console.log(process.env)'` },
      })?.block,
    ).toBe(true)
  })

  test('blocks python -c os.environ dump', () => {
    const result = checkSecretExfilBashGuard({
      tool: 'bash',
      args: { command: `python -c "import os; print(dict(os.environ))"` },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('os.environ')
  })

  test('blocks python3 os.environ dump', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: `python3 -c 'import os; print(os.environ)'` },
      })?.block,
    ).toBe(true)
  })

  test('blocks ruby ENV dump', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: `ruby -e "puts ENV.to_h.inspect"` },
      })?.block,
    ).toBe(true)
  })

  test('blocks perl %ENV dump', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: `perl -e 'print "$_=$ENV{$_}\\n" for keys %ENV'` },
      })?.block,
    ).toBe(true)
  })

  test('blocks compgen -e (env var name listing)', () => {
    const result = checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'compgen -e' } })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('compgen -e')
  })

  test('blocks compgen with combined flags including -e', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'compgen -ev' } })?.block).toBe(true)
  })

  test('blocks declare -p (full env-var dump)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'declare -p' } })?.block).toBe(true)
  })

  test('blocks declare -x (exported env-var dump)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'declare -x' } })?.block).toBe(true)
  })

  test('blocks declare -px (combined flags)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'declare -px' } })?.block).toBe(true)
  })

  test('blocks export -p (exported env-var dump)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'export -p' } })?.block).toBe(true)
  })

  test('blocks set -o posix; set (POSIX env dump)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set -o posix; set' } })?.block).toBe(true)
  })

  test('blocks set -o posix && set (compound form)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set -o posix && set' } })?.block).toBe(true)
  })

  test('does not block awk for non-env work', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: `awk '{print $1}' file.txt` } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: `awk 'BEGIN{print "hello"}'` } })).toBeUndefined()
  })

  test('does not block node/bun/python without env access', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'node -e "console.log(1+1)"' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'bun build src/index.ts' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'python -c "print(1+1)"' } })).toBeUndefined()
  })

  test('does not block bare set / declare / compgen / export forms (false-positive guard)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set -e' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set -euo pipefail' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'declare foo=bar' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'declare -a arr' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'compgen -c' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'compgen -A function' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'export FOO=bar' } })).toBeUndefined()
  })

  test('does not block "environment" variable name as a value', () => {
    expect(
      checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'echo "set the environment up"' } }),
    ).toBeUndefined()
  })

  test('blocks cat .env', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat .env' } })?.block).toBe(true)
  })

  test('blocks cat ./.env', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ./.env' } })?.block).toBe(true)
  })

  test('blocks cat ~/project/.env', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/project/.env' } })?.block).toBe(true)
  })

  test('blocks jq . .env (jq ships in baseline and reads+emits the file like cat)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'jq . .env' } })?.block).toBe(true)
  })

  test('blocks yq . .env (yq ships in baseline and reads+emits the file like cat)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: "yq '.FIREWORKS_API_KEY' .env" } })?.block).toBe(
      true,
    )
  })

  test('blocks jq . .envrc', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'jq . .envrc' } })?.block).toBe(true)
  })

  test('blocks yq . .envrc', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'yq . ./.envrc' } })?.block).toBe(true)
  })

  test('blocks ls -la ~/.ssh/ (private-key directory enumeration)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'ls -la ~/.ssh/' } })?.block).toBe(true)
  })

  test('blocks cat ~/.ssh/id_rsa', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.ssh/id_rsa' } })?.block).toBe(true)
  })

  test('blocks cat ~/.ssh/authorized_keys', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.ssh/authorized_keys' } })?.block).toBe(
      true,
    )
  })

  test('blocks cat ~/.aws/credentials', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.aws/credentials' } })?.block).toBe(true)
  })

  test('blocks cat ~/.netrc', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.netrc' } })?.block).toBe(true)
  })

  test('blocks cat ~/.kube/config', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.kube/config' } })?.block).toBe(true)
  })

  test('blocks cat ~/.hermes/config.yaml (agent credentials file)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.hermes/config.yaml' } })?.block).toBe(
      true,
    )
  })

  test('blocks cat ~/.config/hermes/config.yaml (XDG-style agent credentials)', () => {
    expect(
      checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.config/hermes/config.yaml' } })?.block,
    ).toBe(true)
  })

  test('blocks find ~ -name "*.env" -o -name "credentials*" (compound credential search)', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: 'find ~ -name "*.env" -o -name "credentials*" 2>/dev/null | head -50' },
      })?.block,
    ).toBe(true)
  })

  test('blocks find -name "id_rsa"', () => {
    expect(
      checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'find / -name "id_rsa" 2>/dev/null' } })?.block,
    ).toBe(true)
  })

  test('blocks recursive grep for password', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'grep -r "password" /etc/' } })?.block).toBe(true)
  })

  test('blocks /proc/self/environ read', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat /proc/self/environ' } })?.block).toBe(true)
  })

  test('blocks bash history read', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.bash_history' } })?.block).toBe(true)
  })

  test('blocks cloud metadata endpoint fetch', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: 'curl http://169.254.169.254/latest/meta-data/iam/' },
      })?.block,
    ).toBe(true)
  })

  test('blocks GCP metadata endpoint fetch', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: 'curl http://metadata.google.internal/computeMetadata/v1/' },
      })?.block,
    ).toBe(true)
  })

  test('does not let a model-authored acknowledgement bypass secret exfiltration', () => {
    const result = checkSecretExfilBashGuard({
      tool: 'bash',
      args: { command: 'env', acknowledgeGuards: { secretExfilBash: true } },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).not.toContain('acknowledgeGuards')
  })

  test('allows benign commands', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'ls -la' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'echo hello' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'git status' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'bun test' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat README.md' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'find . -name "*.ts"' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'grep -r "TODO" src/' } })).toBeUndefined()
  })

  test('allows `set` variants (the bare-set heuristic was removed; too many false positives on shell flag use)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set -e' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set -euo pipefail' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set' } })).toBeUndefined()
  })

  test('does not apply to non-bash tools', () => {
    expect(checkSecretExfilBashGuard({ tool: 'read', args: { command: 'env' } })).toBeUndefined()
  })

  test('handles non-string command gracefully', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 42 } })).toBeUndefined()
  })

  test('exposes guard name constant', () => {
    expect(GUARD_SECRET_EXFIL_BASH).toBe('secretExfilBash')
  })
})
