import { closeSync, openSync, readSync, writeSync } from 'node:fs'

export type Key =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'enter' }
  | { kind: 'cancel' }
  | { kind: 'char'; value: string }
  | { kind: 'backspace' }

export type KeyReader = () => Promise<Key | null>

export type SelectOption<T> = { label: string; value: T }

/** Arrow-key list picker. Returns null when cancelled or the list is empty. */
export async function select<T>(
  title: string,
  options: readonly SelectOption<T>[],
  read: KeyReader,
  write: (s: string) => void,
): Promise<T | null> {
  if (options.length === 0) return null
  let index = 0
  const n = options.length
  const redraw = (first: boolean) => {
    if (!first) write(`\x1b[${n}A`)
    write(`\r${title}\n`)
    for (const [i, o] of options.entries()) {
      write(`\x1b[2K${i === index ? '>' : ' '} ${o.label}\n`)
    }
  }
  redraw(true)
  for (;;) {
    const key = await read()
    if (key === null) {
      write('\n')
      return null
    }
    switch (key.kind) {
      case 'up':
        index = index === 0 ? n - 1 : index - 1
        break
      case 'down':
        index = (index + 1) % n
        break
      case 'enter':
        write('\n')
        return options[index]?.value ?? null
      case 'cancel':
        write('\n')
        return null
      default:
        continue
    }
    redraw(false)
  }
}

/** Single-line text input. Returns null when cancelled, '' is a valid answer. */
export async function input(
  prompt: string,
  read: KeyReader,
  write: (s: string) => void,
): Promise<string | null> {
  write(prompt)
  let value = ''
  for (;;) {
    const key = await read()
    if (key === null) {
      write('\n')
      return value
    }
    switch (key.kind) {
      case 'char':
        value += key.value
        write(key.value)
        break
      case 'backspace':
        if (value.length > 0) {
          value = value.slice(0, -1)
          write('\b \b')
        }
        break
      case 'enter':
        write('\n')
        return value
      case 'cancel':
        write('\n')
        return null
      default:
        break
    }
  }
}

function readByte(fd: number): number {
  const buf = new Uint8Array(1)
  return readSync(fd, buf, 0, 1, null) > 0 ? (buf[0] ?? -1) : -1
}

/** Reads /dev/tty one key at a time; arrow sequences are decoded, lone Esc cancels. */
export function ttyKeyReader(fd: number): KeyReader {
  return () => {
    const b = readByte(fd)
    if (b < 0) return Promise.resolve(null)
    if (b === 0x1b) {
      const b2 = readByte(fd)
      if (b2 === 0x5b) {
        const b3 = readByte(fd)
        if (b3 === 0x41) return Promise.resolve({ kind: 'up' })
        if (b3 === 0x42) return Promise.resolve({ kind: 'down' })
        return Promise.resolve({ kind: 'cancel' })
      }
      return Promise.resolve({ kind: 'cancel' })
    }
    if (b === 0x03 || b === 0x04) return Promise.resolve({ kind: 'cancel' })
    if (b === 0x0d || b === 0x0a) return Promise.resolve({ kind: 'enter' })
    if (b === 0x7f || b === 0x08) return Promise.resolve({ kind: 'backspace' })
    return Promise.resolve({ kind: 'char', value: String.fromCharCode(b) })
  }
}

export type Tty = {
  fd: number
  read: KeyReader
  write: (s: string) => void
  close: () => void
}

/**
 * Opens /dev/tty in raw mode (`min 1 time 1` so a lone Esc read returns after
 * 100ms instead of blocking). Returns null when there is no controlling
 * terminal, which the caller treats as "not interactive".
 */
export function openTty(): Tty | null {
  let fd = -1
  try {
    fd = openSync('/dev/tty', 'r+')
  } catch {
    return null
  }
  const saved = Bun.spawnSync(['stty', '-g'], { stdin: fd, stdout: 'pipe' })
    .stdout.toString()
    .trim()
  const raw = Bun.spawnSync(['stty', 'raw', '-echo', 'min', '1', 'time', '1'], {
    stdin: fd,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (saved === '' || raw.exitCode !== 0) {
    closeSync(fd)
    return null
  }
  return {
    fd,
    read: ttyKeyReader(fd),
    write: (s: string) => writeSync(fd, s),
    close: () => {
      try {
        Bun.spawnSync(['stty', saved], { stdin: fd, stdout: 'inherit', stderr: 'inherit' })
      } catch {
        // terminal already gone; nothing to restore
      }
      closeSync(fd)
    },
  }
}
