import { describe, it, expect } from 'vitest'

import { parseWindowsNetstat, parseLsof, parseProcNetTcp } from '../ports.js'
import { normaliseOrigin } from '../detector.js'

describe('parseWindowsNetstat', () => {
  it('extracts loopback LISTENING ports and ignores established rows', () => {
    const sample = [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:62724        127.0.0.1:51234        ESTABLISHED     80808',
      '  TCP    127.0.0.1:7777         0.0.0.0:0              LISTENING       1234',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900',
      '  TCP    [::1]:7331             [::]:0                 LISTENING       5555',
    ].join('\r\n')

    expect(parseWindowsNetstat(sample)).toEqual([135, 7331, 7777])
  })

  it('returns an empty list when nothing is listening', () => {
    expect(parseWindowsNetstat('  TCP    127.0.0.1:1  127.0.0.1:2  ESTABLISHED  1')).toEqual([])
  })
})

describe('parseLsof', () => {
  it('extracts ports from LISTEN rows', () => {
    const sample = [
      'COMMAND   PID USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME',
      'node    1234 user   23u  IPv4  0x1234  0t0  TCP 127.0.0.1:7777 (LISTEN)',
      'node    1234 user   24u  IPv6  0x1235  0t0  TCP [::1]:62724 (LISTEN)',
      'node    1234 user   25u  IPv4  0x1236  0t0  TCP 127.0.0.1:51234->127.0.0.1:9 (ESTABLISHED)',
    ].join('\n')

    expect(parseLsof(sample)).toEqual([7777, 62724])
  })
})

describe('parseProcNetTcp', () => {
  it('decodes hex ports in LISTEN state only', () => {
    // 0x1E61 = 7777, 0xF504 = 62724, 0x1CA3 = 7331, 0x1F90 = 8080
    const sample = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1E61 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0',
      '   1: 0100007F:F504 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1 0',
      '   2: 0100007F:1CA3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1 0',
      '   3: 0100007F:1F90 0100007F:1E61 01 00000000:00000000 00:00000000 00000000  1000        0 4 1 0',
    ].join('\n')

    expect(parseProcNetTcp(sample)).toEqual([7331, 7777, 62724])
  })
})

describe('normaliseOrigin', () => {
  it('accepts a full URL and keeps protocol + host', () => {
    expect(normaliseOrigin('http://127.0.0.1:62724/')).toBe('http://127.0.0.1:62724')
    expect(normaliseOrigin('https://example.com')).toBe('https://example.com')
  })

  it('accepts host:port without a scheme', () => {
    expect(normaliseOrigin('localhost:8080')).toBe('http://localhost:8080')
  })

  it('accepts a bare port', () => {
    expect(normaliseOrigin('7777')).toBe('http://127.0.0.1:7777')
  })

  it('rejects empty and nonsense input', () => {
    expect(normaliseOrigin('')).toBeNull()
    expect(normaliseOrigin('   ')).toBeNull()
    expect(normaliseOrigin('not a url')).toBeNull()
  })
})
