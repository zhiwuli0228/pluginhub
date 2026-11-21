import { describe, it, expect, beforeEach } from 'vitest'
import { A2AHttpClient } from '../http-client.js'
import type { Task, TaskV11, SendTaskOptions, SendTaskResult } from '../types.js'

/**
 * A2A V11 API surface tests.
 *
 * These tests verify that the V11 types and methods exist with correct shapes.
 * They do NOT make real HTTP calls — they validate the type system and method signatures.
 */
describe('A2A V11 API', () => {
  // -----------------------------------------------------------------------
  // Type compatibility checks (compile-time + runtime shape)
  // -----------------------------------------------------------------------
  describe('TaskV11 type', () => {
    it('TaskV11 is compatible with Task (has all Task fields)', () => {
      const taskV11: TaskV11 = {
        id: 'task-1',
        status: { state: 'COMPLETED' },
        generation: 5,
      }
      // TaskV11 should be assignable to Task
      const task: Task = taskV11
      expect(task.id).toBe('task-1')
      expect(task.status.state).toBe('COMPLETED')
    })

    it('TaskV11 has optional generation field', () => {
      const withGen: TaskV11 = { id: 't1', status: { state: 'WORKING' }, generation: 3 }
      expect(withGen.generation).toBe(3)

      const withoutGen: TaskV11 = { id: 't2', status: { state: 'SUBMITTED' } }
      expect(withoutGen.generation).toBeUndefined()
    })
  })

  describe('SendTaskOptions type', () => {
    it('has expectedGeneration field', () => {
      const opts: SendTaskOptions = { expectedGeneration: 42 }
      expect(opts.expectedGeneration).toBe(42)
    })

    it('has live field', () => {
      const opts: SendTaskOptions = { live: true }
      expect(opts.live).toBe(true)
    })

    it('both fields are optional', () => {
      const opts: SendTaskOptions = {}
      expect(opts.expectedGeneration).toBeUndefined()
      expect(opts.live).toBeUndefined()
    })
  })

  describe('SendTaskResult type', () => {
    it('has task field', () => {
      const result: SendTaskResult = {
        task: { id: 't1', status: { state: 'COMPLETED' } },
      }
      expect(result.task.id).toBe('t1')
    })

    it('has optional generation field', () => {
      const withGen: SendTaskResult = {
        task: { id: 't1', status: { state: 'COMPLETED' } },
        generation: 7,
      }
      expect(withGen.generation).toBe(7)

      const withoutGen: SendTaskResult = {
        task: { id: 't2', status: { state: 'WORKING' } },
      }
      expect(withoutGen.generation).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // A2AHttpClient method existence
  // -----------------------------------------------------------------------
  describe('A2AHttpClient V11 methods', () => {
    let client: A2AHttpClient

    // Create a client instance (won't make real calls)
    beforeEach(() => {
      client = new A2AHttpClient({ baseUrl: 'https://agent.example.com' })
    })

    it('has sendTaskV11 method', () => {
      expect(typeof client.sendTaskV11).toBe('function')
    })

    it('has sendLiveMessage method', () => {
      expect(typeof client.sendLiveMessage).toBe('function')
    })

    it('has getTaskV11 method', () => {
      expect(typeof client.getTaskV11).toBe('function')
    })

    it('sendTaskV11 accepts params and options arguments', () => {
      // Verify the method signature accepts two arguments
      expect(client.sendTaskV11.length).toBeGreaterThanOrEqual(1)
    })

    it('sendLiveMessage accepts params argument', () => {
      expect(client.sendLiveMessage.length).toBeGreaterThanOrEqual(1)
    })

    it('getTaskV11 accepts taskId argument', () => {
      expect(client.getTaskV11.length).toBeGreaterThanOrEqual(1)
    })
  })

  // -----------------------------------------------------------------------
  // Legacy methods still present
  // -----------------------------------------------------------------------
  describe('A2AHttpClient legacy methods preserved', () => {
    let client: A2AHttpClient

    beforeEach(() => {
      client = new A2AHttpClient({ baseUrl: 'https://agent.example.com' })
    })

    it('has getAgentCard method', () => {
      expect(typeof client.getAgentCard).toBe('function')
    })

    it('has sendTask method', () => {
      expect(typeof client.sendTask).toBe('function')
    })

    it('has getTask method', () => {
      expect(typeof client.getTask).toBe('function')
    })

    it('has cancelTask method', () => {
      expect(typeof client.cancelTask).toBe('function')
    })

    it('has sendMessage method', () => {
      expect(typeof client.sendMessage).toBe('function')
    })
  })
})
