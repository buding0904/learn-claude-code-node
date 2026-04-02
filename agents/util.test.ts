import { describe, expect, test } from 'bun:test'
import { safePath } from './util'

describe('safePath', () => {
  const cwd = '/home/user/project'

  test('same directory returns cwd', () => {
    expect(safePath(cwd, '.')).toBe('/home/user/project')
  })

  test('subdirectory returns resolved path', () => {
    expect(safePath(cwd, 'src/index.ts')).toBe('/home/user/project/src/index.ts')
  })

  test('deeply nested path returns resolved path', () => {
    expect(safePath(cwd, 'a/b/c/d.txt')).toBe('/home/user/project/a/b/c/d.txt')
  })

  test('path that resolves back inside cwd returns resolved path', () => {
    expect(safePath(cwd, 'src/../lib')).toBe('/home/user/project/lib')
  })

  test('absolute path inside cwd returns the path', () => {
    expect(safePath(cwd, '/home/user/project/src')).toBe('/home/user/project/src')
  })

  test('parent directory traversal throws', () => {
    expect(() => safePath(cwd, '../secret')).toThrow()
  })

  test('absolute path outside cwd throws', () => {
    expect(() => safePath(cwd, '/etc/passwd')).toThrow()
  })

  test('path that escapes via normalization throws', () => {
    expect(() => safePath(cwd, 'src/../../other')).toThrow()
  })
})
