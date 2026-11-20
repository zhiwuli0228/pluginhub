import { describe, it, expect, beforeEach } from 'vitest'
import { PermissionSolver } from '../permission-solver.js'
import type { Permission } from '../types.js'

describe('PermissionSolver', () => {
  let solver: PermissionSolver

  beforeEach(() => {
    solver = new PermissionSolver()
  })

  // ── Default deny ──

  describe('default deny', () => {
    it('ungranted permissions end up in denied list after solve', () => {
      const requested: Permission[] = [
        { id: 'fs.read.workspace' },
        { id: 'net.egress' },
      ]
      const result = solver.solve(requested)
      expect(result.granted).toHaveLength(0)
      expect(result.denied).toHaveLength(2)
      expect(result.unresolved).toHaveLength(0)
      expect(result.denied.map((p) => p.id)).toEqual(['fs.read.workspace', 'net.egress'])
    })
  })

  // ── grant / isGranted ──

  describe('grant and isGranted', () => {
    it('isGranted returns true after grant', () => {
      solver.grant('fs.read.workspace', 'user')
      expect(solver.isGranted('fs.read.workspace')).toBe(true)
    })

    it('isGranted returns false for never-granted permission', () => {
      expect(solver.isGranted('exec')).toBe(false)
    })
  })

  // ── revoke ──

  describe('revoke', () => {
    it('isGranted returns false after revoke', () => {
      solver.grant('exec', 'user')
      expect(solver.isGranted('exec')).toBe(true)
      solver.revoke('exec')
      expect(solver.isGranted('exec')).toBe(false)
    })

    it('revoke on non-existent permission is a no-op', () => {
      expect(() => solver.revoke('nonexistent')).not.toThrow()
    })
  })

  // ── solve mixed ──

  describe('solve with mixed granted/denied', () => {
    it('correctly classifies granted and denied permissions', () => {
      solver.grant('fs.read.workspace', 'user')
      solver.grant('net.egress', 'policy')

      const requested: Permission[] = [
        { id: 'fs.read.workspace' },
        { id: 'net.egress' },
        { id: 'exec' },
        { id: 'secrets.read' },
      ]

      const result = solver.solve(requested)
      expect(result.granted).toHaveLength(2)
      expect(result.denied).toHaveLength(2)
      expect(result.granted.map((p) => p.id)).toContain('fs.read.workspace')
      expect(result.granted.map((p) => p.id)).toContain('net.egress')
      expect(result.denied.map((p) => p.id)).toContain('exec')
      expect(result.denied.map((p) => p.id)).toContain('secrets.read')
    })
  })

  // ── purgeExpired ──

  describe('purgeExpired', () => {
    it('removes expired grants', () => {
      const pastDate = new Date(Date.now() - 10_000) // 10 seconds ago
      const futureDate = new Date(Date.now() + 60_000) // 1 minute from now

      solver.grant('expired-perm', 'user', pastDate)
      solver.grant('active-perm', 'user', futureDate)
      solver.grant('no-expiry-perm', 'user')

      const purged = solver.purgeExpired()
      expect(purged).toBe(1)

      expect(solver.isGranted('expired-perm')).toBe(false)
      expect(solver.isGranted('active-perm')).toBe(true)
      expect(solver.isGranted('no-expiry-perm')).toBe(true)
    })

    it('returns 0 when no grants are expired', () => {
      solver.grant('active', 'user', new Date(Date.now() + 60_000))
      expect(solver.purgeExpired()).toBe(0)
    })
  })

  // ── listGrants ──

  describe('listGrants', () => {
    it('returns all active grants', () => {
      solver.grant('perm-a', 'user')
      solver.grant('perm-b', 'policy')

      const grants = solver.listGrants()
      expect(grants).toHaveLength(2)
      expect(grants.map((g) => g.permissionId).sort()).toEqual(['perm-a', 'perm-b'])
    })

    it('returns empty array when no grants exist', () => {
      expect(solver.listGrants()).toHaveLength(0)
    })

    it('includes expired grants (until purged)', () => {
      const pastDate = new Date(Date.now() - 10_000)
      solver.grant('expired', 'user', pastDate)
      solver.grant('active', 'user')

      const grants = solver.listGrants()
      expect(grants).toHaveLength(2)
    })
  })

  // ── Expiry lazy cleanup ──

  describe('lazy expiry on isGranted', () => {
    it('isGranted returns false for expired grant and removes it', () => {
      const pastDate = new Date(Date.now() - 10_000)
      solver.grant('old-perm', 'user', pastDate)

      expect(solver.isGranted('old-perm')).toBe(false)
      // After lazy cleanup, the grant should be removed
      expect(solver.listGrants()).toHaveLength(0)
    })
  })
})
