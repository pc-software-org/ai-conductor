import { createInterface } from 'node:readline';
import type { KeychainBackend } from '../secrets/keychain.js';

export interface SecretIo {
  readSecret(): Promise<string>;
  out(msg: string): void;
}

const USAGE = 'usage: mcp-proxy-conductor secret <set|rm> <name>';

// Returns a process exit code. Never logs the secret value.
export async function runSecretCommand(args: string[], backend: KeychainBackend, io: SecretIo): Promise<number> {
  const [sub, name] = args;

  if (sub === 'set') {
    if (!name) {
      io.out(USAGE);
      return 1;
    }
    const value = await io.readSecret();
    if (!value) {
      io.out('aborted: empty value, nothing stored');
      return 1;
    }
    backend.set(name, value);
    io.out(`stored secret '${name}' in the OS keychain.`);
    return 0;
  }

  if (sub === 'rm') {
    if (!name) {
      io.out(USAGE);
      return 1;
    }
    const existed = backend.delete(name);
    io.out(existed ? `removed secret '${name}'.` : `no secret '${name}' found.`);
    return 0;
  }

  io.out(USAGE);
  return 1;
}

// Read a secret without echoing it to the terminal. Used for the real CLI wiring.
export function promptHidden(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let promptWritten = false;
    // Mute keystroke echo: write the prompt once, then swallow what readline would echo.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rl as any)._writeToOutput = () => {
      if (!promptWritten) {
        process.stdout.write(promptText);
        promptWritten = true;
      }
    };
    rl.question(promptText, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// Read all of a piped (non-TTY) stdin as the secret value (enables scripting).
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
